/**
 * Applying one semantic edit to a project's canonical draft, through the normal
 * build lifecycle.
 *
 *   available draft D0 (build B0, model M0) + patch P
 *     → P proven against exactly M0; M1 derived, purely
 *     → one transaction: D0 claimed and handed to this edit (B0's own lineage
 *       active again, the project `building`), M1 recorded, the exact source
 *       snapshot recorded, the durable intent with its fixed job written
 *     → the semantic-edit successor B1 prepared on B0
 *     → terra-edit, candidate staging, sandboxed official validation against
 *       exactly M1, guarded acceptance, promotion fence and receipt, exact
 *       replacement promotion — all the existing lifecycle coordinator's
 *     → B1 evaluated afresh
 *     → one transaction: B1 concluded as the new available draft D1, D0
 *       superseded, the lineage released, the intent completed
 *
 * The harness owns every decision here; Terra only proposes source. Nothing in
 * this module accepts, promotes, commits model source, seeks or authorises a
 * release, publishes, or visually refines: those are the lifecycle's, or not
 * this operation's at all. It ends at a draft.
 *
 * Callers are trusted server code. A future customer route authenticates the
 * customer and calls `authorizeCustomerProjectEdit` first; this module reads no
 * cookie, session or token, and records at most a customer user id for audit.
 *
 * Replay is by identity, never by time: the same edit of the same draft always
 * resolves the same intent, model version, source snapshot, job and successor,
 * and resumes from whatever its durable records say — including after a crash
 * mid-build, after promotion or after evaluation.
 *
 * A stop before promotion (validation failure, a retry, a model failure, a job
 * still leased by a dead worker) leaves the claim, the lineage and the job
 * durable: the edit is not rolled back to an available draft, because its job
 * and successor already own continuation. Replaying the edit resumes that job.
 */
import {
  SEMANTIC_EDIT_SOURCE_LIMITS,
  SEMANTIC_EDIT_SOURCE_SCHEMA_VERSION,
  BusinessProfile,
  SemanticEditSource,
  SemanticEditSuccessorProvenance,
  SemanticPatch,
  SitePlan,
  type ArtifactRef,
} from '@statxai/contracts';
import { ModelRuntime, type Provider } from '@statxai/agents';
import { JobEngine } from '@statxai/job-engine';
import type { SemanticEditIntentDocument, SemanticEditIntentStatus, StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace, SourceSnapshotTooLarge, contentHash } from '@statxai/workspace';
import {
  CanonicalDraftClaimConflict,
  assertCanonicalDraftPromotionMarker,
  concludeCanonicalDraft,
  handOffCanonicalDraft,
  resolveCanonicalDraftAuthority,
} from '../canonical-draft/authority.js';
import { createFrontendBackendLifecycleCoordinator, type FrontendBackendLifecycleResult } from '../job-lifecycle/frontend-backend.js';
import { createFrontendBackendSemanticEditJobSpec } from '../job-specs/frontend-backend.js';
import { FRONTEND_BACKEND_INPUT } from '../job-handlers/frontend-backend.js';
import { promotionMarker } from '../job-promotion/frontend-backend.js';
import { evaluateSite } from '../phases/evaluate.js';
import {
  computeBindingId,
  computeJobSpecHash,
  ensureSpecificationCommitted,
  finalizeBindingPromoted,
  prepareFrontendBackendBuildBinding,
} from '../run-binding/frontend-backend.js';
import { createRunProgress, snapshotProgress, type Progress, type RunContext } from '../run-context.js';
import { EditableSiteModelRefInvalid, recordEditableSiteModel, resolveEditableSiteModel } from '../site-model/persist.js';
import { SemanticPatchRejected, applySemanticPatch, type SemanticPatchRejection } from '../site-model/patch.js';

