/**
 * Sol — the delivery loop (v1.2 §6).
 *
 *   discover → plan → build → evaluate → repair/escalate → publish
 *
 * Models provide intelligence; the harness provides authority.
 *
 * Sol reasons and recommends — it plans, it chooses an execution strategy, and
 * it adjudicates failed evaluations. It never edits a file, spends a budget,
 * grants a permission or releases anything. Project state, artifact
 * persistence, budgets, permissions, validation, authorisation and deployment
 * belong to this module and the packages it calls, and a model decision only
 * takes effect once the harness has authorised it.
 */
import {
  BusinessProfile,
  intakeGaps,
  type AgentTier,
  type TerminalOutcome,
} from '@statxai/contracts';
import {
  ModelClient,
  repairDefect,
  type UsageByTier,
} from '@statxai/agents';
import { BudgetExhausted, createBudget, spend, spendRepairAttempt, type StateStore } from '@statxai/state';
import {
  ArtifactRegistry,
  ProjectWorkspace,
} from '@statxai/workspace';
import {
  decideTerminal,
  isReleaseBlocked,
  terminalForRefusal,
  type ReleaseAuthorization,
  type ReplanScope,
} from '@statxai/policy-engine';
import { concluded, withoutDelivery, type RunResult } from './phases/conclude.js';
import { buildFromPlan } from './phases/build.js';
import { adjudicateDefects } from './phases/adjudicate.js';
import { evaluateSite } from './phases/evaluate.js';
import { producePlan, revisePlan } from './phases/planning.js';
import { publishRelease } from './phases/publish.js';
import { seekRelease } from './phases/release.js';
import type { Progress, RunContext, RunDeps, RunFacts, RunProgress } from './run-context.js';

export type { RunResult } from './phases/conclude.js';
export type { Progress } from './run-context.js';
import {
  blocking,
  filesForDefect,
  REPAIR_COMPANIONS,
  type Defect,
} from './defects.js';


export interface RunOptions {
  projectId: string;
  intake: unknown;
  store: StateStore;
  workspacesRoot: string;
  autonomyMode?: 'full_autonomous' | 'supervised_autonomous' | 'human_in_the_loop';
  onProgress?: Progress;
}

