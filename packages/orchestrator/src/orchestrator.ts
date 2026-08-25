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
} from '@statxai/contracts';
import {
  ModelClient,
} from '@statxai/agents';
import { BudgetExhausted, createBudget, spend, type StateStore } from '@statxai/state';
import {
  ArtifactRegistry,
  ProjectWorkspace,
} from '@statxai/workspace';
import {
  decideTerminal,
  isReleaseBlocked,
  terminalForRefusal,
  type ReplanScope,
} from '@statxai/policy-engine';
import { concluded, withoutDelivery, type RunResult } from './phases/conclude.js';
import { buildFromPlan } from './phases/build.js';
import { adjudicateDefects } from './phases/adjudicate.js';
import { evaluateSite } from './phases/evaluate.js';
import { producePlan, revisePlan } from './phases/planning.js';
import { executeRepairs } from './phases/repair.js';
import { publishRelease } from './phases/publish.js';
import { seekRelease } from './phases/release.js';
import {
  createRunProgress,
  snapshotProgress,
  type Progress,
  type RunContext,
  type RunDeps,
  type RunFacts,
} from './run-context.js';

export type { RunResult } from './phases/conclude.js';
export type { Progress } from './run-context.js';
import {
  blocking,
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

  /**
   * Every fact the run accumulates about itself, in one place.
   *
   * These were eighteen parallel locals with a `snapshot()` that rebuilt an
   * object from them — two writable representations of the same facts, and a
   * copy only one level deep. The owner is here; phases are handed
   * `snapshotProgress(progress)`, which is detached and read-only.
   *
   * Created before anything else because telemetry starts accumulating
   * immediately, which is also why its `plan` is nullable while a phase's is
   * not.
   *
   * Deliberately absent: anything durable. Budget remainders, artifact versions
   * and release permission are read from the store, the registry and the policy
   * engine when a decision needs them. This is working state for one
   * invocation, never a cache of the database.
   *
   * Usage is split by tier because that is the only split that can be priced:
   * Sol, Terra and Luna map to different models and therefore different rates.
   */
  const progress = createRunProgress();
  const track = (tier: AgentTier, r: { inputTokens: number; outputTokens: number; ms: number }) => {
    progress.usage.inputTokens += r.inputTokens;
    progress.usage.outputTokens += r.outputTokens;
    progress.usage.calls += 1;

    const bucket = (progress.usageByTier[tier] ??= { inputTokens: 0, outputTokens: 0, calls: 0, ms: 0 });
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
  // `phaseStarted` and `currentPhase` stay private locals: they are the timing
  // machinery, not something a phase reports.
  let phaseStarted = Date.now();
  let currentPhase: string | null = null;
  const chargePhase = (next: string) => {
    const now = Date.now();
    if (currentPhase) {
      progress.phaseMs[currentPhase] = (progress.phaseMs[currentPhase] ?? 0) + (now - phaseStarted);
    }
    currentPhase = next;
    phaseStarted = now;
  };

  // -- Phase 1: Discover ----------------------------------------------------
  say({ phase: 'discover', detail: 'Validating intake against the canonical schema' });

  const parsed = BusinessProfile.safeParse(options.intake);
  if (!parsed.success) {
    say({ phase: 'discover', detail: `Intake rejected: ${parsed.error.issues[0]?.message}`, level: 'fail' });
    return withoutDelivery(projectId, 'intake_insufficient', { usage: progress.usage, usageByTier: progress.usageByTier, phaseMs: progress.phaseMs });
  }
  const profile = parsed.data;

  // Thin intake would force the builder to invent facts, which the content gate
  // then rejects forever. Catch it before spending a single token.
  const gaps = intakeGaps(profile);
  if (gaps.length > 0) {
    say({ phase: 'discover', detail: `Intake insufficient: ${gaps.join('; ')}`, level: 'fail' });
    return withoutDelivery(projectId, 'intake_insufficient', { usage: progress.usage, usageByTier: progress.usageByTier, phaseMs: progress.phaseMs });
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
  const initialPlan = await producePlan({ deps, facts }, 0);
  progress.plan = initialPlan;

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

  await buildFromPlan({ deps, facts }, initialPlan);

  // -- Phases 4/5: Evaluate, repair, escalate -------------------------------
  const ctx = (): RunContext => ({ deps, facts, progress: snapshotProgress(progress) });

  while (true) {
    const evaluation = await evaluateSite(ctx());

    if (evaluation.kind === 'review_unavailable') {
      // An unobtainable review never counts as approval, so the run stops here
      // with the reason recorded rather than proceeding on a missing verdict.
      progress.reviewUnavailable = evaluation.reason;
      progress.terminalDecision = 'mark_blocked';
      break;
    }

    const { compiled, gateRun, sources, sourceOf, reviewSummary } = evaluation;
    progress.qualityScore = evaluation.qualityScore;
    progress.gatesCertified = evaluation.gatesCertified;
    progress.openDefects = evaluation.openDefects;
    if (evaluation.reviewRan) progress.repairedSinceReview = [];

    const mustFix = blocking(progress.openDefects);

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
        openNonBlocking: progress.openDefects.filter((d) => d.severity !== 'P0' && d.severity !== 'P1'),
      });

      progress.authorization = release.decision;
      progress.approvalArtifactVersion = release.provenance.approvalArtifactVersion;
      progress.approvalModel = release.provenance.approvalModel;
      progress.approvalDecision = release.provenance.approvalDecision;

      if (!progress.authorization.authorized) {
        // The harness refused. `human_review` is a real outcome rather than a
        // failure, but neither reaches deployment.
        //
        // No terminal outcome is chosen here: the refusal path exits through
        // `terminalForRefusal(progress.authorization.action)` below, which is the only
        // mapping that holds when nothing blocking remains. This branch used to
        // assign one too — dead since the refusal semantics were fixed, and a
        // second copy of a rule the policy engine owns.
        say({
          phase: 'approve',
          detail: `Release not authorised (${progress.authorization.action}): ${progress.authorization.reason}`,
          level: 'fail',
        });
      }
      break;
    }

    const decided = await adjudicateDefects(ctx(), mustFix, { gateRun, reviewSummary });
    const adjudication = decided.authorization;
    const proposedAdjudication = decided.proposed;

    if (adjudication.action === 'block') {
      progress.terminalDecision = decideTerminal(progress.openDefects, autonomyMode);
      say({
        phase: 'escalate',
        detail: `Adjudicated as unrecoverable → ${progress.terminalDecision}`,
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
      progress.reviewCycle += 1;
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      progress.terminalDecision = decideTerminal(progress.openDefects, autonomyMode);
      say({ phase: 'escalate', detail: `Rejection budget exhausted → ${progress.terminalDecision}`, level: 'fail' });
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
        progress.terminalDecision = decideTerminal(progress.openDefects, autonomyMode);
        say({
          phase: 'escalate',
          detail: `Re-plan budget exhausted with ${mustFix.length} blocking defects → ${progress.terminalDecision}`,
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
        progress.terminalDecision = decideTerminal(progress.openDefects, autonomyMode);
        say({
          phase: 'escalate',
          detail: `Replan could not be produced → ${progress.terminalDecision}`,
          level: 'fail',
        });
        break;
      }

      await workspace.clearSite();
      progress.replansUsed += 1;
      progress.plan = revised;
      await buildFromPlan(ctx(), revised);
      progress.repairedSinceReview = [];
      continue;
    }

    // Policy names ids; the orchestrator resolves them back to the defects it
    // holds, because executing a repair needs the whole object.
    const targets = mustFix.filter((d) => adjudication.targetIds.includes(d.id));

    say({
      phase: 'repair',
      detail: `Cycle ${progress.reviewCycle}/${facts.budgetLimits.reviewRejections}: repairing ${targets.length} of ${mustFix.length} blocking defect(s)`,
    });

    const repair = await executeRepairs(ctx(), { targets, sources, sourceOf });

    // The phase reports; the run remembers. Nothing it was handed was mutated.
    progress.repairsApplied += repair.repairsAppliedDelta;
    progress.repairedSinceReview.push(...repair.repairedSinceReview);
    progress.repairHistory.push(...repair.repairHistoryEntries);

    /**
     * Did *this* cycle hit exhaustion and achieve nothing?
     *
     * This read `progress.repairsApplied`, the cumulative count for the whole run, so a
     * cycle that was refused every spend and repaired nothing still continued
     * as long as some earlier cycle had succeeded — evaluating again, spending
     * a rejection, and arriving at the same defects. The question is about the
     * cycle that just ran, and the phase now returns a per-cycle delta to ask
     * it with.
     *
     * Reachable only when the authoritative spend disagrees with the snapshot
     * policy authorised from: within one run, targets are capped to both
     * allowances before they get here. That is drift or concurrency — which is
     * exactly the case worth getting right.
     */
    if (repair.exhausted && repair.repairsAppliedDelta === 0) {
      progress.terminalDecision = decideTerminal(progress.openDefects, autonomyMode);
      say({ phase: 'escalate', detail: `Repair budget exhausted → ${progress.terminalDecision}`, level: 'fail' });
      break;
    }
  }

  // -- Phases 6/7: Optional human review, then publish ----------------------
  //
  // An unobtainable review never counts as approval. §7 forbids accepting "the
  // builder says it is done", and "nobody checked" is a weaker claim than that.
  const stillBlocked = isReleaseBlocked(progress.openDefects) || progress.reviewUnavailable !== null;

  if (stillBlocked) {
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'blocked', updatedAt: new Date() } });
    // The same exit every other post-delivery return uses, rather than a second
    // hand-built result: the telemetry bugs this file has already had all came
    // from one exit path reporting a different run from the one that happened.
    return concluded(
      ctx(),
      'blocked',
      progress.terminalDecision ?? decideTerminal(progress.openDefects, autonomyMode),
    );
  }

  /**
   * Deployment is reachable only through a harness authorisation.
   *
   * `progress.authorization` is null unless the approval path ran and returned one, so
   * every route to this point that skipped it — a terminal escalation, an
   * exhausted budget, a refused revision — stops here rather than publishing.
   */
  if (!progress.authorization?.authorized) {
    const awaitingHuman = progress.authorization?.action === 'human_review';

    if (awaitingHuman) {
      await store.projects.updateOne(
        { _id: projectId },
        { $set: { state: 'awaiting_human_review', updatedAt: new Date() } },
      );
      say({
        phase: 'approve',
        detail: `Awaiting human review before release: ${progress.authorization?.reason ?? ''}`,
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
    return concluded(ctx(), 'blocked', terminalForRefusal(progress.authorization?.action ?? null));
  }

  const { manifest, finalCommit } = await publishRelease(ctx(), progress.authorization);

  return { ...(await concluded(ctx(), 'released', undefined)), commit: finalCommit, manifest };
}
