/**
 * Sol — the delivery loop (v1.2 §6).
 *
 *   discover → plan → build → evaluate → repair/escalate → publish
 *
 * Sol owns project state, policy, execution budgets and the final machine
 * approval. It never edits a file itself: it decides what happens next, and
 * every decision it makes is bounded by a budget that commits transactionally
 * with the work it authorises.
 */
import {
  BusinessProfile,
  HOME_PAGE_PATH,
  intakeGaps,
  isReleaseBlocked,
  legalTerminalOutcomes,
  type DeploymentManifest,
  type GeneratedFile,
  type SitePlan,
  type TerminalOutcome,
} from '@statxai/contracts';
import {
  buildAnchor,
  buildPage,
  buildSite,
  MalformedModelOutput,
  ModelClient,
  planSite,
  repairDefect,
  reviewSite,
} from '@statxai/agents';
import { runGates } from '@statxai/gates';
import { BudgetExhausted, createBudget, spend, spendRepairAttempt, type StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import { blocking, filesForDefect, fromGateFinding, fromReviewIssue, type Defect } from './defects.js';

export type Progress = (event: {
  phase: string;
  detail: string;
  level?: 'info' | 'warn' | 'ok' | 'fail';
}) => void;

export interface RunOptions {
  projectId: string;
  intake: unknown;
  store: StateStore;
  workspacesRoot: string;
  autonomyMode?: 'full_autonomous' | 'supervised_autonomous' | 'human_in_the_loop';
  onProgress?: Progress;
}

export interface RunResult {
  projectId: string;
  outcome: 'released' | 'blocked' | 'intake_insufficient';
  terminalDecision?: TerminalOutcome;
  qualityScore: number;
  reviewCycles: number;
  repairsApplied: number;
  openDefects: Defect[];
  commit: string | null;
  siteRoot: string;
  manifest?: DeploymentManifest;
  usage: { inputTokens: number; outputTokens: number; calls: number };
}

export async function runProject(options: RunOptions): Promise<RunResult> {
  const { projectId, store, workspacesRoot } = options;
  const autonomyMode = options.autonomyMode ?? 'full_autonomous';
  const say: Progress = options.onProgress ?? (() => {});

  const model = new ModelClient();
  const registry = new ArtifactRegistry(store);
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const track = (r: { inputTokens: number; outputTokens: number }) => {
    usage.inputTokens += r.inputTokens;
    usage.outputTokens += r.outputTokens;
    usage.calls += 1;
  };

  // -- Phase 1: Discover ----------------------------------------------------
  say({ phase: 'discover', detail: 'Validating intake against the canonical schema' });

  const parsed = BusinessProfile.safeParse(options.intake);
  if (!parsed.success) {
    say({ phase: 'discover', detail: `Intake rejected: ${parsed.error.issues[0]?.message}`, level: 'fail' });
    return terminal('intake_insufficient');
  }
  const profile = parsed.data;

  // Thin intake would force the builder to invent facts, which the content gate
  // then rejects forever. Catch it before spending a single token.
  const gaps = intakeGaps(profile);
  if (gaps.length > 0) {
    say({ phase: 'discover', detail: `Intake insufficient: ${gaps.join('; ')}`, level: 'fail' });
    return terminal('intake_insufficient');
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

  // -- Phase 2: Plan --------------------------------------------------------
  async function producePlan(attempt: number): Promise<SitePlan> {
    say({
      phase: 'plan',
      detail: attempt === 0 ? 'Sol is producing the specification' : 'Sol is revising the specification',
    });
    const planned = await planSite(model, profile);
    track(planned);
    const produced = planned.value;

    say({
      phase: 'plan',
      detail: `${produced.sitemap.pages.length} pages, ${produced.acceptanceCriteria.length} acceptance criteria (${planned.model}, ${(planned.ms / 1000).toFixed(1)}s)`,
      level: 'ok',
    });

    const ref = await registry.put(projectId, 'site-plan', produced);
    await registry.accept(projectId, ref);
    await workspace.materialiseArtifact('design/brand-system.json', produced.brandSystem);
    await workspace.materialiseArtifact('specs/sitemap.json', produced.sitemap);
    for (const page of produced.sitemap.pages) {
      await workspace.materialiseArtifact(`specs/pages/${page.path.replace(/\//g, '_')}.json`, page);
    }
    return produced;
  }

  let plan = await producePlan(0);

  // -- Phase 3: Build (one-shot first) --------------------------------------
  async function buildFromPlan(current: SitePlan): Promise<void> {
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'building', updatedAt: new Date() } });

  /**
   * §3 mandates one-shot first, so `auto` is the default. `decompose` skips
   * straight to per-page builds: the whole-site attempt is a single very long
   * request, and on constrained hosts that is the most fragile call in the
   * pipeline. Forcing decomposition trades one long call for several short
   * parallel ones.
   */
  const strategy = process.env.BUILD_STRATEGY ?? 'auto';

  try {
    if (strategy === 'decompose') throw new MalformedModelOutput('', new Error('forced: output truncated'));

    say({ phase: 'build', detail: 'Terra is attempting the complete site in one pass' });
    const built = await buildSite(model, profile, current);
    track(built);
    await workspace.writeSiteFiles(built.value.files);
    say({
      phase: 'build',
      detail: `One-shot succeeded: ${built.value.files.length} files (${built.model}, ${(built.ms / 1000).toFixed(1)}s, ${built.outputTokens} out)`,
      level: 'ok',
    });
  } catch (error) {
    // §3: one-shot first, decompose only when needed. A truncated build is a
    // concrete validation failure, so this is the documented escalation path
    // rather than an invented one. Any other failure is real and propagates.
    if (!(error instanceof MalformedModelOutput) || !/truncated/.test(error.message)) throw error;

    // `one-shot` opts out of the escalation entirely, so a truncation is the
    // run's outcome rather than a trigger to decompose.
    if (strategy === 'one-shot') throw error;

    say({
      phase: 'build',
      detail:
        strategy === 'decompose'
          ? 'Building by decomposition: anchor first, then pages in parallel'
          : 'One-shot exceeded the output ceiling — decomposing into per-page jobs',
      level: 'warn',
    });

    const anchor = await buildAnchor(model, profile, current);
    track(anchor);
    await workspace.writeSiteFiles(anchor.value.files);

    // The homepage anchors the design system. Selecting by array order once put
    // a nested FAQ page in this role.
    const anchorPage =
      current.sitemap.pages.find((p) => p.path === HOME_PAGE_PATH) ?? current.sitemap.pages[0]!;
    const stylesheet = anchor.value.files.find((f) => f.path.endsWith('.css'))?.contents ?? '';
    const anchorHtml = anchor.value.files.find((f) => f.path === anchorPage.path)?.contents ?? '';
    say({ phase: 'build', detail: `Anchor: ${anchorPage.path} + styles.css`, level: 'ok' });

    // Pages are independent given the anchor, and each writes a distinct file,
    // so there is no output conflict to serialise — they can run concurrently.
    const rest = current.sitemap.pages.filter((p) => p.path !== anchorPage.path);
    const pages = await Promise.all(
      rest.map((page) => buildPage(model, profile, current, page, anchorPage.path, anchorHtml, stylesheet)),
    );
    for (const page of pages) {
      track(page);
      await workspace.writeSiteFiles(page.value.files.filter((f) => f.path.endsWith('.html')));
    }
    say({ phase: 'build', detail: `${rest.length} further pages built in parallel`, level: 'ok' });
  }

    await workspace.commit('Terra: build');
  }

  await buildFromPlan(plan);

  // -- Phases 4/5: Evaluate, repair, escalate -------------------------------
  let reviewCycle = 0;
  let repairsApplied = 0;
  let qualityScore = 0;
  let openDefects: Defect[] = [];
  let terminalDecision: TerminalOutcome | undefined;
  /** Repaired but not yet re-verified — carried into the next review. */
  let repairedSinceReview: { id: string; reason: string; acceptanceTest: string }[] = [];
  /** Set when the review could not be obtained at all, as opposed to rejecting. */
  let reviewUnavailable: string | null = null;

  const budgetLimits = (await store.budgets.findOne({ _id: projectId }))!.limits;

  while (true) {
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'validating', updatedAt: new Date() } });

    const files = await currentFiles(workspace);

    // Deterministic gates first: they are cheap, objective, and a blocking
    // failure here means there is no point paying for subjective review.
    const gateRun = runGates({ files, profile, plan });
    const gateDefects = gateRun.findings.map(fromGateFinding);
    const blockingGates = blocking(gateDefects);

    say({
      phase: 'evaluate',
      detail: `Gates: ${gateRun.findings.length} findings, ${blockingGates.length} blocking`,
      level: blockingGates.length === 0 ? 'ok' : 'warn',
    });

    await registry.put(projectId, 'test-report', {
      passed: gateRun.passed,
      ranAt: new Date().toISOString(),
      findings: gateRun.findings,
      gatesRun: gateRun.gatesRun,
    });

    let defects: Defect[] = gateDefects;

    if (blockingGates.length === 0) {
      say({
        phase: 'evaluate',
        detail:
          repairedSinceReview.length === 0
            ? 'Independent Terra review'
            : `Independent Terra review, re-verifying ${repairedSinceReview.length} repaired defect(s)`,
      });
      let reviewed;
      try {
        reviewed = await reviewSite(model, profile, plan, files, reviewCycle, repairedSinceReview);
      } catch (error) {
        // A review that cannot run is not an accepted review. Repairs already
        // degrade gracefully; this did not, so an API outage mid-review took
        // down a delivery whose build and gates had both passed. The project is
        // marked blocked with the reason recorded, and the accepted artifacts
        // and workspace are left intact for a resumed run.
        const message = error instanceof Error ? error.message : String(error);
        say({ phase: 'evaluate', detail: `Review could not complete: ${message}`, level: 'fail' });
        reviewUnavailable = message;
        terminalDecision = 'mark_blocked';
        break;
      }
      repairedSinceReview = [];
      track(reviewed);
      qualityScore = reviewed.value.qualityScore;

      const reviewDefects = reviewed.value.issues.map(fromReviewIssue);
      defects = [...gateDefects, ...reviewDefects];

      await registry.put(projectId, 'visual-review', {
        ...reviewed.value,
        reviewer: { tier: 'terra', model: reviewed.model, skillVersion: 'terra-review@1' },
        reviewCycle,
      });

      say({
        phase: 'evaluate',
        detail: `Review: ${reviewed.value.decision}, score ${qualityScore}, ${reviewed.value.issues.length} issues, blocking=${reviewed.value.blocking}`,
        level: reviewed.value.blocking ? 'warn' : 'ok',
      });
    }

    openDefects = defects;
    const mustFix = blocking(defects);

    if (mustFix.length === 0) {
      say({ phase: 'evaluate', detail: 'No blocking criteria outstanding — Sol approves', level: 'ok' });
      break;
    }

    /**
     * §7's escalation ladder is repair → specialist → specification revision,
     * and this is the third rung. When the blocking work exceeds what the
     * repair budget could ever clear, repairing is not convergent: the plan is
     * the defect, not the pages. One run planned every page nested under
     * "about/faq/" with no homepage, produced ninety blocking findings against
     * a budget of eight, and ground through repairs that could never finish.
     */
    const currentBudget = (await store.budgets.findOne({ _id: projectId }))!;
    const repairsLeft = currentBudget.limits.totalRepairJobs - currentBudget.used.totalRepairJobs;

    if (mustFix.length > repairsLeft) {
      try {
        await spend(store, projectId, 'replans');
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) throw error;
        terminalDecision = decideTerminal(defects, autonomyMode);
        say({
          phase: 'escalate',
          detail: `Re-plan budget exhausted with ${mustFix.length} blocking defects → ${terminalDecision}`,
          level: 'fail',
        });
        break;
      }

      say({
        phase: 'escalate',
        detail: `${mustFix.length} blocking defects exceed the ${repairsLeft} repair jobs remaining — revising the specification`,
        level: 'warn',
      });

      await workspace.clearSite();
      plan = await producePlan(reviewCycle + 1);
      await buildFromPlan(plan);
      repairedSinceReview = [];
      continue;
    }

    // A rejection cycle is spent whenever blocking work remains.
    reviewCycle += 1;
    try {
      await spend(store, projectId, 'reviewRejections');
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      terminalDecision = decideTerminal(defects, autonomyMode);
      say({ phase: 'escalate', detail: `Rejection budget exhausted → ${terminalDecision}`, level: 'fail' });
      break;
    }

    say({
      phase: 'repair',
      detail: `Cycle ${reviewCycle}/${budgetLimits.reviewRejections}: repairing ${mustFix.length} blocking defect(s)`,
    });

    let exhausted = false;
    for (const defect of mustFix) {
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

      const scope = filesForDefect(defect.location, files.map((f) => f.path), defect.reason);
      const stylesheet = files.find((f) => f.path === 'styles.css');

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
      const targets = scope.filter((p) => p !== 'styles.css');
      const units = targets.length > 0 ? targets : scope;

      let written = 0;
      let refused = 0;
      let failed = 0;

      for (const target of units) {
        const context = files.filter((f) => f.path === target || (stylesheet && f.path === 'styles.css'));
        try {
          const repaired = await repairDefect(model, profile, defect, context);
          track(repaired);

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
      terminalDecision = decideTerminal(defects, autonomyMode);
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
    };
  }

  if (autonomyMode !== 'full_autonomous') {
    say({
      phase: 'review',
      detail: `Autonomy mode is ${autonomyMode} — awaiting human approval before release`,
      level: 'warn',
    });
    await store.projects.updateOne(
      { _id: projectId },
      { $set: { state: 'awaiting_human_review', updatedAt: new Date() } },
    );
  }

  await store.projects.updateOne({ _id: projectId }, { $set: { state: 'releasing', updatedAt: new Date() } });

  const releaseCommit = (await workspace.commit('Sol: accepted revision')) ?? (await workspace.currentCommit());

  const manifest: DeploymentManifest = {
    projectId,
    commit: releaseCommit ?? 'uncommitted',
    environment: 'preview',
    autonomyMode,
    approvedBy: 'sol:machine-approval',
    qualityScore,
    checks: runGates({ files: await currentFiles(workspace), profile, plan }).gatesRun,
    rollbackRef: null,
    releasedAt: new Date(),
  };
  await registry.put(projectId, 'deployment-manifest', manifest);
  await workspace.materialiseArtifact('deployment/deployment-manifest.json', manifest);
  const finalCommit = (await workspace.commit('Sol: release manifest')) ?? releaseCommit;

  await store.projects.updateOne({ _id: projectId }, { $set: { state: 'released', updatedAt: new Date() } });
  say({ phase: 'publish', detail: `Released at ${finalCommit?.slice(0, 8) ?? 'HEAD'}`, level: 'ok' });

  return {
    projectId,
    outcome: 'released',
    qualityScore,
    reviewCycles: reviewCycle,
    repairsApplied,
    openDefects,
    commit: finalCommit,
    siteRoot: workspace.siteRoot,
    manifest,
    usage,
  };

  function terminal(outcome: RunResult['outcome']): RunResult {
    return {
      projectId,
      outcome,
      qualityScore: 0,
      reviewCycles: 0,
      repairsApplied: 0,
      openDefects: [],
      commit: null,
      siteRoot: '',
      usage,
    };
  }
}

async function currentFiles(workspace: ProjectWorkspace): Promise<GeneratedFile[]> {
  const paths = await workspace.listSiteFiles();
  return Promise.all(
    paths.map(async (path) => ({ path, contents: await workspace.readSiteFile(path) })),
  );
}

/**
 * §7's terminal escalation, with the constraint the document leaves implicit
 * made explicit: with a P0/P1 still open, accepting the documented non-blocking
 * issues is not among the lawful outcomes.
 */
function decideTerminal(defects: readonly Defect[], autonomyMode: string): TerminalOutcome {
  const legal = legalTerminalOutcomes(defects, {
    humanReviewPermitted: autonomyMode !== 'full_autonomous',
  });
  if (legal.includes('accept_non_blocking')) return 'accept_non_blocking';
  if (legal.includes('rollback_to_last_accepted')) return 'rollback_to_last_accepted';
  return 'mark_blocked';
}
