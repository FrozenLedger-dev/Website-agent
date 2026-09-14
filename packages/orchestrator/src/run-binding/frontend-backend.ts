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
import type { ClientSession } from 'mongodb';
import * as z from 'zod/v4';
import {
  BuildSuccessorProvenance,
  SemanticEditSuccessorProvenance,
  JobSpec,
  ReplanSuccessorProvenance,
  VisualRefinementSuccessorProvenance,
  type ArtifactRef,
  type BusinessProfile,
  type SitePlan,
} from '@statxai/contracts';
import type {
  FrontendBackendBuildBindingDocument,
  JobDocument,
  ReleaseBuildAuthority,
  StateStore,
} from '@statxai/state';
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
/**
 * The exact predecessor already has a different durable successor (Phase 5q0).
 *
 * Distinct from {@link FrontendBackendBuildBindingConflict}, which is about a
 * *different logical request* being mid-build for the project. This one is
 * about lineage: canonical build authority is a chain, and a predecessor may
 * be replaced once. A second, different replacement is refused rather than
 * allowed to branch it — including long after the first successor promoted,
 * because a promoted successor still means the predecessor was replaced.
 */
export class FrontendBackendBuildLineageConflict extends Error {
  constructor(
    readonly projectId: string,
    readonly predecessorBindingId: string,
    readonly existingSuccessorId: string,
    readonly incomingSuccessorId: string,
  ) {
    super(
      `frontend_backend build "${predecessorBindingId}" (project "${projectId}") already has successor ` +
        `"${existingSuccessorId}"; refusing to create a second, different successor ` +
        `"${incomingSuccessorId}" — canonical build lineage does not branch`,
    );
    this.name = 'FrontendBackendBuildLineageConflict';
  }
}

/**
 * An unfinished build lineage already owns this project.
 *
 * Distinct from both siblings above, and the distinction is the whole point.
 * {@link FrontendBackendBuildBindingConflict} is about a different request
 * being mid-build — something is `prepared` right now.
 * {@link FrontendBackendBuildLineageConflict} is about one predecessor being
 * replaced twice. This one is about project ownership across that gap: a
 * previous lineage promoted its build and its outer run never reached a
 * durable terminal state, so nothing is `prepared` yet the project is still
 * owned. Starting a fresh lineage there would strand the continuation
 * authority of work that is still live, so it is refused.
 */
export class FrontendBackendActiveLineageConflict extends Error {
  constructor(
    readonly projectId: string,
    readonly activeLineageRootBindingId: string,
    readonly incomingBindingId: string,
  ) {
    super(
      `project "${projectId}" is still owned by unfinished build lineage "${activeLineageRootBindingId}"; ` +
        `refusing to found a second lineage ("${incomingBindingId}") — the owning lineage releases the ` +
        `project only when its run reaches a durable terminal state`,
    );
    this.name = 'FrontendBackendActiveLineageConflict';
  }
}

/**
 * A replan successor's predecessor predates lineage-root identity and records
 * none, so which lineage the successor would join cannot be proven.
 *
 * Never guessed — not by walking back to whatever happens to have no
 * predecessor, and not by adopting the newest root. An unproven lineage is
 * precisely the ambiguity this capability exists to remove, so it fails closed
 * rather than manufacturing an answer a later reader would trust.
 */
export class FrontendBackendBuildLineageRootUnproven extends Error {
  constructor(
    readonly projectId: string,
    readonly predecessorBindingId: string,
  ) {
    super(
      `frontend_backend build "${predecessorBindingId}" (project "${projectId}") predates lineage-root ` +
        `identity and records none; refusing to derive a successor's lineage root from it`,
    );
    this.name = 'FrontendBackendBuildLineageRootUnproven';
  }
}

/**
 * The chain hanging off an exact lineage root is not a single well-formed
 * path. Reported rather than resolved: this answers "which build is current",
 * and silently choosing one branch of a corrupt chain is worse than refusing.
 */
export class FrontendBackendBuildLineageCorrupt extends Error {
  constructor(
    readonly projectId: string,
    readonly lineageRootBindingId: string,
    detail: string,
  ) {
    super(`frontend_backend build lineage "${lineageRootBindingId}" (project "${projectId}") is corrupt — ${detail}`);
    this.name = 'FrontendBackendBuildLineageCorrupt';
  }
}

