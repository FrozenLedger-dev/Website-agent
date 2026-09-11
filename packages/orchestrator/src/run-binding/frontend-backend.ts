/**
 * Durable active `frontend_backend` job-mode build binding (Phase 5k).
 *
 * Phase 5i can resume an existing job given the exact same immutable
 * `JobSpec`/`jobId` again — but nothing durable told a fresh `runProject`
 * invocation *which* one to ask for. Left alone, a restart re-ran discovery
 * and planning, which could legitimately produce a newer `businessProfile`/
 * `sitePlan` version — and therefore a different deterministic `JobSpec`/
 * `jobId` — for a build Phase 5i might already be partway through
 * executing under the old one.
 *
 * This module is the smallest durable record that closes that gap: at most
 * one unfinished ("prepared") binding per project, storing the exact
 * pinned `businessProfile`/`sitePlan` refs and the *exact* `JobSpec` (not
 * only its hash — a future code deployment could change the factory's
 * defaults, and reconstructing the spec from new code on resume could
 * silently address a different request than the one already in flight).
 * Once Phase 5i returns `promoted`, the binding is finalised `-> promoted`
 * and kept as historical evidence, exactly mirroring `JobPromotionRecord`'s
 * own `prepared -> committed` shape and its project-scoped partial-unique
 * "one active slot" index.
 *
 * What this module deliberately is not: a general outer-run resume cursor.
 * It resumes one incomplete `frontend_backend` build. Nothing here persists
 * where `runProject` is in evaluation, review, repair, or release — a
 * process that dies after `promoted` but before the run concludes still has
 * to redo that part from scratch on its next invocation (a later capability
 * this phase does not implement — see `docs/upgrade-status.md`).
 */
import { JobSpec, type ArtifactRef, type BusinessProfile, type SitePlan } from '@statxai/contracts';
import type { FrontendBackendBuildBindingDocument, JobDocument, StateStore } from '@statxai/state';
import { contentHash, type ProjectWorkspace } from '@statxai/workspace';
import type { JobEngine } from '@statxai/job-engine';
import { FRONTEND_BACKEND_INPUT } from '../job-handlers/frontend-backend.js';
import { BUSINESS_PROFILE_ARTIFACT_PATH, materialiseBusinessProfileFile } from '../phases/discover.js';
import { materialiseSitePlanFiles, sitePlanArtifactPaths } from '../phases/planning.js';

const ROLE = 'frontend_backend';

/**
 * The canonical workspace carried an uncommitted change outside the exact
 * set discovery/planning (or, on resume, their re-materialised equivalent)
 * are known to have written, right before the specification commit — the
 * same "nothing foreign rides along" discipline Phase 5h's own promotion
 * guard applies to its commit. Never silently swept into a commit whose
 * message claims to be only the specification: a stray file left by
 * something else stays uncommitted, and this invocation stops before Phase
 * 5i ever runs.
 */
export class RunProjectSpecificationWorkingTreeDirty extends Error {
  constructor(projectId: string, paths: readonly string[]) {
    super(
      `runProject "${projectId}": the canonical working tree has uncommitted changes outside the ` +
        `discovered/planned specification: ${paths.join(', ')}`,
    );
    this.name = 'RunProjectSpecificationWorkingTreeDirty';
  }
}

/**
 * The project already has a `prepared` binding for a *different* logical
 * request (a different `runIntentHash`) than the one this invocation just
 * validated. Thrown before any discovery/planning side effect — the
 * existing binding is never resumed silently, destroyed, or raced past.
 */
export class FrontendBackendBuildBindingConflict extends Error {
  constructor(projectId: string, existingRunIntentHash: string, incomingRunIntentHash: string) {
    super(
      `project "${projectId}" already has an active frontend_backend build binding for a different ` +
        `request (runIntentHash "${existingRunIntentHash}"); refusing to start a new one ` +
        `(incoming runIntentHash "${incomingRunIntentHash}") while it remains unfinished`,
    );
    this.name = 'FrontendBackendBuildBindingConflict';
  }
}

/**
 * A durable binding exists but does not describe a consistent, trustworthy
 * request — its stored `JobSpec` does not parse, disagrees with its own
 * `jobSpecHash`, or disagrees with the `businessProfile`/`sitePlan` refs
 * recorded alongside it. Never silently repaired by rerunning discovery or
 * substituting newer artifacts.
 */
export class FrontendBackendBuildBindingCorrupt extends Error {
  constructor(bindingId: string, detail: string) {
    super(`frontend_backend build binding "${bindingId}" is corrupt — ${detail}`);
    this.name = 'FrontendBackendBuildBindingCorrupt';
  }
}

/**
 * A `prepared` binding's recorded `specificationBaseCommit` no longer
 * equals canonical HEAD, and no commit carrying this binding's marker
 * exists yet — some other canonical write landed on this project's lineage
 * in between. Fails closed rather than silently building the bound
 * specification onto an unexpected history.
 */