export const SEMANTIC_EDIT_SOURCE_ARTIFACT = 'semantic-edit-source';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SemanticEditRefusal =
  /** No current canonical draft: an active run, a released, blocked or parked project, or none at all. */
  | 'no_current_draft'
  /** The current draft is not the one the edit was written against. */
  | 'stale_draft'
  /** The current draft owns a different build than the edit expected. */
  | 'stale_tip'
  /** The draft is held by another operation. */
  | 'draft_claimed'
  /** The base model is not exactly the model the draft's build carries. */
  | 'stale_base'
  /** The patch does not apply to the base model; `patchRejection` says why. */
  | 'invalid_patch'
  /** The exact source of the draft's build cannot be proven. */
  | 'source_unavailable'
  /** The exact source exceeds the snapshot bounds; it is never truncated. */
  | 'source_too_large';

/** The edit was refused before anything was claimed, recorded, built or changed. */
export class SemanticEditRefused extends Error {
  constructor(
    readonly projectId: string,
    readonly reason: SemanticEditRefusal,
    detail: string,
    readonly patchRejection?: SemanticPatchRejection,
  ) {
    super(`project "${projectId}": semantic edit refused (${reason}) — ${detail}`);
    this.name = 'SemanticEditRefused';
  }
}

/** Durable semantic-edit authority is missing or contradicts itself. Nothing is continued. */
export class SemanticEditAuthorityCorrupt extends Error {
  constructor(
    readonly projectId: string,
    detail: string,
  ) {
    super(`project "${projectId}": semantic edit authority is corrupt — ${detail}`);
    this.name = 'SemanticEditAuthorityCorrupt';
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface SemanticEditIdentity {
  readonly projectId: string;
  readonly sourceDraftId: string;
  readonly predecessorBindingId: string;
  readonly baseEditableSiteModel: ArtifactRef;
  readonly patchDigest: string;
}

/** Deterministic from the exact draft, build, base model and patch — no clock, randomness or session. */
export function semanticEditIntentId(identity: SemanticEditIdentity): string {
  return `semantic-edit-${contentHash({
    projectId: identity.projectId,
    sourceDraftId: identity.sourceDraftId,
    predecessorBindingId: identity.predecessorBindingId,
    baseEditableSiteModel: { name: identity.baseEditableSiteModel.name, version: identity.baseEditableSiteModel.version, contentHash: identity.baseEditableSiteModel.contentHash ?? null },
    patchDigest: identity.patchDigest,
  })}`;
}

const CUSTOMER_USER_ID = /^cu_[a-f0-9]{32}$/;

function sameExactRef(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.name === b.name && a.version === b.version && a.contentHash !== undefined && a.contentHash === b.contentHash;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface SemanticEditDeps {
  readonly store: StateStore;
  /** Root of the canonical, harness-owned project workspaces. */
  readonly workspacesRoot: string;
  /** Root under which official validation creates disposable workspaces. */
  readonly validationWorkspacesRoot: string;
  /** Where Terra's advisory `test_runner` builds create disposable workspaces. */
  readonly advisoryWorkspacesRoot?: string;
  /** The provider beneath the model runtime — the test seam, exactly as `runProject`'s. */
  readonly modelProvider?: Provider;
  readonly say?: Progress;
}

export interface ApplySemanticEditInput extends SemanticEditDeps {
  readonly projectId: string;
  /** The exact current draft the edit was written against. */
  readonly expectedDraftId: string;
  /** The exact build that draft owns. */
  readonly expectedCanonicalBindingId: string;
  /** The exact model the patch was written against. */
  readonly baseEditableSiteModel: ArtifactRef;
  /** One strict semantic patch, unparsed: it is proven here. */
  readonly patch: unknown;
  /** Audit only, supplied by a caller that already authorised this customer to edit the project. */
  readonly requestedBy?: { readonly customerUserId: string };
}

/** What the future editor needs to know about one edit — exact refs and ids, nothing internal. */
export interface SemanticEditResult {
  readonly intentId: string;
  readonly status: SemanticEditIntentStatus;
  readonly sourceDraftId: string;
  readonly baseEditableSiteModel: ArtifactRef;
  readonly editableSiteModel: ArtifactRef;
  readonly successorBindingId: string;
  readonly promotion: { readonly promotionId: string; readonly promotionCommitSha: string } | null;
  readonly evaluation: SemanticEditIntentDocument['evaluation'] | null;
  readonly resultDraftId: string | null;
  /** When the build lifecycle stopped this invocation before promotion: its exact outcome. */
  readonly lifecycleOutcome: Exclude<FrontendBackendLifecycleResult['outcome'], 'promoted'> | null;
  /** When evaluation could not obtain a review: why. The edit stays promoted and resumes. */
  readonly evaluationUnavailable: string | null;
  /** `true` when this edit's intent already existed. */
  readonly replayed: boolean;
}

function resultOf(
  intent: SemanticEditIntentDocument,
  replayed: boolean,
  stop: { lifecycleOutcome?: SemanticEditResult['lifecycleOutcome']; evaluationUnavailable?: string } = {},
): SemanticEditResult {
  return {
    intentId: intent._id,
    status: intent.status,
    sourceDraftId: intent.sourceDraftId,
    baseEditableSiteModel: intent.baseEditableSiteModel,
    editableSiteModel: intent.editableSiteModel,
    successorBindingId: intent.successorBindingId,
    promotion: intent.promotion ?? null,
    evaluation: intent.evaluation ?? null,
    resultDraftId: intent.resultDraftId ?? null,
    lifecycleOutcome: stop.lifecycleOutcome ?? null,
    evaluationUnavailable: stop.evaluationUnavailable ?? null,
    replayed,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Apply one exact semantic patch to the project's exact current draft, and take
 * the result through the normal build lifecycle to a new draft.
 *
 * Refusals are typed and happen before anything is written. Once the edit is
 * authorised, the same call — or any later exact replay — drives it forward
 * from its durable state and returns where it stands.
 */
export async function applySemanticEdit(input: ApplySemanticEditInput): Promise<SemanticEditResult> {
  const { store, projectId } = input;
  const registry = new ArtifactRegistry(store);
  const refuse = (reason: SemanticEditRefusal, detail: string, code?: SemanticPatchRejection) => new SemanticEditRefused(projectId, reason, detail, code);

  if (input.requestedBy !== undefined && (Object.keys(input.requestedBy).join() !== 'customerUserId' || !CUSTOMER_USER_ID.test(input.requestedBy.customerUserId))) {
    throw new TypeError('requestedBy carries exactly one customer user id');
  }

  // The patch, against exactly the base it names — pure, before anything is read about the draft.
  let base;
  try {
    base = await resolveEditableSiteModel(registry, projectId, input.baseEditableSiteModel);
  } catch (error) {
    if (error instanceof EditableSiteModelRefInvalid) throw refuse('stale_base', error.message);
    throw error;
  }
  let result;
  try {
    result = applySemanticPatch({ baseRef: input.baseEditableSiteModel, base, patch: input.patch });
  } catch (error) {
    if (error instanceof SemanticPatchRejected) throw refuse('invalid_patch', error.message, error.code);
    throw error;
  }
  const patch = SemanticPatch.parse(input.patch);
  const patchDigest = contentHash(patch);
  const intentId = semanticEditIntentId({
    projectId,
    sourceDraftId: input.expectedDraftId,
    predecessorBindingId: input.expectedCanonicalBindingId,
    baseEditableSiteModel: input.baseEditableSiteModel,
    patchDigest,
  });

  // Replay: this exact edit already has its intent, whatever became of the draft since.
  const existing = await store.semanticEditIntents.findOne({ _id: intentId });
  if (existing) return continueSemanticEdit(input, assertIntentDescribes(existing, { projectId, sourceDraftId: input.expectedDraftId, predecessorBindingId: input.expectedCanonicalBindingId, baseEditableSiteModel: input.baseEditableSiteModel, patchDigest }), true);

  // The exact available draft, its exact build, and that build's exact model.
  const authority = await resolveCanonicalDraftAuthority(store, projectId);
  if (!authority) throw refuse('no_current_draft', 'the project has no current canonical draft');
  const { draft } = authority;
  if (draft._id !== input.expectedDraftId) throw refuse('stale_draft', `the current draft is "${draft._id}", not "${input.expectedDraftId}"`);
  if (draft.canonicalBindingId !== input.expectedCanonicalBindingId) throw refuse('stale_tip', `draft "${draft._id}" owns build "${draft.canonicalBindingId}"`);
  if (authority.state !== 'concluded' || draft.status !== 'available') throw refuse('draft_claimed', `draft "${draft._id}" is held by another operation`);
  const predecessor = await store.frontendBackendBuildBindings.findOne({ _id: draft.canonicalBindingId, projectId });
  if (!predecessor) throw new SemanticEditAuthorityCorrupt(projectId, `draft build "${draft.canonicalBindingId}" is missing`);
  const pinned = predecessor.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel];
  if (!pinned || !sameExactRef(pinned, input.baseEditableSiteModel)) {
    throw refuse('stale_base', `build "${predecessor._id}" carries ${pinned ? `${pinned.name}@${pinned.version}` : 'no editable site model'}, not ${input.baseEditableSiteModel.name}@${input.baseEditableSiteModel.version}`);
  }

  // The exact source: canonical HEAD, descended from the draft build's own promotion, read from Git's object store.
  const workspace = await ProjectWorkspace.open(projectId, input.workspacesRoot);
  try {
    await assertCanonicalDraftPromotionMarker(workspace, draft);
  } catch (error) {
    throw refuse('source_unavailable', (error as Error).message);
  }
  // Uncommitted work is never source, and never built over: only harness decision records may be pending.
  const unresolved = (await workspace.dirtyEntries()).filter((entry) => entry.status.includes('D') || !entry.path.startsWith('decisions/')).map((entry) => entry.path);
  if (unresolved.length > 0) throw refuse('source_unavailable', `the canonical workspace has uncommitted changes (${unresolved.join(', ')})`);
  const sourceCommit = await workspace.currentCommit();
  if (!sourceCommit || !(await workspace.isAncestorCommit(draft.promotionCommitSha, sourceCommit))) {
    throw refuse('source_unavailable', `canonical HEAD ${sourceCommit ?? '(none)'} does not descend from promotion ${draft.promotionCommitSha}`);
  }
  let files: { path: string; contents: string }[];
  try {
    files = await workspace.readModelSourceAtCommit(sourceCommit, SEMANTIC_EDIT_SOURCE_LIMITS);
  } catch (error) {
    if (error instanceof SourceSnapshotTooLarge) throw refuse('source_too_large', error.message);
    throw error;
  }
  if (files.length === 0) throw refuse('source_unavailable', `no model source is tracked at ${sourceCommit}`);

  // One transaction: the claim and handoff, the result model, the source, the intent — or none of them.
  let won = false;
  let intent: SemanticEditIntentDocument;
  try {
    intent = await store.withTransaction(async (session) => {
      won = false;
      const raced = await store.semanticEditIntents.findOne({ _id: intentId }, { session });
      if (raced) return raced;

      const claimant = { kind: 'semantic_edit' as const, operationId: intentId };
      await handOffCanonicalDraft({ store, projectId, expectedDraftId: draft._id, expectedCanonicalBindingId: predecessor._id, claimant }, session);

      const model = await recordEditableSiteModel(registry, projectId, result, session);
      const source = SemanticEditSource.parse({
        schemaVersion: SEMANTIC_EDIT_SOURCE_SCHEMA_VERSION,
        projectId,
        intentId,
        sourceDraftId: draft._id,
        predecessorBindingId: predecessor._id,
        promotionId: draft.promotionId,
        promotionCommitSha: draft.promotionCommitSha,
        sourceCommit,
        baseEditableSiteModel: input.baseEditableSiteModel,
        editableSiteModel: model.ref,
        patch,
        files,
        filesDigest: contentHash(files),
      });
      const sourceRef = await registry.put(projectId, SEMANTIC_EDIT_SOURCE_ARTIFACT, source, session);
      const jobSpec = createFrontendBackendSemanticEditJobSpec({
        projectId,
        businessProfileRef: predecessor.businessProfile,
        sitePlanRef: predecessor.sitePlan,
        semanticEditSourceRef: sourceRef,
        baseEditableSiteModelRef: input.baseEditableSiteModel,
        editableSiteModelRef: model.ref,
      });
      const now = new Date();
      const doc: SemanticEditIntentDocument = {
        _id: intentId,
        projectId,
        sourceDraftId: draft._id,
        lineageRootBindingId: draft.lineageRootBindingId,
        predecessorBindingId: predecessor._id,
        baseEditableSiteModel: input.baseEditableSiteModel,
        editableSiteModel: model.ref,
        patch,
        patchDigest,
        sourceCommit,
        source: sourceRef,
        jobId: jobSpec.jobId,
        jobSpec,
        successorBindingId: computeBindingId({ projectId, runIntentHash: predecessor.runIntentHash, jobSpecHash: computeJobSpecHash(jobSpec) }),
        ...(input.requestedBy ? { requestedBy: { customerUserId: input.requestedBy.customerUserId } } : {}),
        status: 'building',
        createdAt: now,
        updatedAt: now,
      };
      await store.semanticEditIntents.insertOne(doc, { session });
      won = true;
      return doc;
    });
  } catch (error) {
    if (error instanceof CanonicalDraftClaimConflict) {
      const reason: SemanticEditRefusal =
        error.reason === 'stale_draft' ? 'stale_draft' : error.reason === 'stale_tip' ? 'stale_tip' : error.reason === 'no_current_draft' ? 'no_current_draft' : 'draft_claimed';
      throw refuse(reason, error.message);
    }
    if (!isDuplicateKeyError(error)) throw error;
    // A concurrent authorisation of this exact edit won; its intent is the one.
    const winner = await store.semanticEditIntents.findOne({ _id: intentId });
    if (!winner) throw refuse('draft_claimed', 'a concurrent edit of this draft won');
    intent = winner;
  }
  return continueSemanticEdit(input, intent, !won);
}

/**
 * Resume the semantic edit a project's handed-off draft belongs to — the
 * continuation Phase 5q hands over — from its durable records alone. Returns
 * `null` when no draft is handed to a semantic edit.
 */
export async function resumeSemanticEdit(input: SemanticEditDeps & { readonly projectId: string }): Promise<SemanticEditResult | null> {
  const { store, projectId } = input;
  const authority = await resolveCanonicalDraftAuthority(store, projectId);
  if (authority?.state !== 'handed_off' || authority.draft.claim?.kind !== 'semantic_edit') return null;
  const intent = await store.semanticEditIntents.findOne({ _id: authority.draft.claim.operationId, projectId });
  if (!intent) throw new SemanticEditAuthorityCorrupt(projectId, `draft "${authority.draft._id}" is handed to semantic edit "${authority.draft.claim.operationId}", which has no intent`);
  return continueSemanticEdit(input, intent, true);
}

function assertIntentDescribes(intent: SemanticEditIntentDocument, identity: SemanticEditIdentity): SemanticEditIntentDocument {
  if (
    intent._id !== semanticEditIntentId(identity) ||
    intent.projectId !== identity.projectId ||
    intent.sourceDraftId !== identity.sourceDraftId ||
    intent.predecessorBindingId !== identity.predecessorBindingId ||
    !sameExactRef(intent.baseEditableSiteModel, identity.baseEditableSiteModel) ||
    intent.patchDigest !== identity.patchDigest ||
    contentHash(intent.patch) !== intent.patchDigest
  ) {
    throw new SemanticEditAuthorityCorrupt(identity.projectId, `semantic edit intent "${intent._id}" does not describe this edit`);
  }
  return intent;
}

// ---------------------------------------------------------------------------
// Continuation — forward from durable state only
// ---------------------------------------------------------------------------

const STATUS_ORDER: readonly SemanticEditIntentStatus[] = ['building', 'promoted', 'evaluated', 'completed'];

async function advanceIntent(
  store: StateStore,
  intent: SemanticEditIntentDocument,
  from: SemanticEditIntentStatus,
  to: SemanticEditIntentStatus,
  set: Partial<SemanticEditIntentDocument>,
): Promise<SemanticEditIntentDocument> {
  const now = new Date();
  const moved = await store.semanticEditIntents.updateOne({ _id: intent._id, projectId: intent.projectId, status: from }, { $set: { ...set, status: to, updatedAt: now } });
  if (moved.matchedCount === 1) return { ...intent, ...set, status: to, updatedAt: now };
  // A concurrent replay of this same edit got there first: its durable record is the one to continue from.
  const current = await store.semanticEditIntents.findOne({ _id: intent._id, projectId: intent.projectId });
  if (current && STATUS_ORDER.indexOf(current.status) >= STATUS_ORDER.indexOf(to)) return current;
  throw new SemanticEditAuthorityCorrupt(intent.projectId, `semantic edit "${intent._id}" is no longer "${from}"`);
}

async function continueSemanticEdit(deps: SemanticEditDeps, loaded: SemanticEditIntentDocument, replayed: boolean): Promise<SemanticEditResult> {
  const { store } = deps;
  const { projectId } = loaded;
  const registry = new ArtifactRegistry(store);
  const corrupt = (detail: string) => new SemanticEditAuthorityCorrupt(projectId, detail);
  const say: Progress = deps.say ?? (() => {});
  const claimant = { kind: 'semantic_edit' as const, operationId: loaded._id };
  let intent = loaded;

  if (intent.status === 'completed') return resultOf(intent, replayed);
  // This operation's one model runtime: every Terra call it makes, building or reviewing, crosses it.
  const model = new ModelRuntime(deps.modelProvider !== undefined ? { provider: deps.modelProvider } : {});

  // Every step starts from the draft still handed to exactly this edit.
  const authority = await resolveCanonicalDraftAuthority(store, projectId);
  if (authority?.state !== 'handed_off' || authority.draft._id !== intent.sourceDraftId || authority.draft.claim?.kind !== 'semantic_edit' || authority.draft.claim.operationId !== intent._id) {
    throw corrupt(`semantic edit "${intent._id}" is "${intent.status}", but draft "${intent.sourceDraftId}" is not handed to it`);
  }
  const predecessor = await store.frontendBackendBuildBindings.findOne({ _id: intent.predecessorBindingId, projectId });
  if (!predecessor || predecessor._id !== authority.draft.canonicalBindingId) throw corrupt(`predecessor "${intent.predecessorBindingId}" is not the draft's build`);
  const provenance = SemanticEditSuccessorProvenance.parse({ kind: 'semantic_edit', baseEditableSiteModel: intent.baseEditableSiteModel, editableSiteModel: intent.editableSiteModel });

  const workspace = await ProjectWorkspace.open(projectId, deps.workspacesRoot);
  const profile = BusinessProfile.parse(await registry.resolve(projectId, predecessor.businessProfile));
  const plan = SitePlan.parse(await registry.resolve(projectId, predecessor.sitePlan));

  if (intent.status === 'building') {
    const successor = await prepareFrontendBackendBuildBinding(store, {
      projectId,
      runIntentHash: predecessor.runIntentHash,
      businessProfileRef: predecessor.businessProfile,
      sitePlanRef: predecessor.sitePlan,
      jobSpec: intent.jobSpec,
      specificationBaseCommit: await workspace.currentCommit(),
      lineage: { predecessorBindingId: predecessor._id, provenance },
    });
    if (successor._id !== intent.successorBindingId) throw corrupt(`semantic edit "${intent._id}" names successor "${intent.successorBindingId}", not "${successor._id}"`);

    let promoted: { promotionId: string; promotionCommitSha: string };
    if (successor.status === 'promoted' && successor.promotionId && successor.promotionCommitSha) {
      // Promoted and finalised before a crash: nothing is built again.
      promoted = { promotionId: successor.promotionId, promotionCommitSha: successor.promotionCommitSha };
    } else {
      // The edit's own harness record is what its specification commit carries: the plan is unchanged.
      await workspace.materialiseArtifact('decisions/semantic-edit.json', {
        intentId: intent._id,
        sourceDraftId: intent.sourceDraftId,
        predecessorBindingId: intent.predecessorBindingId,
        successorBindingId: intent.successorBindingId,
        baseEditableSiteModel: intent.baseEditableSiteModel,
        editableSiteModel: intent.editableSiteModel,
        sourceCommit: intent.sourceCommit,
        source: intent.source,
        jobId: intent.jobId,
      });
      const harnessRecords = (await workspace.dirtyPaths()).filter((p) => p.startsWith('decisions/'));
      await ensureSpecificationCommitted(store, workspace, successor, plan, harnessRecords);

      const coordinator = createFrontendBackendLifecycleCoordinator({
        store,
        registry,
        engine: new JobEngine(store),
        model,
        workerIdentity: { workerId: `semantic-edit:${projectId}:frontend-backend`, tier: 'terra' },
        workspacesRoot: deps.workspacesRoot,
        validationWorkspacesRoot: deps.validationWorkspacesRoot,
        ...(deps.advisoryWorkspacesRoot !== undefined ? { advisoryWorkspacesRoot: deps.advisoryWorkspacesRoot } : {}),
        say,
      });
      say({ phase: 'build', detail: `Implementing semantic edit ${intent._id} via job_lifecycle (job ${intent.jobId})` });
      const built = await coordinator.run(intent.jobSpec, { kind: 'semantic_edit', intentId: intent._id });
      if (built.outcome !== 'promoted') {
        say({ phase: 'build', detail: `semantic edit ${intent._id} did not promote this invocation (${built.outcome})`, level: 'fail' });
        return resultOf(intent, replayed, { lifecycleOutcome: built.outcome });
      }
      await finalizeBindingPromoted(store, successor._id, { promotionId: built.promotionId, promotionCommitSha: built.commitSha });
      promoted = { promotionId: built.promotionId, promotionCommitSha: built.commitSha };
    }
    intent = await advanceIntent(store, intent, 'building', 'promoted', { promotion: promoted });
    if (intent.status === 'completed') return resultOf(intent, true);
  }

  const successor = await store.frontendBackendBuildBindings.findOne({ _id: intent.successorBindingId, projectId });
  const promotion = intent.promotion;
  if (!successor || !promotion || successor.status !== 'promoted' || successor.promotionId !== promotion.promotionId || successor.promotionCommitSha !== promotion.promotionCommitSha) {
    throw corrupt(`successor "${intent.successorBindingId}" is not promoted by the promotion semantic edit "${intent._id}" recorded`);
  }
  // Re-proven now: the draft still handed to this edit, and its lineage ending at exactly this successor.
  const handed = await resolveCanonicalDraftAuthority(store, projectId);
  if (successor.predecessorBindingId !== predecessor._id || handed?.state !== 'handed_off' || handed.draft._id !== intent.sourceDraftId || handed.tip._id !== successor._id) {
    throw corrupt(`successor "${successor._id}" is not the structural tip after "${predecessor._id}"`);
  }
  const receipt = await store.promotions.findOne({ _id: promotion.promotionId });
  if (!receipt || receipt.projectId !== projectId || receipt.jobId !== successor.jobId || receipt.status !== 'committed' || receipt.commitSha !== promotion.promotionCommitSha) {
    throw corrupt(`promotion receipt "${promotion.promotionId}" does not prove successor "${successor._id}"`);
  }
  const marked = await workspace.findCommitsByMarker(promotionMarker(promotion.promotionId));
  if (marked.length !== 1 || marked[0] !== promotion.promotionCommitSha) throw corrupt(`canonical history does not carry exactly one commit for promotion "${promotion.promotionId}"`);

  if (intent.status === 'promoted') {
    // Fresh gates, render, screenshots and review of exactly this successor — never the predecessor's, and nothing after them.
    const projectDoc = await store.projects.findOne({ _id: projectId });
    const budgetDoc = await store.budgets.findOne({ _id: projectId });
    if (!projectDoc || !budgetDoc) throw corrupt('the project or budget document is missing');
    const progress = createRunProgress();
    progress.plan = plan;
    const ctx: RunContext = {
      deps: { store, registry, workspace, model, say },
      facts: { projectId, profile, autonomyMode: projectDoc.autonomyMode, budgetLimits: budgetDoc.limits },
      progress: snapshotProgress(progress),
    };
    const evaluation = await evaluateSite(ctx, {
      sitePlan: successor.sitePlan,
      editableSiteModel: intent.editableSiteModel,
      authority: { mode: 'job_lifecycle', buildBindingId: successor._id, promotionId: promotion.promotionId, promotionCommitSha: promotion.promotionCommitSha },
    });
    if (evaluation.kind === 'review_unavailable') {
      say({ phase: 'evaluate', detail: `semantic edit ${intent._id}: review unavailable (${evaluation.reason})`, level: 'fail' });
      return resultOf(intent, replayed, { evaluationUnavailable: evaluation.reason });
    }
    intent = await advanceIntent(store, intent, 'promoted', 'evaluated', {
      evaluation: {
        testReport: evaluation.testReport,
        screenshotSet: evaluation.screenshotSet,
        visualQualityReview: evaluation.visualQualityReview?.ref ?? null,
        gatesPassed: evaluation.compiled.ok && evaluation.gateRun.passed,
        qualityScore: evaluation.qualityScore,
      },
    });
    if (intent.status === 'completed') return resultOf(intent, true);
  }

  if (intent.status !== 'evaluated' || !intent.evaluation) throw corrupt(`semantic edit "${intent._id}" is "${intent.status}" with no evaluation`);
  if (intent.evaluation.screenshotSet) {
    const set = await registry.resolve<{ subject?: { authority?: { buildBindingId?: string } } }>(projectId, intent.evaluation.screenshotSet);
    if (set.subject?.authority?.buildBindingId !== successor._id) throw corrupt(`the recorded screenshot set was not rendered from successor "${successor._id}"`);
  }

  // One transaction: the successor concluded as the new draft, the handed-off draft superseded, the lineage released, this edit completed.
  const evaluatedIntent = intent;
  const { draft } = await concludeCanonicalDraft({
    store,
    workspace,
    projectId,
    canonicalBindingId: successor._id,
    promotion,
    supersede: { draftId: intent.sourceDraftId, claimant },
    completeInTransaction: async (session, concluded, alreadyConcluded) => {
      const done = await store.semanticEditIntents.updateOne(
        { _id: evaluatedIntent._id, projectId, status: 'evaluated' },
        { $set: { status: 'completed', resultDraftId: concluded._id, updatedAt: new Date() } },
        { session },
      );
      if (done.matchedCount === 1) return;
      const current = await store.semanticEditIntents.findOne({ _id: evaluatedIntent._id }, { session });
      if (!alreadyConcluded || current?.status !== 'completed' || current.resultDraftId !== concluded._id) {
        throw corrupt(`semantic edit "${evaluatedIntent._id}" could not be completed with draft "${concluded._id}"`);
      }
    },
  });
  say({ phase: 'build', detail: `semantic edit ${intent._id} concluded as draft ${draft._id}`, level: 'ok' });
  const completed = await store.semanticEditIntents.findOne({ _id: intent._id });
  if (!completed || completed.status !== 'completed') throw corrupt(`semantic edit "${intent._id}" did not complete`);
  return resultOf(completed, replayed);
}
