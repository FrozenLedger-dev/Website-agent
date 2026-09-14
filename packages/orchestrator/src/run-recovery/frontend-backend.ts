/**
 * Durable post-promotion outer `runProject` recovery (Phase 5q).
 *
 * A `job_lifecycle` run that has already promoted its build can still die
 * before the run finishes — during evaluation, repair, approval or
 * publication. Before this, the next invocation for the same project ran
 * `discoverProject`, which deletes the project document, its budgets and its
 * defect budgets, and then planned and built again from scratch. With the
 * project's active build lineage still owned, that fresh root is now refused —
 * so the unfinished work was stranded rather than silently rebuilt, but it
 * could not continue either.
 *
 * This module decides, before any of discovery's side effects, whether the
 * project carries exact durable authority to continue, and what that authority
 * is. It is derived, not remembered: there is no recovery document and no
 * cursor. Everything comes from records that already exist for their own
 * reasons —
 *
 *   projectId
 *     -> the active lineage root (one indexed read)
 *     -> the lineage tip (a structural walk of predecessor links)
 *     -> that tip's own promotion, re-proven against the job, its fence, the
 *        promotion receipt and the promotion's known Git marker
 *     -> the tip's exact bound profile and plan
 *     -> the lineage's one release publication, if it has one
 *
 * — and every link that does not hold fails closed rather than falling back to
 * discovery, which is exactly the destructive reset this exists to prevent.
 *
 * What it deliberately does not do: consult `runs` or `run_events`; order
 * anything by time or version; clean, reset or check out the canonical
 * workspace; or recover a build that has not promoted, which Phase 5k and the
 * job lifecycle already own.
 */
import type { ArtifactRef, BusinessProfile, RunCompletionTarget, SitePlan } from '@statxai/contracts';
import { BusinessProfile as BusinessProfileSchema, SitePlan as SitePlanSchema } from '@statxai/contracts';
import type { ReleaseAuthorization } from '@statxai/policy-engine';
import type {
  BudgetLimits,
  BudgetUsage,
  FrontendBackendBuildBindingDocument,
  ReleasePublicationDocument,
  StateStore,
} from '@statxai/state';
import { ProjectWorkspace, type ArtifactRegistry } from '@statxai/workspace';
import type { ApprovalRecord, AuthorizationRecord } from '../release.js';
import type { RunContext } from '../run-context.js';
import { promotionMarker } from '../job-promotion/frontend-backend.js';
import { CanonicalDraftAuthorityCorrupt, assertCanonicalDraftPromotionMarker, loadCurrentCanonicalDraft, resolveCanonicalDraftAuthority } from '../canonical-draft/authority.js';
import { publishRelease, type PublishResult } from '../phases/publish.js';
import {
  assertReceiptMatchesCanonicalBuild,
  findReleasePublicationForLineage,
} from '../release-publication/publication.js';
import {
  deriveActiveLineageTip,
  findActiveLineageRoot,
  parseStoredJobSpec,
  readBuildLineage,
  readRunCompletionTarget,
  verifyBindingConsistency,
} from '../run-binding/frontend-backend.js';

const ROLE = 'frontend_backend';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * An unfinished build lineage owns this project, and the incoming run asks for
 * something else. Refused before discovery, so the unfinished work — its
 * project state, budgets, bindings and canonical history — is left exactly as
 * it was.
 */
export class ActiveContinuationIntentConflict extends Error {
  constructor(
    readonly projectId: string,
    readonly lineageRootBindingId: string,
    readonly activeRunIntentHash: string,
    readonly incomingRunIntentHash: string,
  ) {
    super(
      `project "${projectId}" has unfinished build lineage "${lineageRootBindingId}" for a different request ` +
        `(runIntentHash "${activeRunIntentHash}"); refusing to continue it or replace it with "${incomingRunIntentHash}"`,
    );
    this.name = 'ActiveContinuationIntentConflict';
  }
}

/**
 * The owning lineage's run is parked for a person to decide on release. Not a
 * crash, and never re-evaluated on its own: a fresh evaluation could approve
 * and publish what a human was asked to judge.
 */
export class ActiveContinuationAwaitingHumanReview extends Error {
  constructor(
    readonly projectId: string,
    readonly lineageRootBindingId: string,
  ) {
    super(
      `project "${projectId}" (lineage "${lineageRootBindingId}") is awaiting human review before release; ` +
        `it is not resumed automatically`,
    );
    this.name = 'ActiveContinuationAwaitingHumanReview';
  }
}