export class FrontendBackendBuildBindingBaseConflict extends Error {
  constructor(projectId: string, bindingId: string, baseCommit: string | null, currentCommit: string | null) {
    super(
      `project "${projectId}" binding "${bindingId}": canonical HEAD (${currentCommit ?? 'null'}) no longer ` +
        `matches the commit this binding was prepared against (${baseCommit ?? 'null'}); refusing to create ` +
        `the specification commit`,
    );
    this.name = 'FrontendBackendBuildBindingBaseConflict';
  }
}

/** The working tree already matched canonical HEAD exactly after re-materialising the bound specification, yet no marker was found beforehand either. Not expected in ordinary operation. */
export class FrontendBackendBuildBindingSpecificationCommitProducedNothing extends Error {
  constructor(bindingId: string) {
    super(`frontend_backend build binding "${bindingId}": materialising the bound specification produced no changes to commit`);
    this.name = 'FrontendBackendBuildBindingSpecificationCommitProducedNothing';
  }
}

/**
 * A `prepared` binding exists, but durable state resume depends on — the
 * project document, its budget — no longer exists. A resume path reads
 * this state rather than recreating it (§21/§22/§23 of the brief this
 * shipped under: resetting it would be indistinguishable from starting
 * over, which is exactly what a binding exists to prevent), so its absence
 * is control-plane corruption, never repaired by rerunning discovery.
 */
export class FrontendBackendBuildBindingResumeStateMissing extends Error {
  constructor(projectId: string, bindingId: string, what: string) {
    super(`project "${projectId}" binding "${bindingId}": cannot resume — ${what} is missing from durable state`);
    this.name = 'FrontendBackendBuildBindingResumeStateMissing';
  }
}