/** A successor was presented with a reason that does not satisfy its contract. Refused before anything is written. */
export class FrontendBackendBuildSuccessorProvenanceInvalid extends Error {
  constructor(
    readonly predecessorBindingId: string,
    detail: string,
  ) {
    super(`successor of frontend_backend build "${predecessorBindingId}" has invalid provenance — ${detail}`);
    this.name = 'FrontendBackendBuildSuccessorProvenanceInvalid';
  }
}

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

/**
 * The exact root binding of the lineage that currently owns this project's
 * unfinished continuation authority, or `null` when nothing owns it.
 *
 * One indexed equality lookup against the project's active-lineage slot. Never
 * a scan of the project's bindings, never a sort, and above all never "the
 * newest promoted binding" — that answer is wrong the moment a project has had
 * more than one generation, which is exactly when the question gets asked.
 *
 * `null` means two different things that must not be conflated by the caller:
 * no unfinished work, or a legacy project whose bindings predate this slot. It
 * is deliberately not this function's job to tell them apart by guessing.
 */
export async function findActiveLineageRoot(
  store: StateStore,
  projectId: string,
): Promise<FrontendBackendBuildBindingDocument | null> {
  return store.frontendBackendBuildBindings.findOne({ projectId, activeLineage: true });
}

/**
 * Walk an exact lineage root forward to its current tip, structurally.
 *
 * Each step asks for the binding whose `predecessorBindingId` is the one in
 * hand; the `(projectId, predecessorBindingId)` unique index (Phase 5q0) is
 * what makes "the" well defined. So the answer comes from durable links alone
 * — no `createdAt`, no `sort`, no "newest promoted". `B0 -> B1 -> B2` returns
 * exactly `B2`.
 *
 * Abandoned and prepared members are part of the chain just as promoted ones
 * are: this reports where the lineage currently stands, not where it last
 * succeeded.
 *
 * Every way the chain could fail to be one well-formed path fails closed: a
 * root that records a predecessor or a foreign root, a branch, a successor in
 * another project or claiming another root, a cycle, or members that claim
 * this root without being reachable from it (an orphan, or a successor whose
 * predecessor is missing).
 */
export async function deriveActiveLineageTip(
  store: StateStore,
  root: FrontendBackendBuildBindingDocument,
): Promise<FrontendBackendBuildBindingDocument> {
  const rootId = root.lineageRootBindingId ?? root._id;

  if (lineagePositionOf(root, rootId).kind !== 'initial') {
    throw new FrontendBackendBuildLineageCorrupt(
      root.projectId,
      rootId,
      `root "${root._id}" records predecessor "${root.predecessorBindingId}" and so is not a root`,
    );
  }
  if (root.lineageRootBindingId !== undefined && root.lineageRootBindingId !== root._id) {
    throw new FrontendBackendBuildLineageCorrupt(
      root.projectId,
      rootId,
      `root "${root._id}" claims a different lineage root "${root.lineageRootBindingId}"`,
    );
  }

  const seen = new Set<string>([root._id]);
  let tip = root;

  for (;;) {
    const successors = await store.frontendBackendBuildBindings
      .find({ projectId: root.projectId, predecessorBindingId: tip._id })
      .toArray();

    if (successors.length > 1) {
      throw new FrontendBackendBuildLineageCorrupt(
        root.projectId,
        rootId,
        `build "${tip._id}" has ${successors.length} successors (${successors.map((s) => s._id).join(', ')}); lineage does not branch`,
      );
    }
    if (successors.length === 0) break;

    const next = successors[0]!;
    // Whatever its reason, a successor must state exactly one, well-formed.
    lineagePositionOf(next, rootId);
    if (next.lineageRootBindingId !== rootId) {
      throw new FrontendBackendBuildLineageCorrupt(
        root.projectId,
        rootId,
        `successor "${next._id}" claims lineage root ${next.lineageRootBindingId ?? '(absent)'}`,
      );
    }
    if (seen.has(next._id)) {
      throw new FrontendBackendBuildLineageCorrupt(root.projectId, rootId, `chain cycles back through "${next._id}"`);
    }
    seen.add(next._id);
    tip = next;
  }

  // Reachability, asked the other way round: anything claiming this root that
  // the walk never reached is a detached member — an orphan, or a successor
  // whose own predecessor no longer exists. Counted rather than ordered.
  const claimed = await store.frontendBackendBuildBindings.countDocuments({
    projectId: root.projectId,
    lineageRootBindingId: rootId,
  });
  if (claimed !== seen.size) {
    throw new FrontendBackendBuildLineageCorrupt(
      root.projectId,
      rootId,
      `${claimed} bindings claim this lineage root but only ${seen.size} are reachable from it`,
    );
  }

  return tip;
}

