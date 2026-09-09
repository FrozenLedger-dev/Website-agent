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
import type { FrontendBackendBuildBindingDocument, StateStore } from '@statxai/state';
import { contentHash, type ProjectWorkspace } from '@statxai/workspace';
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