export async function runProject(options: RunOptions): Promise<RunResult> {
  const { projectId, store, workspacesRoot } = options;
  const autonomyMode = options.autonomyMode ?? 'full_autonomous';
  const report: Progress = options.onProgress ?? (() => {});
  const say: Progress = (event) => {
    chargePhase(event.phase);
    report(event);
  };

  const model = new ModelClient();
  const registry = new ArtifactRegistry(store);
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  /**
   * Usage split by tier, because that is the only split that can be priced:
   * Sol, Terra and Luna map to different models and therefore different rates.
   */
  const usageByTier: UsageByTier = {};
  const track = (tier: AgentTier, r: { inputTokens: number; outputTokens: number; ms: number }) => {
    usage.inputTokens += r.inputTokens;
    usage.outputTokens += r.outputTokens;
    usage.calls += 1;

    const bucket = (usageByTier[tier] ??= { inputTokens: 0, outputTokens: 0, calls: 0, ms: 0 });
    bucket.inputTokens += r.inputTokens;
    bucket.outputTokens += r.outputTokens;
    bucket.calls += 1;
    bucket.ms += r.ms;
  };

  /**
   * Wall-clock per phase, charged by the progress events themselves.
   *
   * Derived here rather than in the console: the timeline records when a phase
   * *reported*, and the gap before the first event of a phase belongs to the
   * phase that was still running. Attributing it after the fact from timestamps
   * alone gets the boundaries wrong.
   */
  const phaseMs: Record<string, number> = {};
  let phaseStarted = Date.now();
  let currentPhase: string | null = null;
  const chargePhase = (next: string) => {
    const now = Date.now();
    if (currentPhase) phaseMs[currentPhase] = (phaseMs[currentPhase] ?? 0) + (now - phaseStarted);
    currentPhase = next;
    phaseStarted = now;
  };

  // -- Phase 1: Discover ----------------------------------------------------
  say({ phase: 'discover', detail: 'Validating intake against the canonical schema' });

  const parsed = BusinessProfile.safeParse(options.intake);
  if (!parsed.success) {
    say({ phase: 'discover', detail: `Intake rejected: ${parsed.error.issues[0]?.message}`, level: 'fail' });
    return withoutDelivery(projectId, 'intake_insufficient', { usage, usageByTier, phaseMs });
  }
  const profile = parsed.data;

  // Thin intake would force the builder to invent facts, which the content gate
  // then rejects forever. Catch it before spending a single token.
  const gaps = intakeGaps(profile);
  if (gaps.length > 0) {
    say({ phase: 'discover', detail: `Intake insufficient: ${gaps.join('; ')}`, level: 'fail' });
    return withoutDelivery(projectId, 'intake_insufficient', { usage, usageByTier, phaseMs });
  }
  say({ phase: 'discover', detail: `${profile.businessName} — ${profile.services.length} services`, level: 'ok' });

  const workspace = await ProjectWorkspace.open(projectId, workspacesRoot);

  await store.projects.deleteOne({ _id: projectId });
  await store.budgets.deleteOne({ _id: projectId });
  await store.defectBudgets.deleteMany({ projectId });
  await store.projects.insertOne({
    _id: projectId,
    state: 'planning',
    autonomyMode,
    reviewCycle: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await createBudget(store, projectId);

  const profileRef = await registry.put(projectId, 'business-profile', profile);
  await registry.accept(projectId, profileRef);
  await workspace.materialiseArtifact('client/business-profile.json', profile);

  /**
   * What a phase is handed.
   *
   * `deps` and `facts` are fixed for the run, so they are assembled before
   * anything happens. `snapshot()` — defined once the run has progress to
   * report — assembles what a phase may read at the moment it is called, and
   * deliberately as a copy: a phase reports what it found, and the caller
   * decides what to remember.
   *
   * Nothing here caches a budget. `budgetLimits` is the ceiling and never the
   * usage; what has been spent is read from the store when a decision needs it
   * and spent inside a transaction, because a snapshot is evidence for a
   * decision and never permission to skip the spend.
   */
  const deps: RunDeps = { store, registry, workspace, model, say, track };
  const facts: RunFacts = {
    projectId,
    profile,
    autonomyMode,
    budgetLimits: (await store.budgets.findOne({ _id: projectId }))!.limits,
  };

  // -- Phase 2: Plan --------------------------------------------------------
  let plan = await producePlan({ deps, facts }, 0);

  // -- Phase 3: Build (one-shot first) --------------------------------------
  /**
   * Ask Sol how to build, then authorise the answer.
   *
   * Sol's decision is persisted either way — including when it is refused or
   * overridden — because "which strategy ran, and who chose it" is exactly the
   * kind of thing the audit trail exists to answer.
   */
  /**
   * Persist a routing outcome as a versioned artifact.
   *
   * Shared by the decision and by truncation recovery, so both appear in the
   * same lineage and a reader can see that one-shot was chosen and then had to
   * be abandoned — rather than seeing only the strategy that finally ran.
   */

  await buildFromPlan({ deps, facts }, plan);

  // -- Phases 4/5: Evaluate, repair, escalate -------------------------------
  let reviewCycle = 0;
  let repairsApplied = 0;
  let qualityScore = 0;
  /** Which gates certified the released revision, recorded in the manifest. */
  let gatesCertified: string[] = [];
  let openDefects: Defect[] = [];
  let terminalDecision: TerminalOutcome | undefined;
  /** Repaired but not yet re-verified — carried into the next review. */
  let repairedSinceReview: { id: string; reason: string; acceptanceTest: string }[] = [];

  /**
   * Every repair attempted so far, with what became of it.
   *
   * Sol needs this to tell a first-time defect from one that narrow repair has
   * already failed on — which is the evidence that distinguishes "repair again"
   * from "the plan is the problem".
   */
  const repairHistory: { defectId: string; fingerprint: string; outcome: string }[] = [];

  /** Replans actually executed, for the approval evidence. */
  let replansUsed = 0;

  /**
   * The harness's own release decision, and the provenance of the
   * recommendation it considered. Null until the approval path runs, which is
   * what keeps deployment unreachable before then.
   */
  let authorization: ReleaseAuthorization | null = null;
  let approvalArtifactVersion: number | null = null;
  let approvalModel: string | null = null;
  let approvalDecision: 'accept' | 'reject' | 'human_review' | null = null;
  /** Set when the review could not be obtained at all, as opposed to rejecting. */
  let reviewUnavailable: string | null = null;

  /** What the run has done so far, as of now. */
  const snapshot = (): RunProgress => ({
    plan,
    reviewCycle,
    repairsApplied,
    replansUsed,
    qualityScore,
    gatesCertified,
    openDefects,
    repairedSinceReview,
    repairHistory,
    terminalDecision,
    authorization,
    approvalArtifactVersion,
    approvalModel,
    approvalDecision,
    reviewUnavailable,
    usage,
    usageByTier,
    phaseMs,
  });

  const ctx = (): RunContext => ({ deps, facts, progress: snapshot() });

  while (true) {
    await store.projects.updateOne(
      { _id: projectId },
      { $set: { state: 'validating', updatedAt: new Date() } },
    );

    const evaluation = await evaluateSite(ctx());

    if (evaluation.kind === 'review_unavailable') {
      // An unobtainable review never counts as approval, so the run stops here
      // with the reason recorded rather than proceeding on a missing verdict.
      reviewUnavailable = evaluation.reason;
      terminalDecision = 'mark_blocked';
      break;
    }

    const { compiled, gateRun, sources, sourceOf, reviewSummary } = evaluation;
    qualityScore = evaluation.qualityScore;
    gatesCertified = evaluation.gatesCertified;
    openDefects = evaluation.openDefects;
    if (evaluation.reviewRan) repairedSinceReview = [];

    const mustFix = blocking(openDefects);

    if (mustFix.length === 0) {
      /**
       * Nothing blocking remains, so the question becomes whether to release —
       * which is two questions, asked in order. Sol judges; the harness decides.
       */
      say({ phase: 'approve', detail: 'No blocking criteria outstanding — asking Sol to judge release' });

      const release = await seekRelease(ctx(), {
        gateRun,
        buildOk: compiled.ok,
        buildSummary: compiled.ok
          ? `succeeded in ${(compiled.durationMs / 1000).toFixed(1)}s`
          : 'failed',
        reviewSummary,
        openNonBlocking: openDefects.filter((d) => d.severity !== 'P0' && d.severity !== 'P1'),
      });

      authorization = release.decision;
      approvalArtifactVersion = release.provenance.approvalArtifactVersion;
      approvalModel = release.provenance.approvalModel;
      approvalDecision = release.provenance.approvalDecision;

      if (!authorization.authorized) {
        // The harness refused. `human_review` is a real outcome rather than a
        // failure, but neither reaches deployment.
        //
        // No terminal outcome is chosen here: the refusal path exits through
        // `terminalForRefusal(authorization.action)` below, which is the only
        // mapping that holds when nothing blocking remains. This branch used to
        // assign one too — dead since the refusal semantics were fixed, and a
        // second copy of a rule the policy engine owns.
        say({
          phase: 'approve',
          detail: `Release not authorised (${authorization.action}): ${authorization.reason}`,
          level: 'fail',
        });
      }
      break;
    }

    const decided = await adjudicateDefects(ctx(), mustFix, { gateRun, reviewSummary });
    const adjudication = decided.authorization;
    const proposedAdjudication = decided.proposed;

    if (adjudication.action === 'block') {
      terminalDecision = decideTerminal(openDefects, autonomyMode);
      say({
        phase: 'escalate',
        detail: `Adjudicated as unrecoverable → ${terminalDecision}`,
        level: 'fail',
      });
      break;
    }

    /**
     * A rejection is spent once, whatever answers it.
     *
     * `reviewRejections` is how many rejected evaluations may trigger another
     * corrective action — not how many rejections occurred, because a terminal
     * `block` answers nothing and spends none. Repair used to consume one and
     * replan did not, so a run that replanned twice showed the same count as
     * one that had never been rejected, and the counter measured "repair
     * cycles" while being named for rejections.
     *
     * Spent before the action runs and only for actions that answer a
     * rejection: `block` ends the run rather than responding to it.
     */
    try {
      await spend(store, projectId, 'reviewRejections');
      // Incremented only once the allowance is actually spent. Legality was
      // computed from the same budget a moment earlier, so this should not
      // fail — but under concurrent execution or state drift it can, and the
      // counter must not report a cycle the budget refused.
      reviewCycle += 1;
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      terminalDecision = decideTerminal(openDefects, autonomyMode);
      say({ phase: 'escalate', detail: `Rejection budget exhausted → ${terminalDecision}`, level: 'fail' });
      break;
    }

    if (adjudication.action === 'replan') {
      /**
       * The budget is spent by the harness, never by Sol. `replan` being legal
       * means the budget had room when the actions were computed; spending it
       * is still transactional, because that is where the guarantee lives.
       */
      try {
        await spend(store, projectId, 'replans');
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        terminalDecision = decideTerminal(openDefects, autonomyMode);
        say({
          phase: 'escalate',
          detail: `Re-plan budget exhausted with ${mustFix.length} blocking defects → ${terminalDecision}`,
          level: 'fail',
        });
        break;
      }

      say({
        phase: 'escalate',
        detail: `Revising the specification (${mustFix.length} blocking defects, scope ${proposedAdjudication?.scope ?? 'site'})`,
        level: 'warn',
      });

      /**
       * Sol revises the plan against the evidence that condemned it.
       *
       * This used to call the planner again with the business profile and
       * nothing else, so the revision could not know what broke, what had
       * already been repaired, or which parts were working — a second guess
       * drawn from the same inputs as the first.
       */
      const scope = (proposedAdjudication?.scope ?? 'site') as ReplanScope;
      const revised = await revisePlan(ctx(), {
        scope,
        adjudicationReason: proposedAdjudication?.reason ?? adjudication.refusal ?? 'unspecified',
        unresolvedDefects: mustFix,
        gateFindings: gateRun.findings.map(
          (f) => `${f.severity} ${f.gate} ${f.location} — ${f.message}`,
        ),
        reviewSummary,
      });

      if (!revised) {
        /**
         * A replan that cannot be obtained is not a licence to regenerate.
         *
         * Falling back to the original planner would reinstate exactly the
         * defect this phase removes, and inventing a revision in the harness
         * would be the harness reasoning semantically in the model's absence.
         * The budget is already spent, so the run stops with the reason
         * recorded.
         */
        terminalDecision = decideTerminal(openDefects, autonomyMode);
        say({
          phase: 'escalate',
          detail: `Replan could not be produced → ${terminalDecision}`,
          level: 'fail',
        });
        break;
      }

      await workspace.clearSite();
      replansUsed += 1;
      plan = revised;
      await buildFromPlan(ctx(), plan);
      repairedSinceReview = [];
      continue;
    }

    // Policy names ids; the orchestrator resolves them back to the defects it
    // holds, because executing a repair needs the whole object.
    const targets = mustFix.filter((d) => adjudication.targetIds.includes(d.id));

    say({
      phase: 'repair',
      detail: `Cycle ${reviewCycle}/${facts.budgetLimits.reviewRejections}: repairing ${targets.length} of ${mustFix.length} blocking defect(s)`,
    });

    let exhausted = false;
    for (const defect of targets) {
      try {
        await store.withTransaction((session) =>
          spendRepairAttempt(store, projectId, defect.fingerprint, reviewCycle, session),
        );
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        say({
          phase: 'repair',
          detail: `${defect.id} skipped — ${error.budget} exhausted`,
          level: 'warn',
        });
        exhausted = true;
        continue;
      }

      const scope = filesForDefect(
        defect.location,
        sources.map((f) => f.path),
        defect.reason,
        sourceOf,
      );
      const companions = sources.filter((f) => (REPAIR_COMPANIONS as readonly string[]).includes(f.path));

      /**
       * One call per file rather than one call for the whole scope.
       *
       * A defect can legitimately span several pages, but asking a single call
       * to return four complete pages exceeds the output ceiling and truncates
       * — the repair then fails wholesale. Per-file calls keep each response
       * small, and they are a better reading of §3's "smallest reasonable
       * scope" anyway. The budget is still spent once for the defect, because
       * it is one defect however many files it touches.
       */
      const targets = scope.filter((p) => !(REPAIR_COMPANIONS as readonly string[]).includes(p));
      const units = targets.length > 0 ? targets : scope;

      let written = 0;
      let refused = 0;
      let failed = 0;

      for (const target of units) {
        const context = [
          ...sources.filter((f) => f.path === target),
          ...companions.filter((f) => f.path !== target),
        ];
        try {
          const repaired = await repairDefect(model, profile, defect, context);
          track('luna', repaired);

          // Luna may only rewrite files it was given. Enforced here rather than
          // trusted to the prompt.
          const allowed = new Set(context.map((f) => f.path));
          const permitted = repaired.value.files.filter((f) => allowed.has(f.path));
          refused += repaired.value.files.length - permitted.length;
          await workspace.writeSiteFiles(permitted);
          written += permitted.length;
        } catch (error) {
          // A failed repair must not kill the delivery. The budget is already
          // spent, the defect stays open, and Sol escalates through the normal
          // path when the rejection budget runs out.
          failed += 1;
          say({
            phase: 'repair',
            detail: `${defect.id} on ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
            level: 'warn',
          });
        }
      }

      // Queued for explicit re-verification in the next review, so a repair is
      // never assumed to have worked just because it was attempted.
      repairedSinceReview.push({
        id: defect.id,
        reason: defect.reason,
        acceptanceTest: defect.acceptanceTest,
      });
      if (written > 0) repairsApplied += 1;

      // Recorded so the next adjudication can tell a first attempt from a
      // defect that narrow repair has already failed to clear.
      repairHistory.push({
        defectId: defect.id,
        fingerprint: defect.fingerprint,
        outcome:
          failed > 0 && written === 0
            ? `failed (${failed} file(s))`
            : `${written} file(s) rewritten${refused > 0 ? `, ${refused} refused` : ''}`,
      });

      say({
        phase: 'repair',
        detail:
          `${defect.id} [${defect.severity} ${defect.category}] across ${units.length} file(s) → ${written} written` +
          `${refused > 0 ? `, ${refused} out-of-scope refused` : ''}${failed > 0 ? `, ${failed} failed` : ''}`,
        level: failed > 0 ? 'warn' : 'info',
      });
    }

    await workspace.commit(`Luna: repair cycle ${reviewCycle}`);

    if (exhausted && repairsApplied === 0) {
      terminalDecision = decideTerminal(openDefects, autonomyMode);
      say({ phase: 'escalate', detail: `Repair budget exhausted → ${terminalDecision}`, level: 'fail' });
      break;
    }
  }

  // -- Phases 6/7: Optional human review, then publish ----------------------
  //
  // An unobtainable review never counts as approval. §7 forbids accepting "the
  // builder says it is done", and "nobody checked" is a weaker claim than that.
  const stillBlocked = isReleaseBlocked(openDefects) || reviewUnavailable !== null;

  if (stillBlocked) {
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'blocked', updatedAt: new Date() } });
    const commit = await workspace.currentCommit();
    return {
      projectId,
      outcome: 'blocked',
      terminalDecision: terminalDecision ?? decideTerminal(openDefects, autonomyMode),
      qualityScore,
      reviewCycles: reviewCycle,
      repairsApplied,
      openDefects,
      commit,
      siteRoot: workspace.siteRoot,
      usage,
      usageByTier,
      phaseMs: { ...phaseMs },
    };
  }

  /**
   * Deployment is reachable only through a harness authorisation.
   *
   * `authorization` is null unless the approval path ran and returned one, so
   * every route to this point that skipped it — a terminal escalation, an
   * exhausted budget, a refused revision — stops here rather than publishing.
   */
  if (!authorization?.authorized) {
    const awaitingHuman = authorization?.action === 'human_review';

    if (awaitingHuman) {
      await store.projects.updateOne(
        { _id: projectId },
        { $set: { state: 'awaiting_human_review', updatedAt: new Date() } },
      );
      say({
        phase: 'approve',
        detail: `Awaiting human review before release: ${authorization?.reason ?? ''}`,
        level: 'warn',
      });
    } else {
      await store.projects.updateOne(
        { _id: projectId },
        { $set: { state: 'blocked', updatedAt: new Date() } },
      );
    }

    // Mapped from the authorisation, not from the defect list. A refusal here
    // happens with no blocking defects outstanding, which is exactly when
    // `decideTerminal` prefers `accept_non_blocking` — so borrowing it reported
    // a denied release as an acceptance.
    return concluded(ctx(), 'blocked', terminalForRefusal(authorization?.action ?? null));
  }

  const { manifest, finalCommit } = await publishRelease(ctx(), authorization);

  return { ...(await concluded(ctx(), 'released', undefined)), commit: finalCommit, manifest };
}
