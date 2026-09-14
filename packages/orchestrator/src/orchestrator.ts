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
  SitePlan,
  ReplanSuccessorProvenance,
  type AgentTier,
  type ArtifactRef,
  type BrowserRenderAuthority,
  type JobSpec,
} from '@statxai/contracts';
import {
  ModelRuntime,
  type Provider,
} from '@statxai/agents';
import { BudgetExhausted, spend, type StateStore } from '@statxai/state';
import type { FrontendBackendBuildBindingDocument } from '@statxai/state';
import {
  ArtifactRegistry,
  ProjectWorkspace,
} from '@statxai/workspace';
import { JobEngine } from '@statxai/job-engine';
import {
  decideTerminal,
  isReleaseBlocked,
  terminalForRefusal,
  type ReplanScope,
} from '@statxai/policy-engine';
import { concluded, withoutDelivery, type RunResult } from './phases/conclude.js';
import {
  assertNoActiveLineageForLegacyDirect,
  publishRecoveredRelease,
  rehydrateRecoveredRelease,
  resolvePostPromotionRecovery,
  type PostPromotionRecovery,
} from './run-recovery/frontend-backend.js';
import { buildFromPlan } from './phases/build.js';
import { discoverProject, validateIntake, type DiscoverResult } from './phases/discover.js';
import { adjudicateDefects } from './phases/adjudicate.js';
import { evaluateSite } from './phases/evaluate.js';
import { producePlan, revisePlan } from './phases/planning.js';
import { executeRepairs } from './phases/repair.js';
import { publishRelease } from './phases/publish.js';
import { seekRelease } from './phases/release.js';
import {
  createFrontendBackendLifecycleCoordinator,
  type FrontendBackendLifecycleCoordinator,
} from './job-lifecycle/frontend-backend.js';
import { createFrontendBackendJobSpec } from './job-specs/frontend-backend.js';
import {
  computeRunIntentHash,
  ensureSpecificationCommitted,
  finalizeBindingPromoted,
  findActivePreparedBinding,
  FrontendBackendBuildNotPublishable,
  releaseActiveLineage,
  parseStoredJobSpec,
  prepareFrontendBackendBuildBinding,
  rehydrateSpecificationFiles,
  verifyBindingConsistency,
  FrontendBackendBuildBindingConflict,
  FrontendBackendBuildBindingResumeStateMissing,
} from './run-binding/frontend-backend.js';
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
// Phase 5k moved this from an inline definition here into the module that
// now owns the whole specification-commit sequence — re-exported so no
// existing import site (`from '@statxai/orchestrator'` or this file
// directly) has to change.
export { RunProjectSpecificationWorkingTreeDirty } from './run-binding/frontend-backend.js';
import {
  blocking,
} from './defects.js';

/**
 * Which implementation executes the `frontend_backend` build boundary
 * (Phase 5j). `legacy_direct` is `buildFromPlan`, unchanged from before this
 * phase existed. `job_lifecycle` routes through Phase 5i — enqueue, the
 * real Terra handler, 5g-1, 5g-2, 5h — and requires a `promoted` result
 * before `runProject` continues past the build boundary; every other Phase
 * 5i outcome stops this invocation through the existing non-delivery exit,
 * never by falling back to `buildFromPlan`.
 */
export type FrontendBackendExecutionMode = 'legacy_direct' | 'job_lifecycle';

export interface RunOptions {
  projectId: string;
  intake: unknown;
  store: StateStore;
  workspacesRoot: string;
  autonomyMode?: 'full_autonomous' | 'supervised_autonomous' | 'human_in_the_loop';
  onProgress?: Progress;
  /**
   * The provider beneath the run's model runtime. Production never sets it —
   * the default provider is used — so this is the seam a test uses to drive
   * real skills through the real runtime without a network call.
   */
  modelProvider?: Provider;
  /**
   * Which implementation runs the `frontend_backend` build boundary.
   * Defaults to `'legacy_direct'` — Phase 5j establishes the cutover seam
   * without making `job_lifecycle` the production default. No caller in
   * this repository opts into it yet.
   */
  frontendBackendExecutionMode?: FrontendBackendExecutionMode;
  /**
   * Phase 5g-1's own disposable validation workspace root — required only
   * when `frontendBackendExecutionMode` is `'job_lifecycle'`, and never the
   * canonical `workspacesRoot`: 5g-1 creates and tears down a fresh
   * directory under this root for every validation, and doing that inside
   * the canonical project's own Git tree would leave temporary files in it.
   */
  validationWorkspacesRoot?: string;
}

