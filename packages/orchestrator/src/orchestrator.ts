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
  HOME_ROUTE,
  routeToOutputPath,
  routeToSourcePath,
  intakeGaps,
  isReleaseBlocked,
  legalTerminalOutcomes,
  type DeploymentManifest,
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
import {
  ArtifactRegistry,
  ProjectWorkspace,
  buildSite as compileSite,
  deploySite,
  deploymentConfigured,
  readBuiltFiles,
  readExportFiles,
  readSourceFiles,
  scaffoldSite,
  type BuildResult,
  type DeployResult,
} from '@statxai/workspace';
import {
  blocking,
  buildFailureDefect,
  filesForDefect,
  fromGateFinding,
  fromReviewIssue,
  mergeByFingerprint,
  REPAIR_COMPANIONS,
  type Defect,
} from './defects.js';

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
      const slug = page.route === HOME_ROUTE ? 'home' : page.route.replace(/^\//, '').replace(/\//g, '_');
      await workspace.materialiseArtifact(`specs/pages/${slug}.json`, page);
    }
    return produced;
  }

  let plan = await producePlan(0);

  // -- Phase 3: Build (one-shot first) --------------------------------------
  async function buildFromPlan(current: SitePlan): Promise<void> {
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'building', updatedAt: new Date() } });

    // The scaffold carries the toolchain, the dependency set and the shadcn
    // primitives. Terra writes pages against it and never installs anything, so
    // a build failure is always about the site rather than the toolchain.
    await scaffoldSite(workspace.siteRoot);

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
    const home = current.sitemap.pages.find((p) => p.route === HOME_ROUTE) ?? current.sitemap.pages[0]!;
    const homeSource = routeToSourcePath(home.route);
    const anchorSource = anchor.value.files.find((f) => f.path === homeSource)?.contents ?? '';
    const layoutSource = anchor.value.files.find((f) => f.path === 'app/layout.tsx')?.contents ?? '';
    say({ phase: 'build', detail: `Anchor: layout + ${homeSource}`, level: 'ok' });

    // Pages are independent given the anchor, and each writes a distinct file,
    // so there is no output conflict to serialise — they can run concurrently.
    const rest = current.sitemap.pages.filter((p) => p.route !== home.route);
    const pages = await Promise.all(
      rest.map((page) => buildPage(model, profile, current, page, anchorSource, layoutSource)),
    );
    for (const page of pages) {
      track(page);
      await workspace.writeSiteFiles(page.value.files);
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
  /** Which gates certified the released revision, recorded in the manifest. */
  let gatesCertified: string[] = [];
  let openDefects: Defect[] = [];
  let terminalDecision: TerminalOutcome | undefined;
  /** Repaired but not yet re-verified — carried into the next review. */
  let repairedSinceReview: { id: string; reason: string; acceptanceTest: string }[] = [];
  /** Set when the review could not be obtained at all, as opposed to rejecting. */
  let reviewUnavailable: string | null = null;

  const budgetLimits = (await store.budgets.findOne({ _id: projectId }))!.limits;

  while (true) {
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'validating', updatedAt: new Date() } });

    /**
     * §7's first deterministic gate: the application must build.
     *
     * This runs before every evaluation, not once, because repairs change
     * source. A site that does not compile has no output to inspect, so there
     * is nothing for the other gates or the reviewer to look at — the build
     * failure is the only finding worth reporting.
     */
    say({ phase: 'evaluate', detail: 'Compiling the site' });
    const compiled: BuildResult = await compileSite(workspace.siteRoot);

    if (!compiled.ok) {
      /**
       * The compiler's own words, not just "it failed".
       *
       * Everything else a run decides is reconstructable from the persisted
       * record afterwards; a build failure was the exception, because the
       * output only ever reached Luna's prompt. Diagnosing one meant rebuilding
       * the workspace by hand — and a live run had usually overwritten it.
       */
      const reason = firstErrors(compiled.output);
      say({
        phase: 'evaluate',
        detail: `Build failed after ${(compiled.durationMs / 1000).toFixed(1)}s${reason ? `: ${reason}` : ''}`,
        level: 'fail',
      });
    } else {
      say({
        phase: 'evaluate',
        detail: `Build succeeded in ${(compiled.durationMs / 1000).toFixed(1)}s`,
        level: 'ok',
      });
    }

    // Gates read the static export — the markup a visitor and a crawler
    // actually receive — rather than the TSX that produced it.
    const files = compiled.ok ? await readBuiltFiles(workspace.siteRoot) : [];

    // Every path in the export, so existence checks see the assets no gate
    // parses — scripts, fonts, icons — instead of reporting them missing.
    const assets = compiled.ok
      ? (await readExportFiles(workspace.siteRoot)).map((f) => f.path)
      : [];

    /**
     * Repairs edit source, never the export.
     *
     * Read separately and unconditionally: when the build fails there is no
     * export at all, and a repair handed an empty file list silently does
     * nothing while still spending the cycle that authorised it.
     */
    const sources = await readSourceFiles(workspace.siteRoot);

    // Every path a gate or a reviewer could cite, mapped to the file that
    // produced it. Rebuilt each cycle because a re-plan changes the routes.
    const sourceOf = Object.fromEntries(
      plan.sitemap.pages.map((page) => [routeToOutputPath(page.route), routeToSourcePath(page.route)]),
    );

    const gateRun = compiled.ok
      ? runGates({ files, profile, plan, assets })
      : { passed: false, findings: [], gatesRun: ['build'] };

    gatesCertified = compiled.ok ? ['build', ...gateRun.gatesRun] : ['build'];

    const gateDefects = compiled.ok
      ? gateRun.findings.map(fromGateFinding)
      : [buildFailureDefect(compiled.output)];
    const blockingGates = blocking(gateDefects);

    if (compiled.ok) {
      say({
        phase: 'evaluate',
        detail: `Gates: ${gateRun.findings.length} findings, ${blockingGates.length} blocking`,
        level: blockingGates.length === 0 ? 'ok' : 'warn',
      });
    }

    await registry.put(projectId, 'test-report', {
      passed: compiled.ok && gateRun.passed,
      ranAt: new Date().toISOString(),
      findings: gateRun.findings,
      gatesRun: compiled.ok ? ['build', ...gateRun.gatesRun] : ['build'],
      buildOutput: compiled.ok ? null : compiled.output,
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

    // Collapsed before anything acts on them: the repair budget is charged per
    // fingerprint, so the unit of work has to be the fingerprint too.
    openDefects = mergeByFingerprint(defects);
    const mustFix = blocking(openDefects);

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
      terminalDecision = decideTerminal(openDefects, autonomyMode);
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

  /**
   * Deploy only after machine approval (§9: "publish from a machine-accepted
   * source revision"). What ships is the export produced by the build the gates
   * and the reviewer both passed — no rebuild happens here, so what was
   * approved is byte-for-byte what goes live.
   */
  let deployment: DeployResult | null = null;

  if (deploymentConfigured()) {
    // The previous release is the rollback target, read before this one
    // supersedes it.
    const previous = await store.artifacts.findOne(
      { projectId, name: 'deployment-manifest' },
      { sort: { version: -1 } },
    );
    const previousDeploymentId =
      (previous?.data as { deploymentId?: string | null } | undefined)?.deploymentId ?? null;

    // Publishing is retried, but under the `failedDeployments` budget — a host
    // that is down stays down, and an unbounded retry would burn the run on an
    // outage it cannot fix. Two failures and Sol stops trying.
    while (deployment === null) {
      say({ phase: 'publish', detail: 'Deploying the accepted export' });
      try {
        deployment = await deploySite(workspace.siteRoot, projectId, { previousDeploymentId });
        say({
          phase: 'publish',
          detail: `Live at ${deployment.url} (${deployment.fileCount} files, ${(deployment.durationMs / 1000).toFixed(1)}s)`,
          level: 'ok',
        });
      } catch (error) {
        // A failed deploy is a release failure, not a silent one: the site was
        // approved but is not live, and the manifest must not claim otherwise.
        say({
          phase: 'publish',
          detail: `Deployment failed: ${error instanceof Error ? error.message : String(error)}`,
          level: 'fail',
        });
        try {
          await spend(store, projectId, 'failedDeployments');
        } catch (budgetError) {
          if (!(budgetError instanceof BudgetExhausted)) throw budgetError;
          say({
            phase: 'publish',
            detail: 'Deployment budget exhausted — the approved site stays on local preview',
            level: 'fail',
          });
          break;
        }
      }
    }
  } else {
    say({ phase: 'publish', detail: 'No deployment configured — released to local preview only', level: 'warn' });
  }

  const manifest: DeploymentManifest = {
    projectId,
    commit: releaseCommit ?? 'uncommitted',
    environment: deployment ? 'production' : 'preview',
    autonomyMode,
    approvedBy: 'sol:machine-approval',
    qualityScore,
    // The gates that actually certified this revision, not a fresh run against
    // a tree that may have moved on. Re-running them here would also mean
    // reporting a different result from the one the release was granted on.
    checks: gatesCertified,
    url: deployment?.url ?? null,
    deploymentId: deployment?.deploymentId ?? null,
    rollbackRef: deployment?.rollbackRef ?? null,
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

/**
 * The compiler lines from a build transcript, for the progress record.
 *
 * A failed `next build` emits install noise, a bundler banner and then the
 * errors. Only the last part identifies the defect, and the timeline needs it
 * short enough to read at a glance.
 */
function firstErrors(output: string, limit = 3): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\berror\b|\bError:/i.test(line) && !/^ELIFECYCLE/.test(line));

  if (lines.length === 0) return '';
  const shown = lines.slice(0, limit).join(' · ');
  const rest = lines.length - limit;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
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