/**
 * An exact binding cannot be named as the build a release publishes: it is
 * not promoted, belongs elsewhere, or predates lineage identity. Publication
 * authority is never manufactured from a build that has not earned it.
 */
export class FrontendBackendBuildNotPublishable extends Error {
  constructor(
    readonly bindingId: string,
    detail: string,
  ) {
    super(`frontend_backend build "${bindingId}" cannot be published as canonical build authority — ${detail}`);
    this.name = 'FrontendBackendBuildNotPublishable';
  }
}

/**
 * The exact build authority a release publishes, read from the one binding
 * the caller already holds by id.
 *
 * Re-read rather than taken from the caller's in-memory document on purpose:
 * `runProject` keeps the document `prepare` returned, and promotion is
 * recorded afterwards in Mongo, so that copy still says `prepared` with no
 * promotion id. An exact-id read of durable state is the authority; nothing
 * here looks for "the latest" or "the promoted" binding.
 *
 * Fails closed unless the binding is this project's, `promoted`, carries its
 * promotion id, and carries a lineage root — a binding that predates lineage
 * identity cannot prove which lineage its release would belong to.
 */
export async function loadReleaseBuildAuthority(
  store: StateStore,
  projectId: string,
  bindingId: string,
): Promise<ReleaseBuildAuthority> {
  const binding = await store.frontendBackendBuildBindings.findOne({ _id: bindingId });
  if (!binding) throw new FrontendBackendBuildBindingNotFound(bindingId);
  if (binding.projectId !== projectId) {
    throw new FrontendBackendBuildNotPublishable(bindingId, `it belongs to project "${binding.projectId}", not "${projectId}"`);
  }
  if (binding.status !== 'promoted') {
    throw new FrontendBackendBuildNotPublishable(bindingId, `its status is "${binding.status}", not "promoted"`);
  }
  if (!binding.promotionId) {
    throw new FrontendBackendBuildNotPublishable(bindingId, 'it records no promotion id');
  }
  if (binding.lineageRootBindingId === undefined) {
    throw new FrontendBackendBuildNotPublishable(bindingId, 'it predates lineage-root identity');
  }
  return {
    lineageRootBindingId: binding.lineageRootBindingId,
    canonicalBindingId: binding._id,
    promotionId: binding.promotionId,
  };
}

/**
 * Release the project's active-lineage slot, guarded and idempotent.
 *
 * Called only when the outer project reaches a durable semantic terminal
 * state, and — wherever the caller already owns a transaction — inside the very
 * one that writes that state, so the terminal fact and the release are a single
 * atomic fact rather than two writes a crash can separate. Where a crash does
 * separate them, replay converges: `$unset` against a document that no longer
 * carries the marker matches nothing and changes nothing, so retrying either
 * side is safe and order does not matter.
 *
 * Never called because a process died, an invocation threw, or a build failed
 * to promote. None of those is terminal, and freeing the slot for them would
 * let a fresh lineage strand work that is still live — the precise failure
 * this slot exists to prevent.
 */