export async function runProject(options: RunOptions): Promise<RunResult> {
  const { projectId, store, workspacesRoot } = options;
  const autonomyMode = options.autonomyMode ?? 'full_autonomous';
  const frontendBackendExecutionMode: FrontendBackendExecutionMode =
    options.frontendBackendExecutionMode ?? 'legacy_direct';
  if (frontendBackendExecutionMode === 'job_lifecycle' && !options.validationWorkspacesRoot) {
    throw new Error(
      'runProject: frontendBackendExecutionMode "job_lifecycle" requires validationWorkspacesRoot.',
    );
  }
  const report: Progress = options.onProgress ?? (() => {});
  const say: Progress = (event) => {
    chargePhase(event.phase);
    report(event);
  };

  /**
   * The run's one model runtime. It reports every successful invocation's usage
   * to `track` below exactly once — phases never report usage themselves, so a
   * model call cannot go unaccounted because a caller forgot, and a result
   * handed back from anywhere else cannot add to it.
   */
  const model = new ModelRuntime({
    onUsage: (event) => track(event.tier, event),
    ...(options.modelProvider !== undefined ? { provider: options.modelProvider } : {}),
  });
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

  // -- Phase 1: Discover (or, in job_lifecycle mode, resume) ----------------
  //
  // Deterministic, and everything it produces is returned rather than
  // assigned: the phase cannot report a run, so the decision about what an
  // unusable brief means to the caller stays here.
  //
  // Phase 5k: `legacy_direct` calls `discoverProject` exactly as it always
  // has — nothing below this comment changes for it. `job_lifecycle` runs
  // the same pure intake validation `discoverProject` itself runs (Phase
  // 4e's zero-side-effect guarantee for malformed/insufficient intake, kept
  // by construction since both call the one shared `validateIntake`) and
  // only *then* asks whether an active, unfinished build binding already
  // exists for this project — strictly before any of discovery's own
  // durable side effects (project reset, budget reset, profile
  // put/accept/materialise). A binding for a *different* logical request
  // fails closed immediately; a binding for the *same* request resumes by
  // rehydrating durable state directly, never by calling `discoverProject`
  // or `producePlan` at all.
  let discovery: DiscoverResult;
  /**
   * The exact promoted `frontend_backend` binding the canonical tree
   * currently implements — `B0`, then `B1` after a replan successor
   * promotes, and so on. Held explicitly rather than rediscovered as "the
   * newest promoted binding", which stops being the right answer the moment
   * a project has more than one generation.
   */
  let canonicalBuild: FrontendBackendBuildBindingDocument | null = null;
  // The promotion that made `canonicalBuild` canonical, as finalised — the in-memory binding predates that write.
  let canonicalPromotion: { promotionId: string | null; promotionCommitSha: string | null } | null = null;
  /**
   * The one `frontend_backend` lifecycle rig for this invocation, assigned at
   * the build boundary below and reused by a replan rebuild in the evaluate
   * loop. Hoisted rather than rebuilt there: two rigs would mean two
   * `JobRunner`s claiming the same role for the same project.
   */
  let lifecycleCoordinator: FrontendBackendLifecycleCoordinator | null = null;
  let activeBinding: FrontendBackendBuildBindingDocument | null = null;
  /**
   * Set only when this invocation continues a promoted build whose run never
   * finished (Phase 5q) — resolved from durable lineage authority before
   * discovery could reset anything, and `null` on every other path.
   */
  let recovered: PostPromotionRecovery | null = null;
  let resumedPlan: SitePlan | null = null;
  let resumedSpec: JobSpec | null = null;

  if (frontendBackendExecutionMode === 'job_lifecycle') {
    const validated = validateIntake(options.intake);

    if (!validated.ok) {
      // `discoverProject` is never called for this outcome, so its own
      // progress messages are reproduced here verbatim — an observer sees
      // the exact same two events either way.
      say({ phase: 'discover', detail: 'Validating intake against the canonical schema' });
      say({ phase: 'discover', detail: validated.reason, level: 'fail' });
      discovery = { ok: false, outcome: 'intake_insufficient' };
    } else {
      const runIntentHash = computeRunIntentHash({ projectId, profile: validated.profile });
      const existingBinding = await findActivePreparedBinding(store, projectId);

      if (existingBinding && existingBinding.runIntentHash !== runIntentHash) {
        // A different logical request is already mid-build for this
        // project. Fails closed here, before any discovery side effect —
        // the existing binding is never resumed silently, destroyed, or
        // raced past by starting a second one alongside it.
        throw new FrontendBackendBuildBindingConflict(projectId, existingBinding.runIntentHash, runIntentHash);
      }

      if (existingBinding) {
        say({ phase: 'discover', detail: 'Validating intake against the canonical schema' });
        say({
          phase: 'discover',
          detail: `${validated.profile.businessName} — ${validated.profile.services.length} services`,
          level: 'ok',
        });
        say({
          phase: 'discover',
          detail: `Resuming active frontend_backend build binding (job ${existingBinding.jobId})`,
          level: 'ok',
        });

        // The stored spec is authoritative for resume — never reconstructed
        // from the current factory, which a later deployment could have
        // changed. Re-proven consistent with the binding before either is
        // trusted.
        const spec = parseStoredJobSpec(existingBinding);
        verifyBindingConsistency(existingBinding, spec);

        // Exact bound refs, never "latest" — `resolve` throws if either is
        // missing, which is a platform/control-plane fault, not something
        // repaired by rerunning discovery or substituting a newer version.
        const profile = BusinessProfile.parse(await registry.resolve(projectId, existingBinding.businessProfile));
        const plan = SitePlan.parse(await registry.resolve(projectId, existingBinding.sitePlan));

        // Rehydrated, never recreated: a resume must not reset project
        // state or the model budget merely because the process restarted.
        const projectDoc = await store.projects.findOne({ _id: projectId });
        if (!projectDoc) {
          throw new FrontendBackendBuildBindingResumeStateMissing(projectId, existingBinding._id, 'project document');
        }
        const budgetDoc = await store.budgets.findOne({ _id: projectId });
        if (!budgetDoc) {
          throw new FrontendBackendBuildBindingResumeStateMissing(projectId, existingBinding._id, 'budget document');
        }

        const workspace = await ProjectWorkspace.open(projectId, workspacesRoot);

        activeBinding = existingBinding;
        resumedPlan = plan;
        resumedSpec = spec;
        discovery = {
          ok: true,
          profile,
          businessProfileRef: existingBinding.businessProfile,
          workspace,
          budgetLimits: budgetDoc.limits,
        };
      } else {
        // Phase 5q: nothing is mid-build, but a build that already promoted
        // may belong to a run that never finished. Asked here, before
        // discovery, whose first act is to delete the project document and its
        // budgets — and answered from durable lineage authority, never from
        // the run history.
        recovered = await resolvePostPromotionRecovery({ store, registry, workspacesRoot, projectId, runIntentHash });

        if (recovered) {
          say({ phase: 'discover', detail: 'Validating intake against the canonical schema' });
          say({
            phase: 'discover',
            detail: `${validated.profile.businessName} — ${validated.profile.services.length} services`,
            level: 'ok',
          });
          // Stable ids only — telemetry, never consulted to decide anything.
          say({
            phase: 'discover',
            detail:
              `Recovering unfinished run: lineage ${recovered.root._id}, canonical build ${recovered.tip._id}, ` +
              `promotion ${recovered.tip.promotionId}`,
            level: 'ok',
          });
          discovery = {
            ok: true,
            profile: recovered.profile,
            businessProfileRef: recovered.tip.businessProfile,
            workspace: recovered.workspace,
            budgetLimits: recovered.budgetLimits,
          };
        } else {
          // No active binding and no unfinished lineage: the fresh path,
          // identical to what `legacy_direct` always runs.
          discovery = await discoverProject({
            projectId,
            intake: options.intake,
            store,
            registry,
            workspacesRoot,
            autonomyMode,
            say,
          });
        }
      }
    }
  } else {
    // `legacy_direct` never writes a canonical workspace an unfinished
    // `job_lifecycle` lineage still owns. Malformed intake keeps reporting
    // itself first, with no read or side effect of any kind.
    if (validateIntake(options.intake).ok) await assertNoActiveLineageForLegacyDirect(store, projectId);
    discovery = await discoverProject({
      projectId,
      intake: options.intake,
      store,
      registry,
      workspacesRoot,
      autonomyMode,
      say,
    });
  }

  if (!discovery.ok) {
    // Nothing was built, so there is nothing to report but the telemetry spent
    // deciding that — which is why this exit is separate from `concluded`.
    return withoutDelivery(projectId, discovery.outcome, {
      usage: progress.usage,
      usageByTier: progress.usageByTier,
      phaseMs: progress.phaseMs,
    });
  }

  const { profile, businessProfileRef, workspace, budgetLimits } = discovery;

  if (recovered) {
    // Derived, not remembered. A review cycle is counted exactly when its
    // rejection allowance is spent — that spend is the counter's only writer —
    // so the durable budget is the cycle. Replans are informational only; the
    // durable count is their conservative equivalent.
    progress.reviewCycle = recovered.budgetUsed.reviewRejections;
    progress.replansUsed = recovered.budgetUsed.replans;
  }

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
  const deps: RunDeps = { store, registry, workspace, model, say };
  const facts: RunFacts = { projectId, profile, autonomyMode, budgetLimits };

  // -- Phase 2: Plan (or, resuming, the exact bound plan) --------------------
  // One immutable local either way — resuming never re-invokes Sol or
  // persists another plan version; it substitutes the exact plan this
  // build binding was already prepared against, in `producePlan`'s own
  // returned shape, so the destructuring below is identical regardless of
  // which source it came from.
  const { plan: initialPlan, sitePlanRef: initialSitePlanRef } = activeBinding
    ? { plan: resumedPlan!, sitePlanRef: activeBinding.sitePlan }
    : recovered
      ? { plan: recovered.plan, sitePlanRef: recovered.tip.sitePlan }
      : await producePlan({ deps, facts }, 0);
  progress.plan = initialPlan;
  // The exact plan version every evaluation of this run renders against — updated only when a replan replaces the plan.
  let currentSitePlanRef: ArtifactRef = initialSitePlanRef;

  // Defined here, not after the build boundary: Phase 5j's job-mode exit
  // needs a `RunContext` to report through `concluded` the same way every
  // other non-delivery exit past this point already does, and `progress.plan`
  // is set above, so `ctx()` is safe to call from either build path.
  const ctx = (): RunContext => ({ deps, facts, progress: snapshotProgress(progress) });

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

  if (frontendBackendExecutionMode === 'job_lifecycle') {
    // Phase 5j: the same build boundary, routed through Phase 5i instead of
    // `buildFromPlan`. Constructed only here, never for `legacy_direct` — no
    // `JobEngine`, no lifecycle coordinator, no job inspected or enqueued on
    // the legacy path.
    const engine = new JobEngine(store);
    const coordinator = (lifecycleCoordinator = createFrontendBackendLifecycleCoordinator({
      store,
      registry,
      engine,
      model,
      // Harness-owned identity, never derived from intake, model output, or
      // the plan — one worker identity per project, fixed by this call site.
      workerIdentity: { workerId: `run-project:${projectId}:frontend-backend`, tier: 'terra' },
      workspacesRoot,
      validationWorkspacesRoot: options.validationWorkspacesRoot!,
      say,
    }));

    if (recovered) {
      // Phase 5q: the build already promoted and was just re-proven; nothing
      // here is built, validated, accepted or promoted again. The coordinator
      // above still exists, for any replan evaluation leads to.
      canonicalBuild = recovered.tip;
      canonicalPromotion = { promotionId: recovered.tip.promotionId, promotionCommitSha: recovered.tip.promotionCommitSha };
      say({ phase: 'build', detail: `Continuing promoted frontend_backend build ${recovered.tip._id}`, level: 'ok' });
    } else {
      // Phase 5k: on resume, the stored spec is authority — the factory is
      // never called again, and its output is never treated as though it
      // were. On the fresh path, the factory is still the one source of the
      // exact `JobSpec`, and a durable binding is prepared for it before
      // Phase 5i ever runs.
      let spec: JobSpec;
      let binding: FrontendBackendBuildBindingDocument;
      if (activeBinding) {
        spec = resumedSpec!;
        binding = activeBinding;
      } else {
        spec = createFrontendBackendJobSpec({
          projectId,
          businessProfileRef,
          sitePlanRef: initialSitePlanRef,
        });
        binding = await prepareFrontendBackendBuildBinding(store, {
          projectId,
          runIntentHash: computeRunIntentHash({ projectId, profile }),
          businessProfileRef,
          sitePlanRef: initialSitePlanRef,
          jobSpec: spec,
          // Canonical HEAD *before* the specification commit below — `null`
          // is a legitimate first-ever commit, not a placeholder.
          specificationBaseCommit: await workspace.currentCommit(),
        });
      }

      // Mirrors `buildFromPlan`'s own first write: the outer project-state
      // transition belongs to `runProject`, the harness/run owner, not to the
      // job handler or Phase 5i, neither of which touches project state at all.
      await store.projects.updateOne(
        { _id: projectId },
        { $set: { state: 'building', updatedAt: new Date() } },
      );

      if (activeBinding) {
        // Discovery/planning never ran this invocation, so the bound
        // specification never touched this process's canonical workspace —
        // re-materialise it idempotently before the replay-safe commit below
        // can find (or create) anything. A no-op if it is already there.
        await rehydrateSpecificationFiles(workspace, profile, initialPlan);
      }

      // Replay-safe, marker-aware handoff — see `run-binding/frontend-backend.ts`
      // for the full recovery sequence (Phase 5h's own promotion pattern,
      // applied one step earlier in the pipeline). No site file is touched
      // here either way: `writeSiteFiles`/`publishBuildDirectly` are never
      // called from this branch, only 5h's own promotion writes `app/`.
      await ensureSpecificationCommitted(store, workspace, binding, initialPlan);

      say({
        phase: 'build',
        detail: activeBinding
          ? `Resuming frontend_backend via job_lifecycle (job ${spec.jobId})`
          : `Executing frontend_backend via job_lifecycle (job ${spec.jobId})`,
      });

      // Exactly one call. Every outcome but `promoted` stops this invocation
      // through the existing non-delivery exit below — never a second call,
      // never a fallback to `buildFromPlan`.
      const result = await coordinator.run(spec);

      if (result.outcome !== 'promoted') {
        say({
          phase: 'build',
          detail: `frontend_backend job_lifecycle build did not complete this invocation (${result.outcome})`,
          level: 'fail',
        });
        // `RunResult.outcome` has no vocabulary for "not yet promoted" beyond
        // the existing `'blocked'` bucket (see docs/upgrade-status.md's Phase
        // 5j section for why a broader outcome hierarchy was not added).
        // `jobLifecycleOutcome` carries the exact Phase 5i outcome alongside
        // it, so this never collapses "retry_ready" and "validation_failed"
        // into an indistinguishable "blocked" — the bucket is the same, but
        // what actually happened is not lost. No `terminalDecision` is set:
        // no policy adjudication occurred here. The binding is deliberately
        // left `prepared` — a later invocation must be able to resume it.
        return { ...(await concluded(ctx(), 'blocked', undefined)), jobLifecycleOutcome: result.outcome };
      }

      // Finalised only after Phase 5i itself reports `promoted` — never
      // speculatively. If this write fails, the promotion itself is not
      // undone and the binding stays `prepared`; a later invocation resumes
      // it, replays Phase 5i (a pure read-and-verify at that point), and
      // retries only this finalisation.
      await finalizeBindingPromoted(store, binding._id, {
        promotionId: result.promotionId,
        promotionCommitSha: result.commitSha,
      });

      // Canonical build authority, advanced only here. A replan successor
      // becomes canonical when its own promotion succeeds, never when it is
      // merely prepared, built, validated or accepted — until then the
      // predecessor is still what the canonical tree implements.
      canonicalBuild = binding;
      canonicalPromotion = { promotionId: result.promotionId, promotionCommitSha: result.commitSha };

      say({ phase: 'build', detail: `frontend_backend promoted: commit ${result.commitSha}`, level: 'ok' });
    }
  } else {
    await buildFromPlan({ deps, facts }, initialPlan);
  }

  /**
   * Phase 5q: a release this lineage already started is stronger authority than
   * a fresh evaluation. Continued through Phase 5p exactly as it stands — no
   * evaluation, approval or new authorisation — so a `publishing` receipt still
   * stops for an operator and a `committed` one finishes without deploying.
   */
  if (recovered?.publication) {
    const release = await rehydrateRecoveredRelease(registry, projectId, recovered.publication);
    progress.authorization = release.authorization;
    progress.releaseAuthorizationRef = release.releaseAuthorizationRef;
    progress.qualityScore = release.qualityScore;
    progress.gatesCertified = release.gatesCertified;
    progress.approvalArtifactVersion = release.approvalArtifactVersion;
    progress.approvalModel = release.approvalModel;
    progress.approvalDecision = release.approvalDecision;

    const { manifest, finalCommit } = await publishRecoveredRelease(ctx(), release, recovered.tip._id);
    return { ...(await concluded(ctx(), 'released', undefined)), commit: finalCommit, manifest };
  }

  // -- Phases 4/5: Evaluate, repair, escalate -------------------------------

  /**
   * What made the tree being evaluated canonical, exactly. In job_lifecycle mode
   * every route here promoted a canonical build; legacy_direct has no binding and
   * says so rather than inventing one.
   */
  const renderAuthority = (): BrowserRenderAuthority => {
    if (frontendBackendExecutionMode !== 'job_lifecycle') return { mode: 'legacy_direct' };
    if (!canonicalBuild) {
      throw new FrontendBackendBuildNotPublishable('(none)', 'this job_lifecycle run holds no canonical build to evaluate');
    }
    return {
      mode: 'job_lifecycle',
      buildBindingId: canonicalBuild._id,
      promotionId: canonicalPromotion?.promotionId ?? canonicalBuild.promotionId,
      promotionCommitSha: canonicalPromotion?.promotionCommitSha ?? canonicalBuild.promotionCommitSha,
    };
  };


  while (true) {
    const evaluation = await evaluateSite(ctx(), { sitePlan: currentSitePlanRef, authority: renderAuthority() });

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
        visualReview: evaluation.visualQualityReview,
        openNonBlocking: progress.openDefects.filter((d) => d.severity !== 'P0' && d.severity !== 'P1'),
      });

      progress.authorization = release.decision;
      progress.releaseAuthorizationRef = release.authorizationRef;
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

    const decided = await adjudicateDefects(ctx(), mustFix, { gateRun, reviewSummary, visualReview: evaluation.visualQualityReview });
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

      progress.replansUsed += 1;
      progress.plan = revised.plan;
      currentSitePlanRef = revised.sitePlanRef;

      if (frontendBackendExecutionMode === 'job_lifecycle' && canonicalBuild && lifecycleCoordinator) {
        /**
         * A replanned rebuild is a new request from a new plan version, and
         * it earns the same durable authority the initial build has: a
         * successor binding naming the exact predecessor it replaces and the
         * exact decision that authorised it, then the ordinary lifecycle —
         * Terra, isolated validation, guarded acceptance, the promotion
         * fence, and canonical promotion.
         *
         * No `clearSite()` here, and that is the point of the whole slice:
         * the canonical tree keeps implementing the predecessor while the
         * successor is built and validated somewhere else, and promotion
         * replaces it exactly — removing the routes this revision dropped —
         * only once the candidate has been accepted.
         */
        const successorSpec = createFrontendBackendJobSpec({
          projectId,
          businessProfileRef,
          sitePlanRef: revised.sitePlanRef,
        });
        const successor = await prepareFrontendBackendBuildBinding(store, {
          projectId,
          runIntentHash: computeRunIntentHash({ projectId, profile }),
          businessProfileRef,
          sitePlanRef: revised.sitePlanRef,
          jobSpec: successorSpec,
          specificationBaseCommit: await workspace.currentCommit(),
          lineage: {
            predecessorBindingId: canonicalBuild._id,
            // Parsed, not cast: the registry's ref is proven to name a replan decision.
            provenance: ReplanSuccessorProvenance.parse({ kind: 'replan', replanDecision: revised.replanDecisionRef }),
          },
        });

        await store.projects.updateOne(
          { _id: projectId },
          { $set: { state: 'building', updatedAt: new Date() } },
        );

        // The revised specification has to exist on disk before the
        // replay-safe specification commit can find or create it.
        await rehydrateSpecificationFiles(workspace, profile, revised.plan);

        // Adjudication and the revision itself materialise their own records
        // before this point; they are this run's own harness-written evidence,
        // not a foreign change, so the specification commit expects them.
        const harnessRecords = (await workspace.dirtyPaths()).filter((p) => p.startsWith('decisions/'));
        await ensureSpecificationCommitted(store, workspace, successor, revised.plan, harnessRecords);

        say({
          phase: 'build',
          detail: `Rebuilding frontend_backend via job_lifecycle after replan (job ${successorSpec.jobId})`,
        });

        const rebuilt = await lifecycleCoordinator.run(successorSpec, {
          kind: 'replan',
          reviewCycle: progress.reviewCycle,
        });

        if (rebuilt.outcome !== 'promoted') {
          say({
            phase: 'build',
            detail: `frontend_backend replan rebuild did not complete this invocation (${rebuilt.outcome})`,
            level: 'fail',
          });
          // Canonical authority stays on the predecessor: an unpromoted
          // successor never becomes what the tree implements.
          return { ...(await concluded(ctx(), 'blocked', undefined)), jobLifecycleOutcome: rebuilt.outcome };
        }

        await finalizeBindingPromoted(store, successor._id, {
          promotionId: rebuilt.promotionId,
          promotionCommitSha: rebuilt.commitSha,
        });
        canonicalBuild = successor;
        canonicalPromotion = { promotionId: rebuilt.promotionId, promotionCommitSha: rebuilt.commitSha };

        say({ phase: 'build', detail: `frontend_backend replan promoted: commit ${rebuilt.commitSha}`, level: 'ok' });
        progress.repairedSinceReview = [];
        continue;
      }

      // `legacy_direct` (and any job-mode run with no promoted predecessor to
      // replace) keeps the original direct rebuild, unchanged.
      await workspace.clearSite();
      await buildFromPlan(ctx(), revised.plan);
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
    // Durably terminal, so the build lineage that owned this project releases
    // it in the very transaction that records the terminal state — one atomic
    // fact rather than two writes a crash could separate.
    await store.withTransaction(async (session) => {
      await store.projects.updateOne(
        { _id: projectId },
        { $set: { state: 'blocked', updatedAt: new Date() } },
        { session },
      );
      await releaseActiveLineage(store, projectId, { session });
    });
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
      // Terminal, and released atomically with it — unlike the
      // `awaiting_human_review` branch above, which is a run parked for a
      // person rather than a finished one, and deliberately keeps ownership.
      await store.withTransaction(async (session) => {
        await store.projects.updateOne(
          { _id: projectId },
          { $set: { state: 'blocked', updatedAt: new Date() } },
          { session },
        );
        await releaseActiveLineage(store, projectId, { session });
      });
    }

    // Mapped from the authorisation, not from the defect list. A refusal here
    // happens with no blocking defects outstanding, which is exactly when
    // `decideTerminal` prefers `accept_non_blocking` — so borrowing it reported
    // a denied release as an acceptance.
    return concluded(ctx(), 'blocked', terminalForRefusal(progress.authorization?.action ?? null));
  }

  // A `job_lifecycle` release always names the exact canonical build it
  // publishes; every route to this point in that mode promoted one. Refused
  // rather than published unlinked if that ever stops being true.
  if (frontendBackendExecutionMode === 'job_lifecycle' && !canonicalBuild) {
    throw new FrontendBackendBuildNotPublishable('(none)', 'this job_lifecycle run holds no canonical build to publish');
  }

  const { manifest, finalCommit } = await publishRelease(ctx(), progress.authorization, {
    // Non-null on every path that reaches publication: the guard above proves
    // an authorisation exists, and `seekRelease` writes the artifact the
    // authorisation came from before returning it.
    releaseAuthorizationRef: progress.releaseAuthorizationRef!,
    ...(canonicalBuild ? { canonicalBuildBindingId: canonicalBuild._id } : {}),
  });

  return { ...(await concluded(ctx(), 'released', undefined)), commit: finalCommit, manifest };
}
