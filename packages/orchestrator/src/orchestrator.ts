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
  HOME_ROUTE,
  routeToOutputPath,
  routeToSourcePath,
  intakeGaps,
  isReleaseBlocked,
  legalTerminalOutcomes,
  type AgentTier,
  type DeploymentManifest,
  type SitePlan,
  type SolApprovalRecommendation,
  type TerminalOutcome,
} from '@statxai/contracts';
import {
  buildAnchor,
  buildPage,
  buildSite,
  ModelClient,
  planSite,
  repairDefect,
  routeBuild,
  reviewSite,
  type UsageByTier,
} from '@statxai/agents';
import { isFrameworkPage, runGates } from '@statxai/gates';
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
import { adjudicate, recommendApproval, replanSite } from '@statxai/agents';
import {
  authorizeAdjudication,
  fallbackAction,
  firstBlocker,
  legalAdjudicationActions,
  type AdjudicationAuthorization,
  type AdjudicationConstraints,
  type AdjudicationRecord,
} from './adjudication.js';
import {
  authorizeRelease,
  RELEASE_POLICY_VERSION,
  verifyAcknowledged,
  type ApprovalRecord,
  type AuthorizationRecord,
  type ReleaseAuthorization,
  type ReleaseEvidence,
} from './release.js';
import {
  isEmptyDelta,
  planDelta,
  scopeViolations,
  type ReplanRecord,
  type ReplanScope,
} from './replanning.js';
import {
  authorizeRoute,
  developerOverride,
  executeRoute,
  permittedStrategies,
  type RouteDecisionRecord,
  type RoutingAuthorization,
} from './routing.js';
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
  usageByTier: UsageByTier;
  phaseMs: Record<string, number>;
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
    track('sol', planned);
    const produced = planned.value;

    say({
      phase: 'plan',
      detail: `${produced.sitemap.pages.length} pages, ${produced.acceptanceCriteria.length} acceptance criteria (${planned.model}, ${(planned.ms / 1000).toFixed(1)}s)`,
      level: 'ok',
    });

    await persistPlan(produced);
    return produced;
  }

  /**
   * Store a plan as the next version of `site-plan`.
   *
   * Shared by the initial plan and by every revision, so a replan appends to
   * the history rather than overwriting it: the plan that failed stays readable
   * next to the one that replaced it, which is what makes the audit trail —
   * plan v1 → evidence → adjudication → replan decision → plan v2 —
   * reconstructable.
   */
  async function persistPlan(produced: SitePlan): Promise<void> {
    const ref = await registry.put(projectId, 'site-plan', produced);
    await registry.accept(projectId, ref);
    await workspace.materialiseArtifact('design/brand-system.json', produced.brandSystem);
    await workspace.materialiseArtifact('specs/sitemap.json', produced.sitemap);
    for (const page of produced.sitemap.pages) {
      const slug = page.route === HOME_ROUTE ? 'home' : page.route.replace(/^\//, '').replace(/\//g, '_');
      await workspace.materialiseArtifact(`specs/pages/${slug}.json`, page);
    }
  }

  let plan = await producePlan(0);

  /**
   * Revise the failed specification, or return null.
   *
   * Everything the revision needs is passed as a structured runtime value —
   * the plan object itself, the open defects, the gate findings, the repair
   * outcomes — rather than reconstructed from progress prose after the fact.
   *
   * Returns null when Sol cannot be consulted or its answer does not satisfy
   * its contract. The caller stops rather than regenerating: falling back to
   * the planner would reinstate the defect this replaces.
   */
  async function revisePlan(context: {
    scope: ReplanScope;
    adjudicationReason: string;
    unresolvedDefects: readonly Defect[];
    gateFindings: readonly string[];
    reviewSummary: string | null;
  }): Promise<SitePlan | null> {
    const budget = (await store.budgets.findOne({ _id: projectId }))!;

    // Versions are read before the new ones are written, so the record points
    // at what this revision actually came from.
    const previousPlanDoc = await store.artifacts.findOne(
      { projectId, name: 'site-plan' },
      { sort: { version: -1 } },
    );
    const adjudicationDoc = await store.artifacts.findOne(
      { projectId, name: 'adjudication-decision' },
      { sort: { version: -1 } },
    );

    say({
      phase: 'replan',
      detail: `Sol is revising the specification (scope ${context.scope}, ${context.unresolvedDefects.length} unresolved)`,
    });

    const record: ReplanRecord = {
      reviewCycle,
      previousPlanVersion: previousPlanDoc?.version ?? null,
      adjudicationVersion: adjudicationDoc?.version ?? null,
      adjudicationReason: context.adjudicationReason,
      scope: context.scope,
      failureDiagnosis: null,
      changes: [],
      preservedAreas: [],
      delta: null,
      scopeViolations: [],
      rejected: null,
      model: null,
      modelFailure: null,
      decidedAt: new Date(),
    };

    let revisedPlan: SitePlan | null = null;

    try {
      const replanned = await replanSite(model, {
        profile,
        reviewCycle,
        previousPlan: plan,
        adjudicationReason: context.adjudicationReason,
        scope: context.scope,
        unresolvedDefects: context.unresolvedDefects.map((d) => ({
          id: d.id,
          category: d.category,
          severity: d.severity,
          location: d.location,
          reason: d.reason,
        })),
        gateFindings: [...context.gateFindings],
        reviewSummary: context.reviewSummary,
        repairHistory: [...repairHistory],
        remainingBudgets: {
          totalRepairJobs: budget.limits.totalRepairJobs - budget.used.totalRepairJobs,
          replans: budget.limits.replans - budget.used.replans,
          reviewRejections: budget.limits.reviewRejections - budget.used.reviewRejections,
        },
      });
      track('sol', replanned);

      revisedPlan = replanned.value.revisedPlan;
      record.model = replanned.model;
      record.failureDiagnosis = replanned.value.failureDiagnosis;
      record.changes = replanned.value.changes;
      record.preservedAreas = replanned.value.preservedAreas;
      record.delta = planDelta(plan, revisedPlan);
      record.scopeViolations = scopeViolations(context.scope, record.delta);
    } catch (error) {
      record.modelFailure = error instanceof Error ? error.message : String(error);
    }

    /**
     * Two objective reasons to refuse a revision that parsed cleanly.
     *
     * A scope violation is not a narrow revision that went slightly wide: it is
     * a different decision from the one adjudication authorised, and executing
     * it would let the requested scope mean nothing.
     *
     * An empty delta means Sol reported changes the plan does not contain.
     * Rebuilding from it would reproduce the site that just failed, spend the
     * cycle, and arrive at the same defects.
     *
     * Either way the decision is still persisted — a refused revision is part
     * of the history — but the plan is not activated, the site is not cleared,
     * and Sol is not called again.
     */
    if (revisedPlan && record.scopeViolations.length > 0) {
      record.rejected = `Revision exceeded the "${record.scope}" scope it was authorised for.`;
      revisedPlan = null;
    } else if (revisedPlan && record.delta && isEmptyDelta(record.delta)) {
      record.rejected =
        `Sol reported ${record.changes.length} change(s), but the revised plan is ` +
        'identical to the one that failed.';
      revisedPlan = null;
    }

    const ref = await registry.put(projectId, 'replan-decision', record);
    await registry.accept(projectId, ref);
    await workspace.materialiseArtifact(
      `decisions/replan-${String(reviewCycle).padStart(2, '0')}.json`,
      record,
    );

    if (record.modelFailure) {
      say({
        phase: 'replan',
        detail: `Sol could not revise the specification: ${record.modelFailure}`,
        level: 'fail',
      });
      return null;
    }

    if (record.rejected) {
      for (const violation of record.scopeViolations) {
        say({ phase: 'replan', detail: `Scope exceeded — ${violation}`, level: 'fail' });
      }
      say({ phase: 'replan', detail: `Revision refused: ${record.rejected}`, level: 'fail' });
      return null;
    }

    // A new version of site-plan, never an overwrite: the plan that failed
    // stays readable next to the one that replaced it. Reached only by a
    // revision the harness accepted.
    await persistPlan(revisedPlan!);

    const d = record.delta!;
    say({
      phase: 'replan',
      detail:
        `${record.changes.length} change(s): ` +
        `+${d.routesAdded.length}/-${d.routesRemoved.length}/~${d.routesRevised.length} routes` +
        `${d.brandChanged ? ', brand revised' : ''} — ${record.failureDiagnosis}`,
      level: 'ok',
    });

    return revisedPlan;
  }

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
  async function recordRoute(
    authorization: RoutingAuthorization,
    proposed: RouteDecisionRecord['proposed'],
    modelFailure: string | null,
  ): Promise<void> {
    const record: RouteDecisionRecord = {
      strategy: authorization.strategy,
      source: authorization.source,
      refusal: authorization.refusal,
      proposed,
      modelFailure,
      decidedAt: new Date(),
    };
    const ref = await registry.put(projectId, 'route-decision', record);
    await registry.accept(projectId, ref);
    await workspace.materialiseArtifact('decisions/route-decision.json', record);
  }

  /** Persist an adjudication outcome as a versioned artifact. */
  async function recordAdjudication(record: AdjudicationRecord): Promise<void> {
    const ref = await registry.put(projectId, 'adjudication-decision', record);
    await registry.accept(projectId, ref);
    await workspace.materialiseArtifact(
      `decisions/adjudication-${String(record.reviewCycle).padStart(2, '0')}.json`,
      record,
    );
  }

  async function decideStrategy(current: SitePlan): Promise<RoutingAuthorization> {
    const override = developerOverride();
    const permitted = permittedStrategies(current);

    let authorization: RoutingAuthorization;
    let proposed: RouteDecisionRecord['proposed'] = null;
    let modelFailure: string | null = null;

    try {
      const routed = await routeBuild(model, profile, current, {
        pageCount: current.sitemap.pages.length,
        sectionCount: current.sitemap.pages.reduce((n, p) => n + p.sections.length, 0),
        serviceCount: profile.services.length,
        permittedStrategies: permitted,
      });
      track('sol', routed);

      proposed = {
        action: routed.value.action,
        reason: routed.value.reason,
        confidence: routed.value.confidence,
        workstreams: routed.value.workstreams ?? [],
      };
      authorization = authorizeRoute(routed.value, current, override);
    } catch (error) {
      /**
       * Routing is a preference between two working paths, so a model failure
       * must not end a delivery. The run falls back to the documented default
       * and says so; it does not silently behave as though Sol had chosen.
       */
      modelFailure = error instanceof Error ? error.message : String(error);
      authorization = {
        strategy: override ?? 'one_shot',
        source: override ? 'developer-override' : 'fallback',
        refusal: `Sol could not be consulted: ${modelFailure}`,
      };
    }

    await recordRoute(authorization, proposed, modelFailure);

    say({
      phase: 'build',
      detail:
        authorization.source === 'sol'
          ? `Sol routed to ${authorization.strategy} (confidence ${proposed?.confidence.toFixed(2) ?? '—'}): ${proposed?.reason ?? ''}`
          : `${authorization.strategy} by ${authorization.source} — ${authorization.refusal ?? ''}`,
      level: authorization.source === 'sol' ? 'ok' : 'warn',
    });

    return authorization;
  }

  /**
   * One call writes the whole site.
   *
   * Coherent by construction: the layout, the brand tokens and every page come
   * out of one response, so the navigation, spacing and component vocabulary
   * cannot drift between pages. It fails when the site does not fit the output
   * ceiling, which is a genuine runtime failure and is handled as one.
   */
  async function executeOneShot(current: SitePlan): Promise<void> {
    say({ phase: 'build', detail: 'Terra is attempting the complete site in one pass' });

    const built = await buildSite(model, profile, current);
    track('terra', built);
    await workspace.writeSiteFiles(built.value.files);

    say({
      phase: 'build',
      detail: `One-shot succeeded: ${built.value.files.length} files (${built.model}, ${(built.ms / 1000).toFixed(1)}s, ${built.outputTokens} out)`,
      level: 'ok',
    });
  }

  /**
   * An anchor, then the remaining pages in parallel against it.
   *
   * Each call stays well below the output ceiling, at the cost of later pages
   * being built to match a reference rather than written alongside it.
   */
  async function executeDecomposed(current: SitePlan): Promise<void> {
    const anchor = await buildAnchor(model, profile, current);
    track('terra', anchor);
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
      track('terra', page);
      await workspace.writeSiteFiles(page.value.files);
    }
    say({ phase: 'build', detail: `${rest.length} further pages built in parallel`, level: 'ok' });
  }

  async function buildFromPlan(current: SitePlan): Promise<void> {
    await store.projects.updateOne({ _id: projectId }, { $set: { state: 'building', updatedAt: new Date() } });

    // The scaffold carries the toolchain, the dependency set and the shadcn
    // primitives. Terra writes pages against it and never installs anything, so
    // a build failure is always about the site rather than the toolchain.
    await scaffoldSite(workspace.siteRoot);

    /**
     * The accepted route is executed directly.
     *
     * Decomposition used to be reached by throwing
     * `MalformedModelOutput('forced: output truncated')` so the truncation
     * handler would catch it. That made a deliberate strategy and a runtime
     * failure the same code path, and indistinguishable afterwards. Each
     * strategy now has its own function and its own call.
     */
    const route = await decideStrategy(current);

    await executeRoute(route, current, {
      oneShot: () => executeOneShot(current),
      decomposed: async () => {
        say({
          phase: 'build',
          detail: 'Building by decomposition: anchor first, then pages in parallel',
        });
        await executeDecomposed(current);
      },
      onRecovery: async (error) => {
        say({
          phase: 'build',
          detail: 'One-shot exceeded the output ceiling — recovering by decomposition',
          level: 'warn',
        });
        // A further version of the same artifact, so the trail reads "Sol chose
        // one-shot, then the harness recovered" rather than implying that
        // decomposition had been chosen.
        await recordRoute(
          {
            strategy: 'decompose',
            source: 'truncation-recovery',
            refusal: `One-shot exceeded the output ceiling: ${error instanceof Error ? error.message : String(error)}`,
          },
          null,
          null,
        );
      },
    });

    await workspace.commit('Terra: build');
  }

  await buildFromPlan(plan);

  /**
   * Sol judges the release; the harness decides it.
   *
   * Two artifacts, in that order, because the trail has to be able to show a
   * recommendation and an authorisation that disagree. Deployment is reachable
   * only through the authorisation this returns.
   */
  async function seekRelease(context: {
    gateRun: { passed: boolean; findings: { severity: string; gate: string; location: string; message: string }[]; gatesRun: string[] };
    buildOk: boolean;
    buildSummary: string;
    reviewSummary: string | null;
    openNonBlocking: readonly Defect[];
  }): Promise<ReleaseAuthorization> {
    const planDoc = await store.artifacts.findOne({ projectId, name: 'site-plan' }, { sort: { version: -1 } });
    const reportDoc = await store.artifacts.findOne({ projectId, name: 'test-report' }, { sort: { version: -1 } });
    const reviewDoc = await store.artifacts.findOne({ projectId, name: 'visual-review' }, { sort: { version: -1 } });

    const evidence: ReleaseEvidence = {
      blockingDefects: 0,
      buildSucceeded: context.buildOk,
      gatesPassed: context.gateRun.passed,
      autonomyMode,
      deploymentConfigured: deploymentConfigured(),
    };

    const record: ApprovalRecord = {
      reviewCycle,
      sitePlanVersion: planDoc?.version ?? null,
      testReportVersion: reportDoc?.version ?? null,
      visualReviewVersion: reviewDoc?.version ?? null,
      recommendation: null,
      reason: null,
      acknowledgedIssues: [],
      unverifiableIssues: [],
      model: null,
      modelFailure: null,
      decidedAt: new Date(),
    };

    let recommendation: SolApprovalRecommendation | null = null;

    try {
      const recommended = await recommendApproval(model, {
        reviewCycle,
        plan,
        profile,
        qualityScore,
        blockingCount: 0,
        gatesRun: context.gateRun.gatesRun,
        gateFindings: context.gateRun.findings.map(
          (f) => `${f.severity} ${f.gate} ${f.location} — ${f.message}`,
        ),
        buildSummary: context.buildSummary,
        reviewSummary: context.reviewSummary,
        openNonBlocking: context.openNonBlocking.map((d) => ({
          id: d.id,
          severity: d.severity,
          category: d.category,
          location: d.location,
          reason: d.reason,
        })),
        repairHistory: repairHistory.map((r) => ({ defectId: r.defectId, outcome: r.outcome })),
        replanCount: replansUsed,
        autonomyMode,
        releasePolicy: {
          'blocking defects permitted': '0, not waivable',
          'gates must pass': 'yes',
          'autonomy mode': autonomyMode,
          'deployment configured': String(deploymentConfigured()),
          'authorised by': RELEASE_POLICY_VERSION,
        },
      });
      track('sol', recommended);

      recommendation = recommended.value;
      const checked = verifyAcknowledged(recommended.value.acknowledgedIssues, context.openNonBlocking);

      record.model = recommended.model;
      record.recommendation = recommended.value.recommendation;
      record.reason = recommended.value.reason;
      record.acknowledgedIssues = checked.known;
      record.unverifiableIssues = checked.unknown;

      say({
        phase: 'approve',
        detail: `Sol recommends ${recommended.value.recommendation}: ${recommended.value.reason}`,
        level: recommended.value.recommendation === 'accept' ? 'ok' : 'warn',
      });

      if (checked.unknown.length > 0) {
        // Recorded rather than treated as considered: an id nothing matches may
        // be a stale reference or an invention, and either way it is not
        // evidence that an issue was seen and judged acceptable.
        say({
          phase: 'approve',
          detail: `Acknowledged issues that match nothing open: ${checked.unknown.join(', ')}`,
          level: 'warn',
        });
      }
    } catch (error) {
      // A missing recommendation is not an approval, and the harness does not
      // write one on Sol's behalf.
      record.modelFailure = error instanceof Error ? error.message : String(error);
      say({
        phase: 'approve',
        detail: `Sol could not be consulted on release: ${record.modelFailure}`,
        level: 'fail',
      });
    }

    const approvalRef = await registry.put(projectId, 'approval-recommendation', record);
    await registry.accept(projectId, approvalRef);
    await workspace.materialiseArtifact(
      `decisions/approval-${String(reviewCycle).padStart(2, '0')}.json`,
      record,
    );

    const approvalDoc = await store.artifacts.findOne(
      { projectId, name: 'approval-recommendation' },
      { sort: { version: -1 } },
    );

    // The harness decides, having read the recommendation as one input among
    // the deterministic facts it checked for itself.
    const decision = authorizeRelease({ recommendation, evidence });

    const authorizationRecord: AuthorizationRecord = {
      reviewCycle,
      recommendationVersion: approvalDoc?.version ?? null,
      recommendation: record.recommendation,
      evidence,
      authorized: decision.authorized,
      action: decision.action,
      reason: decision.reason,
      policyVersion: decision.policyVersion,
      authorizedBy: 'harness-policy',
      authorizedAt: new Date(),
    };
    const authRef = await registry.put(projectId, 'release-authorization', authorizationRecord);
    await registry.accept(projectId, authRef);
    await workspace.materialiseArtifact(
      `decisions/release-authorization-${String(reviewCycle).padStart(2, '0')}.json`,
      authorizationRecord,
    );

    approvalArtifactVersion = approvalDoc?.version ?? null;
    approvalModel = record.model;

    return decision;
  }

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

    // Carried into adjudication so Sol sees the reviewer's verdict, not just
    // the defects it produced.
    let reviewSummary: string | null = null;

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
        // The reviewer judges the same pages the gates judge. Handing it the
        // framework's own error pages invites a rejection nothing can repair.
        const reviewable = files.filter((f) => !isFrameworkPage(f.path));
        reviewed = await reviewSite(model, profile, plan, reviewable, reviewCycle, repairedSinceReview);
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
      track('terra', reviewed);
      qualityScore = reviewed.value.qualityScore;

      const reviewDefects = reviewed.value.issues.map(fromReviewIssue);
      defects = [...gateDefects, ...reviewDefects];

      await registry.put(projectId, 'visual-review', {
        ...reviewed.value,
        reviewer: { tier: 'terra', model: reviewed.model, skillVersion: 'terra-review@1' },
        reviewCycle,
      });

      reviewSummary =
        `  decision ${reviewed.value.decision}, quality ${qualityScore}, blocking=${reviewed.value.blocking}\n` +
        reviewed.value.issues
          .map((i) => `  ${i.severity} ${i.category} ${i.location} — ${i.reason}`)
          .join('\n');

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
      /**
       * Nothing blocking remains, so the question becomes whether to release —
       * which is two questions, asked in order. Sol judges; the harness decides.
       */
      say({ phase: 'approve', detail: 'No blocking criteria outstanding — asking Sol to judge release' });

      authorization = await seekRelease({
        gateRun,
        buildOk: compiled.ok,
        buildSummary: compiled.ok
          ? `succeeded in ${(compiled.durationMs / 1000).toFixed(1)}s`
          : 'failed',
        reviewSummary,
        openNonBlocking: openDefects.filter((d) => d.severity !== 'P0' && d.severity !== 'P1'),
      });

      if (!authorization.authorized) {
        // The harness refused. `human_review` is a real outcome rather than a
        // failure, but neither reaches deployment.
        terminalDecision =
          authorization.action === 'human_review'
            ? 'request_human_review'
            : decideTerminal(openDefects, autonomyMode);
        say({
          phase: 'approve',
          detail: `Release not authorised (${authorization.action}): ${authorization.reason}`,
          level: 'fail',
        });
      }
      break;
    }

    /**
     * §7's escalation ladder, decided by Sol rather than by arithmetic.
     *
     * The harness computes what is affordable and executable; Sol reasons about
     * which of those is appropriate; the harness authorises and acts. Two rules
     * used to do all of it: `mustFix.length > repairsLeft` triggered a replan,
     * and everything else went to Luna. Neither asked what kind of defect it
     * was looking at.
     */
    const currentBudget = (await store.budgets.findOne({ _id: projectId }))!;
    const constraints: AdjudicationConstraints = {
      blockingCount: mustFix.length,
      repairsLeft: currentBudget.limits.totalRepairJobs - currentBudget.used.totalRepairJobs,
      replansLeft: currentBudget.limits.replans - currentBudget.used.replans,
      reviewRejectionsLeft:
        currentBudget.limits.reviewRejections - currentBudget.used.reviewRejections,
      previousRepairs: repairHistory,
      autonomyMode,
    };
    const legal = legalAdjudicationActions(constraints);

    let adjudication: AdjudicationAuthorization;
    let proposedAdjudication: AdjudicationRecord['proposed'] = null;
    let adjudicationFailure: string | null = null;

    try {
      const decided = await adjudicate(model, {
        reviewCycle,
        legalActions: legal,
        gateFindings: gateRun.findings.map(
          (f) => `${f.severity} ${f.gate} ${f.location} — ${f.message}`,
        ),
        reviewSummary: reviewSummary,
        openBlockingDefects: mustFix.map((d) => ({
          id: d.id,
          category: d.category,
          severity: d.severity,
          location: d.location,
          reason: d.reason,
          acceptanceTest: d.acceptanceTest,
        })),
        previousRepairs: repairHistory,
        remainingBudgets: {
          totalRepairJobs: constraints.repairsLeft,
          replans: constraints.replansLeft,
          reviewRejections: constraints.reviewRejectionsLeft,
        },
        autonomyMode,
      });
      track('sol', decided);

      proposedAdjudication = {
        action: decided.value.action,
        reason: decided.value.reason,
        defectIds: decided.value.defectIds ?? [],
        objective: decided.value.objective ?? null,
        scope: decided.value.scope ?? null,
      };
      adjudication = authorizeAdjudication(decided.value, legal, mustFix);
    } catch (error) {
      // An adjudication that cannot be obtained must not end a delivery: the
      // harness takes the cheapest legal action and records that Sol was absent.
      adjudicationFailure = error instanceof Error ? error.message : String(error);
      const action = fallbackAction(legal);
      adjudication = {
        action,
        // One blocker, not the whole set: with no adjudication there is no
        // judgement about which defects belong together.
        targets: action === 'repair' ? firstBlocker(mustFix) : [],
        source: 'fallback',
        refusal: `Sol could not be consulted: ${adjudicationFailure}`,
      };
    }

    await recordAdjudication({
      reviewCycle,
      action: adjudication.action,
      source: adjudication.source,
      refusal: adjudication.refusal,
      targetDefectIds: adjudication.targets.map((d) => d.id),
      legalActions: legal,
      constraints,
      proposed: proposedAdjudication,
      modelFailure: adjudicationFailure,
      decidedAt: new Date(),
    });

    say({
      phase: 'adjudicate',
      detail:
        adjudication.source === 'sol'
          ? `Sol chose ${adjudication.action}: ${proposedAdjudication?.reason ?? ''}`
          : `${adjudication.action} by fallback — ${adjudication.refusal ?? ''}`,
      level: adjudication.source === 'sol' ? 'ok' : 'warn',
    });

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
      const revised = await revisePlan({
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
      await buildFromPlan(plan);
      repairedSinceReview = [];
      continue;
    }

    say({
      phase: 'repair',
      detail: `Cycle ${reviewCycle}/${budgetLimits.reviewRejections}: repairing ${adjudication.targets.length} of ${mustFix.length} blocking defect(s)`,
    });

    let exhausted = false;
    for (const defect of adjudication.targets) {
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
    if (authorization?.action === 'human_review') {
      await store.projects.updateOne(
        { _id: projectId },
        { $set: { state: 'awaiting_human_review', updatedAt: new Date() } },
      );
      say({
        phase: 'approve',
        detail: `Awaiting human review before release: ${authorization.reason}`,
        level: 'warn',
      });
    }
    return terminal('blocked');
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
    // PENDING (Phase 2d, `sol-approve`): this credits Sol for a decision the
    // harness made alone. It becomes `recommendedBy` + `authorizedBy` when an
    // approval recommendation actually exists; changing it here would only
    // move the inaccuracy.
    /**
     * Who judged, and who authorised — separately, and neither standing in for
     * the other. The single `approvedBy: 'sol:machine-approval'` this replaces
     * named a model for a decision the harness made alone.
     */
    recommendation: {
      by: 'sol' as const,
      model: approvalModel,
      artifactVersion: approvalArtifactVersion,
      decision: (authorization.action === 'release' ? 'accept' : null) as
        | 'accept'
        | 'reject'
        | 'human_review'
        | null,
    },
    authorization: {
      by: 'harness-policy' as const,
      policyVersion: authorization.policyVersion,
      action: authorization.action,
      reason: authorization.reason,
    },
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
    usageByTier,
    phaseMs: { ...phaseMs },
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
      usageByTier,
      phaseMs: { ...phaseMs },
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