export async function releaseActiveLineage(
  store: StateStore,
  projectId: string,
  options: {
    readonly session?: ClientSession;
    /**
     * Release only if the project's slot is held by this exact root.
     *
     * Used by callers that are ending one particular lineage rather than
     * concluding the project — abandonment — so a binding can never release
     * authority it does not hold. Notably, a binding that predates lineage
     * identity records no root at all, and must not clear someone else's slot
     * on its way out. Omitted by the terminal-state callers, which are
     * concluding the project itself and release whatever holds it.
     */
    readonly lineageRootBindingId?: string;
  } = {},
): Promise<void> {
  const filter = {
    projectId,
    activeLineage: true as const,
    ...(options.lineageRootBindingId !== undefined ? { _id: options.lineageRootBindingId } : {}),
  };
  const update = { $unset: { activeLineage: '' }, $set: { updatedAt: new Date() } } as const;

  if (options.session) {
    await store.frontendBackendBuildBindings.updateOne(filter, update, { session: options.session });
    return;
  }
  await store.frontendBackendBuildBindings.updateOne(filter, update);
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

/** Where a binding stands in its lineage: an initial build, or a successor with its exact predecessor and typed reason. */
export type BuildLineagePosition =
  | { readonly kind: 'initial' }
  | { readonly kind: 'successor'; readonly predecessorBindingId: string; readonly provenance: BuildSuccessorProvenance };

/**
 * The one reader of a binding's lineage fields.
 *
 * Two persisted encodings, one meaning, no migration:
 *
 * - a replan successor stores `replanDecision` — how every replan successor,
 *   historical or new, has always been written;
 * - a visual-refinement or semantic-edit successor stores its typed
 *   `successorProvenance`, whose `kind` says which — never a replan.
 *
 * Nothing outside this reader tells the kinds apart.
 *
 * An initial build stores neither and no predecessor. Everything else — a
 * predecessor with no reason, a reason with no predecessor, both encodings at
 * once, a malformed ref or cycle — is corrupt, and nothing is guessed: no field
 * is preferred over another, and no reason is ever inferred from a predecessor.
 */
/** The successor reasons stored in `successorProvenance`. A replan is never one of them: it has its own encoding. */
const TypedSuccessorProvenance = z.discriminatedUnion('kind', [VisualRefinementSuccessorProvenance, SemanticEditSuccessorProvenance]);

export function readBuildLineage(binding: FrontendBackendBuildBindingDocument): BuildLineagePosition {
  const hasReplan = binding.replanDecision !== undefined;
  const hasTyped = binding.successorProvenance !== undefined;

  if (binding.predecessorBindingId === undefined) {
    if (hasReplan || hasTyped) {
      throw new FrontendBackendBuildBindingCorrupt(binding._id, 'an initial build records a successor reason but no predecessor');
    }
    return { kind: 'initial' };
  }
  if (hasReplan && hasTyped) {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, 'a successor records both a replan decision and a typed successor provenance');
  }
  if (hasReplan) {
    const parsed = ReplanSuccessorProvenance.safeParse({ kind: 'replan', replanDecision: binding.replanDecision });
    if (!parsed.success) throw new FrontendBackendBuildBindingCorrupt(binding._id, `replanDecision is malformed: ${issues(parsed.error)}`);
    return { kind: 'successor', predecessorBindingId: binding.predecessorBindingId, provenance: parsed.data };
  }
  if (hasTyped) {
    const parsed = TypedSuccessorProvenance.safeParse(binding.successorProvenance);
    if (!parsed.success) throw new FrontendBackendBuildBindingCorrupt(binding._id, `successorProvenance is malformed: ${issues(parsed.error)}`);
    return { kind: 'successor', predecessorBindingId: binding.predecessorBindingId, provenance: parsed.data };
  }
  throw new FrontendBackendBuildBindingCorrupt(binding._id, `a successor of "${binding.predecessorBindingId}" records no reason for replacing it`);
}

function issues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** The lineage reader, reporting malformed provenance as the lineage corruption a walk is looking for. */
function lineagePositionOf(binding: FrontendBackendBuildBindingDocument, rootId: string): BuildLineagePosition {
  try {
    return readBuildLineage(binding);
  } catch (error) {
    if (!(error instanceof FrontendBackendBuildBindingCorrupt)) throw error;
    throw new FrontendBackendBuildLineageCorrupt(binding.projectId, rootId, error.message);
  }
}

/** Exact equality of two successor reasons: same kind, and every authoritative field the same. */
function sameProvenance(a: BuildSuccessorProvenance, b: BuildSuccessorProvenance): boolean {
  if (a.kind === 'replan' && b.kind === 'replan') return sameRef(a.replanDecision, b.replanDecision);
  if (a.kind === 'visual_refinement' && b.kind === 'visual_refinement') {
    return sameRef(a.visualQualityReview, b.visualQualityReview) && sameRef(a.screenshotSet, b.screenshotSet) && a.refinementCycle === b.refinementCycle;
  }
  if (a.kind === 'semantic_edit' && b.kind === 'semantic_edit') {
    // Both refs always carry their content hash, so this is exact name, version and content.
    return sameRef(a.baseEditableSiteModel, b.baseEditableSiteModel) && sameRef(a.editableSiteModel, b.editableSiteModel);
  }
  return false;
}