/**
 * The active lineage belongs to a semantic edit building from the project's
 * handed-off canonical draft. Its continuation is that edit's own — resumed from
 * its durable intent through `resumeSemanticEdit`, which evaluates and concludes
 * exactly its successor — never a run's evaluation, approval or release.
 */
export class ActiveContinuationSemanticEditOwned extends Error {
  constructor(
    readonly projectId: string,
    readonly draftId: string,
    readonly intentId: string,
  ) {
    super(
      `project "${projectId}": canonical draft "${draftId}" is handed to semantic edit "${intentId}", ` +
        `which owns its build lineage; a run does not continue it`,
    );
    this.name = 'ActiveContinuationSemanticEditOwned';
  }
}

/**
 * The project concluded as an unreleased canonical draft. Not interrupted work:
 * nothing is resumed, evaluated, approved, released or started fresh over it.
 * Continuing from a draft is an explicit claim on that exact draft.
 */
export class ActiveContinuationConcludedDraft extends Error {
  constructor(
    readonly projectId: string,
    readonly draftId: string,
    readonly canonicalBindingId: string,
  ) {
    super(
      `project "${projectId}" concluded as canonical draft "${draftId}" of build "${canonicalBindingId}"; ` +
        `a run does not continue or replace it without an explicit claim`,
    );
    this.name = 'ActiveContinuationConcludedDraft';
  }
}

/** The active lineage's tip is not a promoted build, so this is not post-promotion recovery. */
export class ActiveContinuationNotPromoted extends Error {
  constructor(
    readonly projectId: string,
    readonly bindingId: string,
    readonly status: string,
  ) {
    super(
      `project "${projectId}": active lineage tip "${bindingId}" is "${status}", not "promoted"; ` +
        `post-promotion recovery does not apply`,
    );
    this.name = 'ActiveContinuationNotPromoted';
  }
}

/** Durable evidence the continuation depends on is missing or contradicts itself. */
export class ActiveContinuationCorrupt extends Error {
  constructor(
    readonly projectId: string,
    detail: string,
  ) {
    super(`project "${projectId}" cannot be recovered — ${detail}`);
    this.name = 'ActiveContinuationCorrupt';
  }
}

/**
 * The canonical workspace carries uncommitted changes that are not the harness's
 * own decision records — most likely a repair that wrote files and died before
 * committing them. Never evaluated as though it were canonical, and never
 * cleaned up here.
 */
export class ActiveContinuationWorkspaceDirty extends Error {
  constructor(
    readonly projectId: string,
    readonly paths: readonly string[],
  ) {
    super(
      `project "${projectId}": the canonical workspace has unresolved uncommitted changes (${paths.join(', ')}); ` +
        `refusing to recover over them`,
    );
    this.name = 'ActiveContinuationWorkspaceDirty';
  }
}