/** More than one commit in canonical history carries this binding's exact marker — genuine corruption, since this binding's deterministic identity is only ever committed once by construction. Never resolved by picking the newest. */
export class FrontendBackendBuildBindingMarkerCorrupt extends Error {
  constructor(bindingId: string, shas: readonly string[]) {
    super(
      `frontend_backend build binding "${bindingId}": ${shas.length} commits carry its exact specification ` +
        `marker (expected at most 1): ${shas.join(', ')}`,
    );
    this.name = 'FrontendBackendBuildBindingMarkerCorrupt';
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * What identifies a fresh invocation as trying to resume the *same* logical
 * request as an existing binding — the canonical, schema-validated harness
 * input that controls pre-build semantics, never the raw unparsed intake
 * (stripped-unknown-field or property-ordering differences in two raw
 * payloads that parse to the same profile must not manufacture a different
 * fingerprint) and never runtime-only detail (callbacks, the `ModelClient`
 * instance, filesystem roots, the clock, worker lease timings). `autonomyMode`
 * is deliberately excluded too: it is stored on the project document and
 * read later by the adjudication/terminal-decision policy, but it does not
 * change discovery's persistence, planning, or `JobSpec` construction, so
 * it is not part of *this* fingerprint's job — see
 * `docs/upgrade-status.md`'s Phase 5k section for this reasoning stated in
 * full.
 */
export interface RunIntent {
  readonly projectId: string;
  readonly profile: BusinessProfile;
}

export function computeRunIntentHash(intent: RunIntent): string {
  return contentHash({ projectId: intent.projectId, profile: intent.profile });
}

interface BindingIdentity {
  readonly projectId: string;
  readonly runIntentHash: string;
  readonly jobSpecHash: string;
}

/**
 * Deterministic from immutable authority alone — never `Date.now()`, a
 * random id, `attempt`, `workerId`, a lease, an artifact `lineageSeq`, a
 * `RunRecorder` sequence, or a promotion commit SHA. The same
 * `(projectId, runIntentHash, jobSpecHash)` always names the same binding,
 * which is what lets two racing fresh invocations for the same request
 * converge on one durable record instead of ever creating two.
 */
export function computeBindingId(identity: BindingIdentity): string {
  return `frontend-backend-build-${contentHash(identity)}`;
}

/** The one canonical hash of a full, exact `JobSpec` (jobId included) this module hashes with anywhere — reused for both `jobSpecHash` and its own consistency check, never a second scheme. */
export function computeJobSpecHash(spec: JobSpec): string {
  return contentHash(spec);
}

export function bindingMarker(bindingId: string): string {
  return `Statx-Build-Binding-Id: ${bindingId}`;
}

export function specificationCommitMessage(bindingId: string): string {
  return `Harness: specification\n\n${bindingMarker(bindingId)}`;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function findActivePreparedBinding(
  store: StateStore,
  projectId: string,
): Promise<FrontendBackendBuildBindingDocument | null> {
  return store.frontendBackendBuildBindings.findOne({ projectId, status: 'prepared' });
}

// ---------------------------------------------------------------------------
// Stored-spec integrity
// ---------------------------------------------------------------------------

/** Parse the binding's stored `JobSpec` through the real contract — never trusted as arbitrary Mongo shape. Fails closed on anything that does not parse. */
export function parseStoredJobSpec(binding: FrontendBackendBuildBindingDocument): JobSpec {
  const parsed = JobSpec.safeParse(binding.jobSpec);
  if (!parsed.success) {
    throw new FrontendBackendBuildBindingCorrupt(
      binding._id,
      `stored jobSpec does not parse: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

/** Exact `ArtifactRef` field equality — `name`/`version` always, `contentHash` only when both sides carry one. Never object identity. */
function sameRef(a: ArtifactRef, b: ArtifactRef): boolean {
  if (a.name !== b.name || a.version !== b.version) return false;
  if (a.contentHash !== undefined && b.contentHash !== undefined) return a.contentHash === b.contentHash;
  return true;
}

/**
 * Re-prove that a binding and the spec it claims to store still agree,
 * before either is trusted for resume: `projectId`, `jobId`, `role`, the
 * full-spec hash, and both pinned inputs. Any disagreement is durable
 * corruption — a hand-edited or otherwise inconsistent record — and is
 * never silently repaired.
 */
export function verifyBindingConsistency(binding: FrontendBackendBuildBindingDocument, spec: JobSpec): void {
  if (binding.projectId !== spec.projectId) {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, 'binding.projectId does not match spec.projectId');
  }
  if (binding.jobId !== spec.jobId) {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, 'binding.jobId does not match spec.jobId');
  }
  if (spec.role !== ROLE) {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, `spec.role is "${spec.role}", not "${ROLE}"`);
  }
  if (computeJobSpecHash(spec) !== binding.jobSpecHash) {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, 'jobSpecHash does not match the stored spec content');
  }
  const specProfileRef = spec.inputs[FRONTEND_BACKEND_INPUT.businessProfile];
  const specPlanRef = spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan];
  if (!specProfileRef || !sameRef(specProfileRef, binding.businessProfile)) {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, 'spec businessProfile input does not match binding.businessProfile');
  }
  if (!specPlanRef || !sameRef(specPlanRef, binding.sitePlan)) {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, 'spec sitePlan input does not match binding.sitePlan');
  }
}

// ---------------------------------------------------------------------------
// Fresh-path preparation
// ---------------------------------------------------------------------------

export interface PrepareBindingInput {
  readonly projectId: string;
  readonly runIntentHash: string;
  readonly businessProfileRef: ArtifactRef;
  readonly sitePlanRef: ArtifactRef;
  readonly jobSpec: JobSpec;
  /** Canonical HEAD at the moment of preparation, before the specification commit — `null` for a project's first-ever commit. */
  readonly specificationBaseCommit: string | null;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Idempotent ensure/create, never a raw insert relied on to always succeed.
 * Two fresh invocations that independently derive the *same* exact binding
 * (same project, same run intent, same immutable `JobSpec`) converge on the
 * one durable record — whichever wins the insert, the other recovers it and
 * verifies it matches rather than treating the duplicate-key error as
 * failure. A concurrent *different* request for the same project — a
 * different `runIntentHash` or a different `JobSpec` — is refused with
 * {@link FrontendBackendBuildBindingConflict} rather than ever overwriting
 * the winner or coexisting with it.
 */
export async function prepareFrontendBackendBuildBinding(
  store: StateStore,
  input: PrepareBindingInput,
): Promise<FrontendBackendBuildBindingDocument> {
  const jobSpecHash = computeJobSpecHash(input.jobSpec);
  const bindingId = computeBindingId({ projectId: input.projectId, runIntentHash: input.runIntentHash, jobSpecHash });

  const existing = await store.frontendBackendBuildBindings.findOne({ _id: bindingId });
  if (existing) {
    verifyBindingConsistency(existing, input.jobSpec);
    return existing;
  }

  const now = new Date();
  const prepared: FrontendBackendBuildBindingDocument = {
    _id: bindingId,
    projectId: input.projectId,
    status: 'prepared',
    runIntentHash: input.runIntentHash,
    businessProfile: input.businessProfileRef,
    sitePlan: input.sitePlanRef,
    jobSpec: input.jobSpec,
    jobSpecHash,
    jobId: input.jobSpec.jobId,
    specificationBaseCommit: input.specificationBaseCommit,
    specificationCommitSha: null,
    promotionId: null,
    promotionCommitSha: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await store.frontendBackendBuildBindings.insertOne(prepared);
    return prepared;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // Either this exact binding raced with itself (recover it below), or
    // the project-scoped partial index refused a *different* prepared
    // binding for this project — distinguished by whether this exact `_id`
    // exists now, not by parsing the driver's error shape.
    const raced = await store.frontendBackendBuildBindings.findOne({ _id: bindingId });
    if (raced) {
      verifyBindingConsistency(raced, input.jobSpec);
      return raced;
    }
    const other = await store.frontendBackendBuildBindings.findOne({ projectId: input.projectId, status: 'prepared' });
    throw new FrontendBackendBuildBindingConflict(input.projectId, other?.runIntentHash ?? '(unknown)', input.runIntentHash);
  }
}

// ---------------------------------------------------------------------------
// Resume-recovery re-materialisation
// ---------------------------------------------------------------------------

/**
 * Write the exact bound `businessProfile`/`sitePlan` content into the same
 * canonical specification paths the fresh path writes — used only on
 * resume, when this invocation never ran discovery/planning and so never
 * wrote them itself. Reuses the exact same materialisation helpers
 * `discoverProject`/`persistPlan` use, never a second writer, and never
 * creates a new `ArtifactRegistry` version — `profile`/`plan` are already
 * the exact resolved content of the bound refs. Idempotent: writing the
 * same content again over a partial prior attempt reproduces the same
 * working tree either way.
 */
export async function rehydrateSpecificationFiles(
  workspace: ProjectWorkspace,
  profile: BusinessProfile,
  plan: SitePlan,
): Promise<void> {
  await materialiseBusinessProfileFile(workspace, profile);
  await materialiseSitePlanFiles(workspace, plan);
}

// ---------------------------------------------------------------------------
// Replay-safe specification commit
// ---------------------------------------------------------------------------

/**
 * Make the pre-Phase-5i handoff restart-safe, exactly as Phase 5h's own
 * promotion is: search canonical history for a commit already carrying
 * this binding's exact marker before ever writing one, so a crash between
 * a successful Git commit and this record being updated is recoverable —
 * the commit itself is the evidence, and this is where a retry finds it.
 *
 *   found, exactly one: verify it agrees with any already-recorded
 *     `specificationCommitSha`, finalise the binding's own record if it
 *     was still unset, and return — no second commit is ever created.
 *   found, more than one: {@link FrontendBackendBuildBindingMarkerCorrupt}
 *     — this binding's deterministic identity is only ever committed once
 *     by construction; never resolved by choosing the newest.
 *   not found: canonical HEAD must still equal `binding.specificationBaseCommit`
 *     ({@link FrontendBackendBuildBindingBaseConflict} otherwise — someone
 *     else's canonical write landed first), the working tree must carry
 *     nothing beyond the exact expected specification paths
 *     ({@link RunProjectSpecificationWorkingTreeDirty} otherwise), then
 *     commit once with the marker and finalise the record.
 *
 * Once a marker commit exists and the record reflects it, calling this
 * again is a pure read-and-verify: the same SHA, no new commit, no store
 * write.
 */
export async function ensureSpecificationCommitted(
  store: StateStore,
  workspace: ProjectWorkspace,
  binding: FrontendBackendBuildBindingDocument,
  plan: SitePlan,
): Promise<string> {
  const marker = bindingMarker(binding._id);
  const shas = await workspace.findCommitsByMarker(marker);

  if (shas.length > 1) {
    throw new FrontendBackendBuildBindingMarkerCorrupt(binding._id, shas);
  }

  if (shas.length === 1) {
    const existingSha = shas[0]!;
    if (binding.specificationCommitSha && binding.specificationCommitSha !== existingSha) {
      throw new FrontendBackendBuildBindingCorrupt(
        binding._id,
        'recorded specificationCommitSha does not match the commit found under its own marker',
      );
    }
    if (!binding.specificationCommitSha) {
      await store.frontendBackendBuildBindings.updateOne(
        { _id: binding._id, status: 'prepared' },
        { $set: { specificationCommitSha: existingSha, updatedAt: new Date() } },
      );
    }
    return existingSha;
  }

  // No marker anywhere yet — genuinely never committed. Before writing
  // anything, canonical lineage must still be exactly what this binding was
  // prepared against.
  const currentHead = await workspace.currentCommit();
  if (currentHead !== binding.specificationBaseCommit) {
    throw new FrontendBackendBuildBindingBaseConflict(binding.projectId, binding._id, binding.specificationBaseCommit, currentHead);
  }

  const expectedSpecificationPaths = new Set([BUSINESS_PROFILE_ARTIFACT_PATH, ...sitePlanArtifactPaths(plan)]);
  const dirty = await workspace.dirtyPaths();
  const unexpected = dirty.filter((path) => !expectedSpecificationPaths.has(path));
  if (unexpected.length > 0) {
    throw new RunProjectSpecificationWorkingTreeDirty(binding.projectId, unexpected);
  }

  const commitSha = await workspace.commit(specificationCommitMessage(binding._id));
  if (!commitSha) {
    throw new FrontendBackendBuildBindingSpecificationCommitProducedNothing(binding._id);
  }

  await store.frontendBackendBuildBindings.updateOne(
    { _id: binding._id, status: 'prepared' },
    { $set: { specificationCommitSha: commitSha, updatedAt: new Date() } },
  );

  return commitSha;
}

// ---------------------------------------------------------------------------
// Finalisation
// ---------------------------------------------------------------------------

/**
 * `prepared -> promoted`, guarded and idempotent. Called only once Phase 5i
 * itself has returned `promoted` — never speculatively, never before. If
 * the Mongo write fails after a successful Phase 5h promotion, the binding
 * is deliberately left `prepared`: the promotion itself is never undone,
 * and a later invocation resumes the same binding, replays Phase 5i (a
 * pure read-and-verify at that point — no second Terra attempt, validation,
 * acceptance, or promotion commit) and retries only this finalisation.
 * Re-finalising an already-`promoted` binding with the same promotion
 * identity is a safe no-op.
 */
export async function finalizeBindingPromoted(
  store: StateStore,
  bindingId: string,
  promotion: { readonly promotionId: string; readonly promotionCommitSha: string },
): Promise<void> {
  const existing = await store.frontendBackendBuildBindings.findOne({ _id: bindingId });
  if (!existing) {
    throw new FrontendBackendBuildBindingCorrupt(bindingId, 'binding disappeared from durable state before finalisation');
  }
  if (existing.status === 'promoted') {
    if (existing.promotionId !== promotion.promotionId || existing.promotionCommitSha !== promotion.promotionCommitSha) {
      throw new FrontendBackendBuildBindingCorrupt(
        bindingId,
        'already promoted under a different promotionId/promotionCommitSha than this replay just reported',
      );
    }
    return;
  }
  await store.frontendBackendBuildBindings.updateOne(
    { _id: bindingId, status: 'prepared' },
    {
      $set: {
        status: 'promoted',
        promotionId: promotion.promotionId,
        promotionCommitSha: promotion.promotionCommitSha,
        updatedAt: new Date(),
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Explicit abandonment (Phase 5m)
// ---------------------------------------------------------------------------

/**
 * No `prepared` binding exists under this exact `bindingId` at all — never
 * yet created, or a typo. Never substituted for "the project's current
 * active binding": a stale operator request must fail on the exact id it
 * named, not silently fall back to whatever is active now.
 */
export class FrontendBackendBuildBindingNotFound extends Error {
  constructor(bindingId: string) {
    super(`frontend_backend build binding "${bindingId}" does not exist`);
    this.name = 'FrontendBackendBuildBindingNotFound';
  }
}

/**
 * The exact binding named by `bindingId` exists, but for a different
 * project than the caller supplied. Fails closed rather than abandoning a
 * binding under a project id the caller did not actually intend — the
 * exact-identity guard `abandonFrontendBackendBuild`'s own brief requires.
 */
export class FrontendBackendBuildBindingProjectMismatch extends Error {
  constructor(requestedProjectId: string, bindingId: string, actualProjectId: string) {
    super(
      `frontend_backend build binding "${bindingId}" belongs to project "${actualProjectId}", not the requested ` +
        `"${requestedProjectId}"; refusing to abandon it`,
    );
    this.name = 'FrontendBackendBuildBindingProjectMismatch';
  }
}

/** `reason` was empty, whitespace-only, or exceeded {@link MAX_ABANDONMENT_REASON_LENGTH}. */
export class FrontendBackendBuildAbandonmentReasonInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontendBackendBuildAbandonmentReasonInvalid';
  }
}

/**
 * The binding's own `jobId` names a `JobDocument` that does not actually
 * describe the same request — a different project, a different role, or a
 * `JobSpec` that no longer content-hashes the same as the binding's own
 * stored one. Genuine control-plane corruption (this should never happen
 * given how the binding and the job are both created), never silently
 * proceeded past.
 */
export class FrontendBackendBuildAbandonmentJobMismatch extends Error {
  constructor(bindingId: string, jobId: string, detail: string) {
    super(`frontend_backend build binding "${bindingId}": job "${jobId}" does not match this binding — ${detail}`);
    this.name = 'FrontendBackendBuildAbandonmentJobMismatch';
  }
}

/**
 * The exact bound job is already `accepted`. Phase 5m's own scope boundary
 * (see `docs/upgrade-status.md`'s Phase 5m section). Phase 5n narrows this:
 * an accepted job *may* now be abandoned, but only while promotion has not
 * yet obtained the durable fence that proves it owns canonical publication
 * authority — see {@link FrontendBackendBuildPromotionOwned} below for the
 * case where it already has.
 */

/**
 * The exact bound job is `accepted` and already owns a durable promotion
 * fence (Phase 5n, `JobPromotionFence` — `@statxai/contracts`) — promotion
 * has already obtained authority over it, so abandonment loses and must
 * not touch either the job or the binding. This is not "Git hasn't
 * happened yet, so it's safe" — the fence itself, not any canonical
 * filesystem/Git evidence, is what promotion authority means; it may exist
 * before a single file has been written. The binding stays `prepared`; the
 * job stays `accepted`; the fence is never cleared or modified.
 */
export class FrontendBackendBuildPromotionOwned extends Error {
  constructor(projectId: string, bindingId: string, jobId: string, promotionId: string) {
    super(
      `project "${projectId}" binding "${bindingId}": job "${jobId}" is accepted and already owns promotion fence ` +
        `"${promotionId}"; refusing to abandon — promotion already holds authority over it`,
    );
    this.name = 'FrontendBackendBuildPromotionOwned';
  }
}

/**
 * A `JobPromotionRecord` already exists for the exact bound job, regardless
 * of its current state or whether it owns a `promotionFence`. This is
 * Phase 5m's own original check, preserved unchanged for backward
 * compatibility with durable state written before Phase 5n's fence
 * existed: a legacy `prepared`/`committed` receipt is already promotion
 * evidence in its own right, and must continue to block abandonment even
 * though no fence was ever backfilled onto the job that produced it. For
 * fence-bearing jobs this fires only as defense in depth — normally
 * {@link FrontendBackendBuildPromotionOwned} (checked first, for `accepted`
 * jobs) already caught it. Reaching this for a job that is *not* accepted,
 * or has no fence, means durable state disagrees with itself: control-plane
 * inconsistency to report, never permission to clean up.
 */
export class FrontendBackendBuildAbandonmentPromotionEvidenceConflict extends Error {
  constructor(projectId: string, bindingId: string, jobId: string) {
    super(
      `project "${projectId}" binding "${bindingId}": job "${jobId}" already has promotion evidence; refusing to ` +
        `abandon — contradictory durable state, not repaired here`,
    );
    this.name = 'FrontendBackendBuildAbandonmentPromotionEvidenceConflict';
  }
}

/**
 * The exact bound `accepted` job already has another `JobDocument`
 * depending on it (`dependsOn`) — `JobEngine.dependenciesSatisfied` may
 * already be treating this job's acceptance as having authorised that
 * dependent to run. Phase 5n does not attempt to recursively revoke a
 * dependency graph; it fails closed instead, leaving the accepted job,
 * its dependent, and the binding exactly as they were.
 */
export class FrontendBackendBuildAbandonmentDownstreamDependency extends Error {
  constructor(projectId: string, bindingId: string, jobId: string, dependentJobId: string) {
    super(
      `project "${projectId}" binding "${bindingId}": job "${jobId}" has a downstream dependent ("${dependentJobId}"); ` +
        `refusing to abandon — Phase 5n does not revoke a dependency graph`,
    );
    this.name = 'FrontendBackendBuildAbandonmentDownstreamDependency';
  }
}

/** Generous enough for a real operator explanation, bounded so this is never an unlimited free-text field. No existing shared limit exists elsewhere in this codebase for a human-authored reason string, so this is Phase 5m's own. */
export const MAX_ABANDONMENT_REASON_LENGTH = 2000;

/**
 * Non-empty after trimming, and within {@link MAX_ABANDONMENT_REASON_LENGTH}
 * — the one validation `abandonFrontendBackendBuild` applies to `reason`
 * before anything durable is touched. The trimmed value, not the raw one, is
 * what gets persisted: incidental leading/trailing whitespace is not part of
 * the operator's actual explanation.
 */
export function validateAbandonmentReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new FrontendBackendBuildAbandonmentReasonInvalid('abandonment reason must not be empty or whitespace-only');
  }
  if (trimmed.length > MAX_ABANDONMENT_REASON_LENGTH) {
    throw new FrontendBackendBuildAbandonmentReasonInvalid(
      `abandonment reason exceeds ${MAX_ABANDONMENT_REASON_LENGTH} characters (got ${trimmed.length})`,
    );
  }
  return trimmed;
}

export interface AbandonFrontendBackendBuildInput {
  readonly projectId: string;
  /** The exact binding to abandon — never inferred from "the project's current active binding". */
  readonly bindingId: string;
  /**
   * Harness/operator identity. Never a raw HTTP request body field — a real
   * caller derives this from its own authenticated context before calling
   * here. This function does not, and cannot, verify who `actor` really is;
   * it only records what it is told.
   */
  readonly actor: string;
  readonly reason: string;
}

export interface AbandonFrontendBackendBuildDeps {
  readonly store: StateStore;
  readonly engine: JobEngine;
}

export type FrontendBackendBuildAbandonmentResult =
  | {
      readonly outcome: 'abandoned';
      readonly binding: FrontendBackendBuildBindingDocument;
      /** `null` when Phase 5k's own crash point applied: a binding existed but Phase 5i had never enqueued its job yet. */
      readonly supersededJobId: string | null;
    }
  | {
      /** Idempotent replay: this exact binding was already abandoned, by this call or an earlier one. No second transition, no second audit entry. */
      readonly outcome: 'already_abandoned';
      readonly binding: FrontendBackendBuildBindingDocument;
    }
  | {
      /** The binding already reached `promoted` — historical, successful, and never turned into `abandoned` after the fact. */
      readonly outcome: 'already_promoted';
      readonly binding: FrontendBackendBuildBindingDocument;
    };

/**
 * Explicitly, durably abandon exactly one active `frontend_backend` build
 * binding, and — atomically, in the same Mongo transaction — permanently
 * supersede its job if one was ever enqueued (Phase 5m; extended to
 * `accepted` jobs by Phase 5n).
 *
 * No automatic trigger exists anywhere for this: not a timeout, not a lease
 * expiry, not `retry_ready`/`validation_failed`/`failed`/`repair_requested`.
 * A caller decides, explicitly, every time.
 *
 * Sequence, all inside one transaction (the Mongo driver retries the whole
 * callback on a transient conflict, so every read below is re-taken fresh on
 * a retry rather than trusted stale):
 *
 *   1. Load the binding by its exact `_id` — never "the project's current
 *      active one". Not found, or found under a different `projectId`, both
 *      fail closed before anything else is read.
 *   2. `status === 'abandoned'` or `'promoted'`: return the matching
 *      historical outcome. Read-only — no second transition, no mutation of
 *      a binding this call did not just abandon.
 *   3. `status === 'prepared'`: {@link verifyBindingConsistency} first — a
 *      corrupt binding is never abandoned blindly. Then, if `binding.jobId`
 *      names an existing `JobDocument`: verify it actually describes this
 *      binding's own request (project, role, exact `JobSpec`); fail closed
 *      on {@link FrontendBackendBuildAbandonmentPromotionEvidenceConflict}
 *      if a `JobPromotionRecord` already exists for it, regardless of
 *      state (Phase 5m's own check, preserved for legacy pre-fence
 *      receipts). Then, for an `accepted` job specifically (Phase 5n): fail
 *      closed on {@link FrontendBackendBuildPromotionOwned} if it already
 *      owns a `promotionFence`, or on
 *      {@link FrontendBackendBuildAbandonmentDownstreamDependency} if
 *      another job already depends on it; otherwise
 *      `engine.supersedeAcceptedBeforePromotion(...)`. For every other
 *      pre-acceptance state, the unchanged `engine.supersede(...)`. If no
 *      `JobDocument` exists yet (Phase 5k's own crash point — a binding
 *      prepared before Phase 5i ever enqueued), nothing is superseded and
 *      none is invented.
 *   4. Guarded `prepared -> abandoned`, recording `abandonedAt`/
 *      `abandonedBy`/`abandonmentReason`, in the same transaction as step 3's
 *      job transition — never one without the other, and never partially:
 *      if either write fails, the whole transaction aborts and the previous
 *      state (binding `prepared`, job whatever it was) is preserved exactly.
 *
 * The accepted-abandonment-vs-promotion race (Phase 5h's own
 * `acquirePromotionFence` call racing this one) is not solved with extra
 * locking — both sides read the job fresh inside their own transaction and
 * guard their write on the state/fence they just read, so MongoDB's own
 * transaction conflict/retry semantics give exactly one of two outcomes:
 * this transaction commits first (job `superseded`, binding `abandoned`;
 * Phase 5h's later, retried `acquirePromotionFence` call reads `state !==
 * 'accepted'` and throws `JobStateConflict`, before any canonical
 * mutation), or Phase 5h commits first (fence acquired; this transaction,
 * retried by the driver, reads the fence and throws
 * {@link FrontendBackendBuildPromotionOwned} — the binding is left exactly
 * `prepared`, for a human, or a later promotion-fencing capability's own
 * completion, to resolve). The mixed case — binding `abandoned` with the
 * job `accepted` and a fence — is not reachable by construction, not
 * merely tested for. The pre-Phase-5n race against `validating` (5g-2's own
 * acceptance transaction) still resolves the same way it always did:
 * `AcceptanceBindingStale` on the losing side, via `engine.supersede`'s
 * unchanged pre-acceptance guard.
 *
 * What this deliberately never does: delete the binding, the job, any
 * artifact, or any Git history; touch the canonical workspace; call
 * `git reset`/`revert`/commit anything; modify, clear, or retire a
 * `JobPromotionRecord` or a `promotionFence`; start a replacement build,
 * discovery, planning, a Terra call, or a Luna call. Abandonment stops
 * after revocation — what happens next is a separate, later, explicit
 * request. An accepted candidate's `acceptedAt` is untouched either way —
 * it remains durable, historical, accepted evidence; only the job that
 * held it is superseded, so it can never again reach promotion through
 * that job.
 */
export async function abandonFrontendBackendBuild(
  input: AbandonFrontendBackendBuildInput,
  deps: AbandonFrontendBackendBuildDeps,
): Promise<FrontendBackendBuildAbandonmentResult> {
  const reason = validateAbandonmentReason(input.reason);

  return deps.store.withTransaction(async (session) => {
    const binding = await deps.store.frontendBackendBuildBindings.findOne({ _id: input.bindingId }, { session });
    if (!binding) throw new FrontendBackendBuildBindingNotFound(input.bindingId);
    if (binding.projectId !== input.projectId) {
      throw new FrontendBackendBuildBindingProjectMismatch(input.projectId, input.bindingId, binding.projectId);
    }

    if (binding.status === 'abandoned') return { outcome: 'already_abandoned' as const, binding };
    if (binding.status === 'promoted') return { outcome: 'already_promoted' as const, binding };

    // Only 'prepared' remains. Never abandon corrupt binding state blindly.
    const spec = parseStoredJobSpec(binding);
    verifyBindingConsistency(binding, spec);

    const job: JobDocument | null = await deps.store.jobs.findOne({ _id: binding.jobId }, { session });

    let supersededJobId: string | null = null;
    if (job) {
      if (job.projectId !== binding.projectId || job.role !== ROLE) {
        throw new FrontendBackendBuildAbandonmentJobMismatch(binding._id, job._id, 'projectId or role does not match the binding');
      }
      if (contentHash(job.spec) !== contentHash(spec)) {
        throw new FrontendBackendBuildAbandonmentJobMismatch(binding._id, job._id, 'JobSpec no longer matches the binding\'s stored one');
      }

      // Phase 5m's own check, preserved unchanged: independent of
      // `job.state` or `promotionFence`, existing promotion evidence is
      // contradictory durable state that abandonment never repairs. This
      // is what still protects a legacy job promoted before Phase 5n's
      // fence existed, and never received a backfilled one.
      const promotionEvidence = await deps.store.promotions.findOne({ jobId: job._id }, { session });
      if (promotionEvidence) {
        throw new FrontendBackendBuildAbandonmentPromotionEvidenceConflict(binding.projectId, binding._id, job._id);
      }

      if (job.state === 'accepted') {
        // Phase 5n: an accepted job may be abandoned only while promotion
        // has not yet obtained fence authority over it, and only while
        // nothing already depends on its acceptance.
        const fence = job.promotionFence ?? null;
        if (fence) {
          throw new FrontendBackendBuildPromotionOwned(binding.projectId, binding._id, job._id, fence.promotionId);
        }
        const dependent = await deps.store.jobs.findOne({ dependsOn: job._id }, { session });
        if (dependent) {
          throw new FrontendBackendBuildAbandonmentDownstreamDependency(binding.projectId, binding._id, job._id, dependent._id);
        }
        const superseded = await deps.engine.supersedeAcceptedBeforePromotion(job._id, input.actor, {
          reason,
          bindingId: binding._id,
          session,
        });
        supersededJobId = superseded._id;
      } else {
        const superseded = await deps.engine.supersede(job._id, input.actor, {
          reason,
          bindingId: binding._id,
          session,
        });
        supersededJobId = superseded._id;
      }
    }

    const now = new Date();
    const updated = await deps.store.frontendBackendBuildBindings.findOneAndUpdate(
      { _id: binding._id, status: 'prepared' },
      {
        $set: {
          status: 'abandoned',
          abandonedAt: now,
          abandonedBy: input.actor,
          abandonmentReason: reason,
          updatedAt: now,
        },
      },
      { session, returnDocument: 'after' },
    );

    if (!updated) {
      // Defense in depth: under this module's own transaction semantics
      // (snapshot isolation, whole-callback retry on conflict) this branch
      // should be unreachable in practice — reclassified from what is
      // actually there rather than trusted to never happen.
      const fresh = await deps.store.frontendBackendBuildBindings.findOne({ _id: binding._id }, { session });
      if (!fresh) throw new FrontendBackendBuildBindingNotFound(binding._id);
      if (fresh.status === 'abandoned') return { outcome: 'already_abandoned' as const, binding: fresh };
      if (fresh.status === 'promoted') return { outcome: 'already_promoted' as const, binding: fresh };
      throw new FrontendBackendBuildBindingCorrupt(
        binding._id,
        'binding is still "prepared" but its own guarded abandonment update did not match',
      );
    }

    return { outcome: 'abandoned' as const, binding: updated, supersededJobId };
  });
}