/**
 * Re-prove that a binding and the spec it claims to store still agree,
 * before either is trusted for resume: `projectId`, `jobId`, `role`, the
 * full-spec hash, and both pinned inputs. Any disagreement is durable
 * corruption — a hand-edited or otherwise inconsistent record — and is
 * never silently repaired.
 */
export function verifyBindingConsistency(
  binding: FrontendBackendBuildBindingDocument,
  spec: JobSpec,
  lineage?: PrepareBindingInput['lineage'],
  expectedLineageRootBindingId?: string,
): void {
  /**
   * Which lineage a build belongs to is immutable. Exact replay converges on
   * the same root; anything else is a stored record being asked to change
   * lineage, which is never repaired in place.
   *
   * Compared only when the stored record actually carries a root: a binding
   * written before this capability has none, and that is readable history
   * rather than a mismatch — treating absent as wrong would fail every legacy
   * resume, and backfilling it would invent authority nobody proved.
   */
  if (
    expectedLineageRootBindingId !== undefined &&
    binding.lineageRootBindingId !== undefined &&
    binding.lineageRootBindingId !== expectedLineageRootBindingId
  ) {
    throw new FrontendBackendBuildBindingCorrupt(
      binding._id,
      `binding.lineageRootBindingId is "${binding.lineageRootBindingId}", not "${expectedLineageRootBindingId}"`,
    );
  }

  // Checked before the spec fields below, because lineage is what makes two
  // otherwise-identical successors different builds. The stored record is
  // never edited to match the caller: exact replay converges, anything else
  // fails closed.
  const stored = readBuildLineage(binding);
  if (lineage) {
    if (stored.kind !== 'successor' || stored.predecessorBindingId !== lineage.predecessorBindingId) {
      throw new FrontendBackendBuildBindingCorrupt(
        binding._id,
        `binding.predecessorBindingId is ${binding.predecessorBindingId ?? '(absent)'}, not "${lineage.predecessorBindingId}"`,
      );
    }
    if (stored.provenance.kind !== lineage.provenance.kind) {
      throw new FrontendBackendBuildBindingCorrupt(
        binding._id,
        `binding is a ${stored.provenance.kind} successor, not the ${lineage.provenance.kind} successor presented`,
      );
    }
    if (!sameProvenance(stored.provenance, lineage.provenance)) {
      throw new FrontendBackendBuildBindingCorrupt(
        binding._id,
        stored.provenance.kind === 'replan'
          ? 'binding.replanDecision does not match the exact replan decision presented'
          : `binding.successorProvenance does not match the exact ${stored.provenance.kind} presented`,
      );
    }
  } else if (stored.kind === 'successor') {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, `binding is a ${stored.provenance.kind} successor but was presented as an initial build`);
  }

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

  // A refinement job and a visual-refinement successor are the same fact, told
  // twice: the spec pins exactly the review and screenshot set the lineage names,
  // and no other binding's spec pins refinement inputs at all.
  const specSource = spec.inputs[FRONTEND_BACKEND_INPUT.visualRefinementSource];
  const specReview = spec.inputs[FRONTEND_BACKEND_INPUT.visualQualityReview];
  const specSet = spec.inputs[FRONTEND_BACKEND_INPUT.screenshotSet];
  if (stored.kind === 'successor' && stored.provenance.kind === 'visual_refinement') {
    if (!specSource || !specReview || !specSet) {
      throw new FrontendBackendBuildBindingCorrupt(binding._id, 'a visual refinement successor\'s spec does not pin its source, review and screenshot set');
    }
    if (!sameRef(specReview, stored.provenance.visualQualityReview) || !sameRef(specSet, stored.provenance.screenshotSet)) {
      throw new FrontendBackendBuildBindingCorrupt(binding._id, 'spec refinement inputs do not match the stored visual refinement provenance');
    }
  } else if (specSource || specReview || specSet) {
    throw new FrontendBackendBuildBindingCorrupt(binding._id, 'spec pins visual refinement inputs, but the binding is not a visual refinement successor');
  }

  // A semantic-edit successor exists to implement exactly one model version: its spec pins that version, and no other.
  if (stored.kind === 'successor' && stored.provenance.kind === 'semantic_edit') {
    const specModel = spec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel];
    if (!specModel || !sameRef(specModel, stored.provenance.editableSiteModel) || specModel.contentHash !== stored.provenance.editableSiteModel.contentHash) {
      throw new FrontendBackendBuildBindingCorrupt(binding._id, 'a semantic edit successor\'s spec does not pin exactly the editable site model it implements');
    }
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
  /**
   * The exact canonical build this one replaces (Phase 5q0), and exactly why:
   * a replan decision, a visual refinement, or a semantic edit. Omitted entirely by an initial
   * build. There is no way to name a predecessor without a reason — a
   * predecessor never implies one.
   */
  readonly lineage?: {
    readonly predecessorBindingId: string;
    readonly provenance: BuildSuccessorProvenance;
  };
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

  // A successor's reason is proven well-formed before anything is read or written.
  if (input.lineage) {
    const parsed = BuildSuccessorProvenance.safeParse(input.lineage.provenance);
    if (!parsed.success) throw new FrontendBackendBuildSuccessorProvenanceInvalid(input.lineage.predecessorBindingId, issues(parsed.error));
  }

  /**
   * Which lineage this binding joins, settled before anything is written.
   *
   * An initial build founds its own lineage and is its own root. A successor,
   * whatever its reason, inherits its predecessor's exact recorded root rather than
   * deriving one, which is what lets `B2` name `B0` without any reader
   * walking the chain backwards or ordering it by time.
   */
  const lineageRootBindingId = input.lineage
    ? await inheritLineageRoot(store, input.projectId, input.lineage.predecessorBindingId)
    : bindingId;

  /**
   * A semantic edit names two exact model versions, and both are bound to builds
   * here, from binding state alone: the base is exactly the model the predecessor
   * build carries, and the result is exactly the model this build's spec pins.
   * Whether the result really descends from the base through valid patches is the
   * models' own provenance, proven by whoever resolves them — not by lineage.
   */
  if (input.lineage?.provenance.kind === 'semantic_edit') {
    const { baseEditableSiteModel: base, editableSiteModel: result } = input.lineage.provenance;
    const exact = (ref: ArtifactRef | undefined, expected: ArtifactRef) => ref !== undefined && sameRef(ref, expected) && ref.contentHash === expected.contentHash;
    const predecessor = await store.frontendBackendBuildBindings.findOne({ _id: input.lineage.predecessorBindingId, projectId: input.projectId });
    if (!exact(predecessor?.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel], base)) {
      throw new FrontendBackendBuildSuccessorProvenanceInvalid(input.lineage.predecessorBindingId, 'the base editable site model is not the exact model the predecessor build carries');
    }
    if (!exact(input.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel], result)) {
      throw new FrontendBackendBuildSuccessorProvenanceInvalid(input.lineage.predecessorBindingId, 'the spec does not pin exactly the editable site model the semantic edit implements');
    }
  }

  const existing = await store.frontendBackendBuildBindings.findOne({ _id: bindingId });
  if (existing) {
    verifyBindingConsistency(existing, input.jobSpec, input.lineage, lineageRootBindingId);
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
    lineageRootBindingId,
    /**
     * A root founds a lineage and therefore acquires the project's
     * active-lineage slot here, at preparation — not at promotion. Owning the
     * project from the moment work begins is what keeps a `prepared` build's
     * claim on it coherent with Phase 5k's own restart resume.
     *
     * A successor joins a lineage that is already active, so it takes no
     * second slot: exactly one binding per project ever carries this marker,
     * and it is always the root.
     */
    ...(input.lineage
      ? {
          predecessorBindingId: input.lineage.predecessorBindingId,
          // Each reason in its one persisted encoding (see `readBuildLineage`).
          ...(input.lineage.provenance.kind === 'replan'
            ? { replanDecision: input.lineage.provenance.replanDecision }
            : { successorProvenance: input.lineage.provenance }),
        }
      : { activeLineage: true as const }),
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
      verifyBindingConsistency(raced, input.jobSpec, input.lineage, lineageRootBindingId);
      return raced;
    }

    // Three partial unique indexes can now refuse this insert, and they mean
    // different things — so ask which constraint actually holds rather than
    // assuming one, which would report a branched lineage, or a project still
    // owned by unfinished work, as "a different request is mid-build".
    if (input.lineage) {
      const rival = await store.frontendBackendBuildBindings.findOne({
        projectId: input.projectId,
        predecessorBindingId: input.lineage.predecessorBindingId,
      });
      if (rival) {
        throw new FrontendBackendBuildLineageConflict(
          input.projectId,
          input.lineage.predecessorBindingId,
          rival._id,
          bindingId,
        );
      }
    }

    // Asked before the active-lineage slot below, so the long-standing answer
    // keeps its exact meaning and Phase 5k's behaviour is unchanged: when
    // something really is `prepared`, that is both the more precise fact and
    // the more actionable one. Two racing fresh roots land here, since the
    // winner is `prepared` and active at once.
    const other = await store.frontendBackendBuildBindings.findOne({ projectId: input.projectId, status: 'prepared' });
    if (other) {
      throw new FrontendBackendBuildBindingConflict(input.projectId, other.runIntentHash, input.runIntentHash);
    }

    // Nothing is `prepared`, so this is the case that slot exists for: an
    // earlier lineage promoted its build and its run never reached a durable
    // terminal state, so it still owns the project.
    const owner = await findActiveLineageRoot(store, input.projectId);
    if (owner) {
      throw new FrontendBackendActiveLineageConflict(input.projectId, owner._id, bindingId);
    }

    throw new FrontendBackendBuildBindingConflict(input.projectId, '(unknown)', input.runIntentHash);
  }
}