/** A `legacy_direct` run would write a canonical workspace an unfinished `job_lifecycle` lineage still owns. */
export class LegacyDirectActiveLineageConflict extends Error {
  constructor(
    readonly projectId: string,
    readonly lineageRootBindingId: string,
  ) {
    super(
      `project "${projectId}" is owned by unfinished job_lifecycle lineage "${lineageRootBindingId}"; ` +
        `refusing to run legacy_direct against it`,
    );
    this.name = 'LegacyDirectActiveLineageConflict';
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface PostPromotionRecovery {
  readonly root: FrontendBackendBuildBindingDocument;
  /** The exact promoted canonical build the tree implements. */
  readonly tip: FrontendBackendBuildBindingDocument;
  readonly profile: BusinessProfile;
  readonly plan: SitePlan;
  readonly workspace: ProjectWorkspace;
  readonly budgetLimits: BudgetLimits;
  readonly budgetUsed: BudgetUsage;
  /** The lineage's one release publication, already proven to publish `tip`, or `null`. */
  readonly publication: ReleasePublicationDocument | null;
  /** How the recovered run ends, read from the lineage root — never from the caller. */
  readonly completionTarget: RunCompletionTarget;
}

export interface ResolvePostPromotionRecoveryInput {
  readonly store: StateStore;
  readonly registry: ArtifactRegistry;
  readonly workspacesRoot: string;
  readonly projectId: string;
  /** The incoming, already-validated request's run intent. */
  readonly runIntentHash: string;
  /** The completion target the incoming request asked for; it must be the one the lineage recorded. */
  readonly completionTarget: RunCompletionTarget;
}

/**
 * Harness-authored paths that may legitimately be uncommitted after promotion:
 * decision records every phase materialises and the next commit sweeps in, and
 * the deployment manifest written just before its own commit. Nothing a model
 * writes can land here — models reach the workspace only through the managed
 * `app/**` namespace — so anything outside this set is unresolved work.
 */
function isHarnessRecord(path: string): boolean {
  return path.startsWith('decisions/') || path === 'deployment/deployment-manifest.json';
}

/**
 * Whether this project carries exact authority to continue a promoted build,
 * and if so exactly what — or `null` when no lineage owns the project and the
 * ordinary fresh path applies.
 *
 * Reads only, apart from opening the project's existing workspace. Anything it
 * cannot prove fails closed; nothing it finds is repaired.
 */
export async function resolvePostPromotionRecovery(
  input: ResolvePostPromotionRecoveryInput,
): Promise<PostPromotionRecovery | null> {
  const { store, registry, projectId } = input;

  const root = await findActiveLineageRoot(store, projectId);
  if (!root) {
    // No run owns the project. A concluded draft does — proven exactly, down to
    // its promotion's marker commit — and is reported as concluded, never as
    // work to recover and never as room for a fresh run.
    const draft = await loadCurrentCanonicalDraft(store, projectId);
    if (!draft) return null;
    await assertCanonicalDraftPromotionMarker(await ProjectWorkspace.open(projectId, input.workspacesRoot), draft);
    throw new ActiveContinuationConcludedDraft(projectId, draft._id, draft.canonicalBindingId);
  }

  // An active lineage beside a current draft is either that draft handed to its
  // semantic edit — whose continuation is the edit's own — or corruption.
  const strayDraft = await store.canonicalDrafts.findOne({ projectId, current: true });
  if (strayDraft) {
    const owner = await resolveCanonicalDraftAuthority(store, projectId).catch((error: unknown) => {
      if (error instanceof CanonicalDraftAuthorityCorrupt) {
        throw new ActiveContinuationCorrupt(projectId, `lineage "${root._id}" is active while canonical draft "${strayDraft._id}" is current (${error.message})`);
      }
      throw error;
    });
    if (owner?.state === 'handed_off' && owner.draft.claim?.kind === 'semantic_edit') {
      throw new ActiveContinuationSemanticEditOwned(projectId, owner.draft._id, owner.draft.claim.operationId);
    }
    throw new ActiveContinuationCorrupt(projectId, `lineage "${root._id}" is active while canonical draft "${strayDraft._id}" is current`);
  }

  const tip = await deriveActiveLineageTip(store, root);

  // The request must be the one this lineage answers — checked against the
  // root and the tip alike, before anything else is read or opened.
  for (const member of [root, tip]) {
    if (member.runIntentHash !== input.runIntentHash) {
      throw new ActiveContinuationIntentConflict(projectId, root._id, member.runIntentHash, input.runIntentHash);
    }
  }

  // How the run ends is the root's durable record, never the caller's say-so.
  const completionTarget = readRunCompletionTarget(root);
  if (completionTarget !== input.completionTarget) {
    throw new ActiveContinuationCorrupt(projectId, `lineage "${root._id}" completes as "${completionTarget}", but the request asked for "${input.completionTarget}"`);
  }

  if (tip.status !== 'promoted') {
    throw new ActiveContinuationNotPromoted(projectId, tip._id, tip.status);
  }
  if (!tip.promotionId || !tip.promotionCommitSha) {
    throw new ActiveContinuationCorrupt(projectId, `promoted build "${tip._id}" records no promotion id or commit`);
  }
  if (!tip.specificationCommitSha) {
    throw new ActiveContinuationCorrupt(projectId, `promoted build "${tip._id}" records no specification commit`);
  }

  // The stored request still describes itself consistently, lineage included.
  const spec = parseStoredJobSpec(tip);
  const position = readBuildLineage(tip);
  verifyBindingConsistency(
    tip,
    spec,
    position.kind === 'successor' ? { predecessorBindingId: position.predecessorBindingId, provenance: position.provenance } : undefined,
    root._id,
  );
  // A promoted replan or visual refinement is a continuation this recovery owns:
  // evaluated afresh, with whether to refine again decided from its own typed
  // provenance. A semantic edit always builds from a handed-off draft, which was
  // recognised above; a semantic-edit tip with no such draft has lost the
  // authority that owns it, and is never continued as a run's build.
  if (position.kind === 'successor' && position.provenance.kind === 'semantic_edit') {
    throw new ActiveContinuationCorrupt(projectId, `semantic edit build "${tip._id}" is the active tip, but no canonical draft is handed to its edit`);
  }

  // Durable run state this continuation reuses, never recreates.
  const projectDoc = await store.projects.findOne({ _id: projectId });
  if (!projectDoc) throw new ActiveContinuationCorrupt(projectId, 'the project document is missing');
  if (projectDoc.state === 'awaiting_human_review') {
    throw new ActiveContinuationAwaitingHumanReview(projectId, root._id);
  }
  if (projectDoc.state === 'released' || projectDoc.state === 'blocked' || projectDoc.state === 'intake_insufficient' || projectDoc.state === 'draft') {
    throw new ActiveContinuationCorrupt(
      projectId,
      `the project is "${projectDoc.state}" yet lineage "${root._id}" still owns it`,
    );
  }
  const budgetDoc = await store.budgets.findOne({ _id: projectId });
  if (!budgetDoc) throw new ActiveContinuationCorrupt(projectId, 'the budget document is missing');

  // The promotion itself, re-proven from its own exact evidence.
  const job = await store.jobs.findOne({ _id: tip.jobId });
  if (!job) throw new ActiveContinuationCorrupt(projectId, `job "${tip.jobId}" of build "${tip._id}" is missing`);
  if (job.projectId !== projectId || job.role !== ROLE || job.state !== 'accepted') {
    throw new ActiveContinuationCorrupt(projectId, `job "${job._id}" is not this project's accepted ${ROLE} job`);
  }
  if (job.promotionFence?.promotionId !== tip.promotionId) {
    throw new ActiveContinuationCorrupt(projectId, `job "${job._id}" holds no promotion fence for "${tip.promotionId}"`);
  }
  const receipt = await store.promotions.findOne({ _id: tip.promotionId });
  if (
    !receipt ||
    receipt.projectId !== projectId ||
    receipt.jobId !== job._id ||
    receipt.status !== 'committed' ||
    receipt.commitSha !== tip.promotionCommitSha
  ) {
    throw new ActiveContinuationCorrupt(projectId, `promotion receipt "${tip.promotionId}" does not match build "${tip._id}"`);
  }

  const workspace = await ProjectWorkspace.open(projectId, input.workspacesRoot);
  const marked = await workspace.findCommitsByMarker(promotionMarker(tip.promotionId));
  if (marked.length !== 1 || marked[0] !== tip.promotionCommitSha) {
    throw new ActiveContinuationCorrupt(
      projectId,
      `canonical history does not carry exactly one commit for promotion "${tip.promotionId}" at ${tip.promotionCommitSha}`,
    );
  }

  // The lineage's release, if it has one, must publish exactly this build.
  const publication = await findReleasePublicationForLineage(store, projectId, root._id);
  if (publication && completionTarget === 'draft') {
    throw new ActiveContinuationCorrupt(projectId, `draft-targeted lineage "${root._id}" has release publication "${publication._id}"`);
  }
  if (publication) {
    assertReceiptMatchesCanonicalBuild(publication, {
      lineageRootBindingId: root._id,
      canonicalBindingId: tip._id,
      promotionId: tip.promotionId,
    });
  }

  // Unresolved uncommitted work is never treated as canonical. Deletions are
  // never harness-authored, so they count as unresolved too.
  const unresolved = (await workspace.dirtyEntries())
    .filter((entry) => entry.status.includes('D') || !isHarnessRecord(entry.path))
    .map((entry) => entry.path);
  if (unresolved.length > 0) throw new ActiveContinuationWorkspaceDirty(projectId, unresolved);

  // Exact bound refs, never "latest".
  const profile = BusinessProfileSchema.parse(await registry.resolve(projectId, tip.businessProfile));
  const plan = SitePlanSchema.parse(await registry.resolve(projectId, tip.sitePlan));

  return {
    root,
    tip,
    profile,
    plan,
    workspace,
    budgetLimits: budgetDoc.limits,
    budgetUsed: budgetDoc.used,
    publication,
    completionTarget,
  };
}

/**
 * Refuse a `legacy_direct` run while an unfinished `job_lifecycle` lineage or a
 * concluded canonical draft owns the project. A terminal project holds neither,
 * so this never blocks legitimate later work.
 */
/**
 * Refuse a `job_lifecycle` run over a project a canonical draft owns — concluded,
 * or handed to a semantic edit — before anything resumes, recovers or
 * discovers. Neither is a run's to continue.
 */
export async function assertNoCanonicalDraftOwnsRun(store: StateStore, projectId: string): Promise<void> {
  const owner = await resolveCanonicalDraftAuthority(store, projectId);
  if (owner?.state === 'concluded') throw new ActiveContinuationConcludedDraft(projectId, owner.draft._id, owner.draft.canonicalBindingId);
  if (owner?.state === 'handed_off') throw new ActiveContinuationSemanticEditOwned(projectId, owner.draft._id, owner.draft.claim!.operationId);
}

export async function assertNoActiveLineageForLegacyDirect(store: StateStore, projectId: string): Promise<void> {
  const root = await findActiveLineageRoot(store, projectId);
  if (root) throw new LegacyDirectActiveLineageConflict(projectId, root._id);
  // Nor over a concluded draft, whose discovery would erase the project it owns.
  const draft = await loadCurrentCanonicalDraft(store, projectId);
  if (draft) throw new ActiveContinuationConcludedDraft(projectId, draft._id, draft.canonicalBindingId);
}

// ---------------------------------------------------------------------------
// Release continuation
// ---------------------------------------------------------------------------

/** What an existing release's own durable records say about it. */
export interface RecoveredRelease {
  readonly authorization: ReleaseAuthorization;
  readonly releaseAuthorizationRef: ArtifactRef;
  readonly qualityScore: number;
  readonly gatesCertified: string[];
  readonly approvalArtifactVersion: number | null;
  readonly approvalModel: string | null;
  readonly approvalDecision: 'accept' | 'reject' | 'human_review' | null;
}

/**
 * Rebuild what the release was authorised on, from the exact records the
 * receipt names — the authorisation, and through its recorded versions the
 * approval, the test report and the review. Never re-asked, never "the latest".
 *
 * Fails closed unless the durable authorisation actually authorised a release:
 * a receipt alone is not permission to publish.
 */
export async function rehydrateRecoveredRelease(
  registry: ArtifactRegistry,
  projectId: string,
  publication: ReleasePublicationDocument,
): Promise<RecoveredRelease> {
  const record = await registry.resolve<AuthorizationRecord>(projectId, publication.releaseAuthorization);
  if (record.authorized !== true || record.action !== 'release') {
    throw new ActiveContinuationCorrupt(
      projectId,
      `release "${publication._id}" names an authorisation that did not authorise a release`,
    );
  }

  const approval =
    record.recommendationVersion === null
      ? null
      : await registry.resolve<ApprovalRecord>(projectId, { name: 'approval-recommendation', version: record.recommendationVersion });

  const testReport =
    approval?.testReportVersion == null
      ? null
      : await registry.resolve<{ gatesRun: string[] }>(projectId, { name: 'test-report', version: approval.testReportVersion });

  const review =
    approval?.visualReviewVersion == null
      ? null
      : await registry.resolve<{ qualityScore: number }>(projectId, { name: 'visual-review', version: approval.visualReviewVersion });

  return {
    authorization: {
      authorized: record.authorized,
      action: record.action,
      reason: record.reason,
      policyVersion: record.policyVersion,
    },
    releaseAuthorizationRef: publication.releaseAuthorization,
    qualityScore: review?.qualityScore ?? 0,
    gatesCertified: testReport ? [...testReport.gatesRun] : [],
    approvalArtifactVersion: record.recommendationVersion,
    approvalModel: approval?.model ?? null,
    approvalDecision: approval?.recommendation ?? null,
  };
}

/**
 * Continue an existing release through Phase 5p itself — never through
 * evaluation, approval or a new authorisation. What happens next is entirely
 * Phase 5p's: a `prepared` receipt publishes, `publishing` refuses and asks for
 * reconciliation, `retry_authorized` spends its one attempt, and `committed`
 * finalises without calling the provider.
 */
export async function publishRecoveredRelease(
  ctx: RunContext,
  release: RecoveredRelease,
  canonicalBuildBindingId: string,
): Promise<PublishResult> {
  if (!release.authorization.authorized) {
    throw new ActiveContinuationCorrupt(ctx.facts.projectId, 'the recovered release is not authorised');
  }
  return publishRelease(ctx, release.authorization, {
    releaseAuthorizationRef: release.releaseAuthorizationRef,
    canonicalBuildBindingId,
  });
}