/**
 * A successor's lineage root, read from the exact predecessor it names.
 *
 * Inherited, never derived: the predecessor already recorded which lineage it
 * belongs to, so this is a read, and a predecessor that never recorded one
 * fails closed rather than being reconstructed by walking or by time.
 */
async function inheritLineageRoot(
  store: StateStore,
  projectId: string,
  predecessorBindingId: string,
): Promise<string> {
  const predecessor = await store.frontendBackendBuildBindings.findOne({ _id: predecessorBindingId });
  if (!predecessor) {
    throw new FrontendBackendBuildBindingNotFound(predecessorBindingId);
  }
  if (predecessor.projectId !== projectId) {
    throw new FrontendBackendBuildBindingProjectMismatch(projectId, predecessorBindingId, predecessor.projectId);
  }
  if (predecessor.lineageRootBindingId === undefined) {
    throw new FrontendBackendBuildLineageRootUnproven(projectId, predecessorBindingId);
  }
  return predecessor.lineageRootBindingId;
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
  /**
   * Further repo-relative paths this caller knows are its own.
   *
   * The guard below exists to stop a *foreign* change riding into the
   * specification commit, and on a first build the only dirty paths are the
   * profile and the plan. A replan successor is prepared mid-run, when the
   * harness has also materialised its own decision records (`decisions/…`)
   * that nothing has committed yet — authored by the harness, never by a
   * model, and swept in by `commit()`'s `git add -A` either way. The caller
   * names them rather than this module widening the rule for everyone.
   */
  alsoExpected: readonly string[] = [],
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

  const expectedSpecificationPaths = new Set([BUSINESS_PROFILE_ARTIFACT_PATH, ...sitePlanArtifactPaths(plan), ...alsoExpected]);
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

    /**
     * The unfinished work of this lineage is over, so the project is released
     * — in this same transaction, so revocation and release are one atomic
     * fact rather than two a crash could separate.
     *
     * This is the one ending that is durably terminal without the outer run
     * concluding: an explicit, recorded operator decision, never a timeout, a
     * lease expiry, or a process that died. Releasing here is what keeps Phase
     * 5m's own contract intact — once a build is abandoned, a fresh generation
     * or a `legacy_direct` rollback may proceed against the project.
     *
     * Scoped to this binding's own lineage root rather than clearing whatever
     * the project's slot happens to hold, so a pre-lineage binding — which
     * records no root and never held the slot — cannot release it.
     */
    await releaseActiveLineage(deps.store, binding.projectId, {
      session,
      lineageRootBindingId: updated.lineageRootBindingId ?? updated._id,
    });

    return { outcome: 'abandoned' as const, binding: updated, supersededJobId };
  });
}
