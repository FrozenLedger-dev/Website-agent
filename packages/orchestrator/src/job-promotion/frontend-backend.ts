/**
 * Replay-safe canonical promotion of one accepted `frontend_backend`
 * candidate (Phase 5h).
 *
 * Phase 5g-2 accepts a candidate — `ArtifactRegistry.accept` +
 * `validating -> accepted` + its own lifecycle audit, in one Mongo
 * transaction — but never touches the canonical project workspace at all.
 * This module is the separate, explicit step that takes an already-accepted
 * job's exact execution output and materialises it into the canonical
 * workspace, as one Git commit.
 *
 * Deliberately does not depend on 5g-1's validation evidence (a process-
 * local `WeakMap`, gone the moment that process exits) or on 5g-2 having
 * just run in the same process. This module starts entirely from durable
 * state — an accepted `JobDocument` plus its exact, already-accepted
 * candidate artifact — and works identically whether it runs a second after
 * acceptance or after a process restart days later.
 *
 * There is no distributed transaction spanning Mongo, the filesystem, and
 * Git — none exists, and this module does not pretend otherwise. What it
 * gives instead is replay safety: a durable {@link JobPromotionRecord},
 * keyed by a deterministic identity derived from exactly what is being
 * promoted, plus a machine-readable marker written into the promotion
 * commit itself. A crash at any point — before any canonical mutation,
 * mid-write, or in the single worst window (the Git commit having already
 * succeeded before the Mongo record could be finalised) — leaves enough
 * evidence, across the two systems together, for a retry to work out
 * exactly what already happened and finish exactly once. See
 * `promoteAcceptedFrontendBackendCandidate`'s own doc comment for the
 * sequence.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactRef } from '@statxai/contracts';
import type { JobDocument, JobPromotionRecord, StateStore } from '@statxai/state';
import { ProjectWorkspace, contentHash, scaffoldSite, scaffoldTemplatePaths, type ArtifactRegistry } from '@statxai/workspace';
import { jobOutputNamespace, type JobEngine } from '@statxai/job-engine';
import { CandidateShape } from '../job-validation/frontend-backend.js';
import type { BuildCandidate } from '../phases/build.js';

const ROLE = 'frontend_backend';

/**
 * Fixed control-plane identity for every promotion-fence acquisition this
 * module performs — never the original build worker's id, never
 * `sol`/`terra`/`luna`. Mirrors `job-acceptance/frontend-backend.ts`'s own
 * `ACCEPTANCE_ACTOR`: this names *promotion* authority, which the harness
 * alone holds.
 */
export const PROMOTION_FENCE_ACTOR = 'harness:promoter';

export class PromotionJobNotFound extends Error {
  constructor(jobId: string) {
    super(`job "${jobId}" not found`);
    this.name = 'PromotionJobNotFound';
  }
}

/** The job belongs to a role this adapter does not promote. */
export class PromotionRoleMismatch extends Error {
  constructor(jobId: string, actual: string) {
    super(`job "${jobId}" has role "${actual}", not "${ROLE}"; refusing to promote`);
    this.name = 'PromotionRoleMismatch';
  }
}

/** Only an `accepted` job has an execution output this module may promote. */
export class PromotionStateMismatch extends Error {
  constructor(jobId: string, actual: string) {
    super(`job "${jobId}" is "${actual}", not "accepted" — nothing for promotion to act on yet`);
    this.name = 'PromotionStateMismatch';
  }
}

/** `executionOutputs` is null, undefined, or empty on an accepted job — inconsistent durable state. */
export class PromotionMissingOutputs extends Error {
  constructor(jobId: string) {
    super(`job "${jobId}" is accepted but has no executionOutputs attached; refusing to promote`);
    this.name = 'PromotionMissingOutputs';
  }
}

/** The production handler's contract stages exactly one output ref; a different count is never narrowed to "the first one." */
export class PromotionOutputCountMismatch extends Error {
  constructor(jobId: string, count: number) {
    super(`job "${jobId}" has ${count} executionOutputs ref(s); this module requires exactly 1`);
    this.name = 'PromotionOutputCountMismatch';
  }
}

/** The output ref is not namespaced under this exact job and attempt (Phase 5f's `jobOutputNamespace`). */
export class PromotionNamespaceMismatch extends Error {
  constructor(jobId: string, attempt: number, refName: string) {
    super(
      `job "${jobId}" attempt ${attempt}: executionOutputs ref "${refName}" is not namespaced under ` +
        `${jobOutputNamespace(jobId, attempt)}`,
    );
    this.name = 'PromotionNamespaceMismatch';
  }
}

/** The exact output ref does not resolve to any stored artifact — a platform/data-integrity fault, not a validation failure. */
export class PromotionCandidateMissing extends Error {
  constructor(jobId: string, ref: ArtifactRef) {
    super(`job "${jobId}": candidate "${ref.name}@${ref.version}" could not be resolved`);
    this.name = 'PromotionCandidateMissing';
  }
}

/** The exact candidate exists but was never accepted. Phase 5h does not own acceptance and will not repair this by accepting it. */
export class PromotionCandidateNotAccepted extends Error {
  constructor(jobId: string, ref: ArtifactRef) {
    super(`job "${jobId}": candidate "${ref.name}@${ref.version}" is not accepted; refusing to promote`);
    this.name = 'PromotionCandidateNotAccepted';
  }
}

/** The accepted candidate's stored payload does not have the shape `BuildCandidate` requires. */
export class PromotionCandidateShapeInvalid extends Error {
  constructor(jobId: string, issue: string) {
    super(`job "${jobId}"'s accepted candidate does not match the expected BuildCandidate shape: ${issue}`);
    this.name = 'PromotionCandidateShapeInvalid';
  }
}

/**
 * Another promotion is already `prepared` for this project. The partial
 * unique index on `{ projectId }` is what actually enforces this; this
 * error is what a caller sees when it does.
 */
export class PromotionInProgress extends Error {
  constructor(projectId: string, blockedPromotionId: string) {
    super(`project "${projectId}" already has a promotion in progress; cannot prepare "${blockedPromotionId}" concurrently`);
    this.name = 'PromotionInProgress';
  }
}

/**
 * A `prepared` promotion's recorded `baseCommit` no longer equals canonical
 * HEAD, and no commit carrying this promotion's marker exists yet — some
 * other canonical write landed on this project's lineage in between. Fails
 * closed rather than silently building on an unexpected history.
 */
export class PromotionBaseConflict extends Error {
  constructor(projectId: string, promotionId: string, baseCommit: string | null, currentCommit: string | null) {
    super(
      `project "${projectId}" promotion "${promotionId}": canonical HEAD (${currentCommit ?? 'null'}) no longer ` +
        `matches the commit this promotion was prepared against (${baseCommit ?? 'null'}); refusing to promote`,
    );
    this.name = 'PromotionBaseConflict';
  }
}

/**
 * A durable promotion record exists but does not describe a consistent,
 * trustworthy promotion — its binding disagrees with what is being
 * promoted now, a `committed` record has no `commitSha`, or its `commitSha`
 * disagrees with the commit actually found under its own marker. Never
 * silently repaired by overwriting it with a fresh one.
 */
export class PromotionReceiptCorrupt extends Error {
  constructor(promotionId: string, detail: string) {
    super(`promotion "${promotionId}" has a corrupt durable record — ${detail}`);
    this.name = 'PromotionReceiptCorrupt';
  }
}

/**
 * The working tree already matched canonical HEAD exactly after
 * materialising the candidate, so there was nothing to commit — yet no
 * commit carrying this promotion's marker was found beforehand either. Not
 * expected in ordinary operation; failed closed rather than finalised with
 * no real commit to point at.
 */
export class PromotionCommitProducedNothing extends Error {
  constructor(promotionId: string) {
    super(`promotion "${promotionId}": materialising the candidate produced no changes to commit`);
    this.name = 'PromotionCommitProducedNothing';
  }
}

/**
 * `ProjectWorkspace.commit()` stages the whole working tree (`git add -A`),
 * not just what this module just wrote — so an uncommitted change sitting
 * in the canonical workspace for any other reason would otherwise ride
 * along, silently, into the same commit as the candidate. Thrown before any
 * commit is attempted, for either of two distinct cases: a path was already
 * dirty before this attempt touched the tree at all and is not one of this
 * candidate's own files (a foreign, unrelated change); or a path became
 * dirty only after `writeSiteFiles` ran and still is not one of this
 * candidate's own files (nothing `writeSiteFiles` does can cause this on its
 * own — it exists as a consistency check against the same class of problem
 * from the other side).
 */
export class PromotionWorkingTreeDirty extends Error {
  constructor(promotionId: string, paths: readonly string[]) {
    super(
      `promotion "${promotionId}": the canonical working tree has uncommitted changes outside this ` +
        `candidate's own files: ${paths.join(', ')}`,
    );
    this.name = 'PromotionWorkingTreeDirty';
  }
}

export interface FrontendBackendPromotionDeps {
  readonly store: StateStore;
  readonly registry: ArtifactRegistry;
  readonly engine: JobEngine;
  /** Root of the canonical, harness-owned project workspaces — never a disposable/validation root. */
  readonly workspacesRoot: string;
}

/** What one promotion attempt reports — success either way it was reached: created here, or discovered already done. */
export interface FrontendBackendPromotionResult {
  readonly jobId: string;
  readonly attempt: number;
  readonly candidate: ArtifactRef;
  readonly promotionId: string;
  readonly commitSha: string;
}

interface PromotionBinding {
  readonly projectId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly output: ArtifactRef;
}

/**
 * The one durable identity a given accepted execution's promotion always
 * derives — never current time, creation order, `lineageSeq`, a random id,
 * or a filesystem path. Reuses the same `contentHash` (`@statxai/workspace`)
 * `ArtifactRegistry` itself hashes artifact content with, rather than a
 * second hashing scheme.
 */
function computePromotionId(binding: PromotionBinding): string {
  return contentHash({
    projectId: binding.projectId,
    jobId: binding.jobId,
    attempt: binding.attempt,
    outputName: binding.output.name,
    outputVersion: binding.output.version,
    outputContentHash: binding.output.contentHash ?? null,
  });
}

export function promotionMarker(promotionId: string): string {
  return `Statx-Promotion-Id: ${promotionId}`;
}

function promotionCommitMessage(promotionId: string): string {
  return `Promote accepted frontend/backend candidate\n\n${promotionMarker(promotionId)}`;
}

/**
 * Fails closed if a recovered/raced-in durable record does not actually
 * describe `binding` — the deterministic id makes this astronomically
 * unlikely to fire from a genuine hash collision, but a hand-edited or
 * otherwise corrupted document must never be silently trusted or repaired.
 */
function assertRecordMatchesBinding(record: JobPromotionRecord, binding: PromotionBinding): void {
  if (
    record.projectId !== binding.projectId ||
    record.jobId !== binding.jobId ||
    record.attempt !== binding.attempt ||
    record.output.name !== binding.output.name ||
    record.output.version !== binding.output.version
  ) {
    throw new PromotionReceiptCorrupt(record._id, 'existing durable record does not match the current promotion binding');
  }
  if (record.status === 'committed' && !record.commitSha) {
    throw new PromotionReceiptCorrupt(record._id, 'record is committed but has no commitSha');
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Promote exactly the execution output an already-`accepted` `frontend_backend`
 * job describes into the canonical project workspace, as one Git commit.
 *
 * `jobId` is re-read fresh from durable state — a caller-supplied
 * `JobDocument` is never trusted as promotion authority, so a stale one
 * cannot be used to promote something that has since changed. Fails closed,
 * before any canonical mutation, unless: the job exists, has role
 * `frontend_backend`, is `accepted`, has exactly one `executionOutputs` ref,
 * that ref is namespaced under this exact job and attempt (Phase 5f's
 * `jobOutputNamespace`), it resolves to a stored artifact, that artifact is
 * accepted, and its payload parses as a `BuildCandidate`. None of this
 * re-runs deterministic validation — the accepted candidate already *is*
 * the validated, accepted object; promotion only publishes it.
 *
 * The recoverable sequence, every step idempotent on retry:
 *
 *   A. resolve + prove the accepted job/candidate (above)
 *   B. read-only preflight, in strict authority order (nothing is mutated
 *      yet): an existing `promotionFence` on the job wins — its
 *      `baseCommit` *is* this promotion's base; failing that, an existing
 *      promotion record's own `baseCommit` (the pre-5n durable shape);
 *      failing both, canonical HEAD, read exactly once. A fresh HEAD read
 *      never overrides a base that is already durably recorded, so a
 *      retry can never re-propose the fence against a HEAD that has moved
 *      since — see step F2, which is where a moved HEAD is actually
 *      caught.
 *   C. **acquire the durable promotion fence** (`JobEngine.acquirePromotionFence`,
 *      Phase 5n) — `promotionId`/`attempt`/`candidate`/`baseCommit`, before
 *      *anything* canonical is touched and before a brand-new record is
 *      ever created. This is the one serialisation point against
 *      accepted-state abandonment (`supersedeAcceptedBeforePromotion`):
 *      if abandonment already won, the job is no longer `accepted` and
 *      this throws {@link JobStateConflict} here, before step D — nothing
 *      after this point ever runs for a job abandonment has already
 *      revoked. Idempotent: called unconditionally on every invocation,
 *      including a pure replay of an already-`committed` historical
 *      promotion, so this doubles as the "re-prove fence ownership" check
 *      a resumed or restarted invocation needs before it may touch the
 *      canonical tree again.
 *   D. create, or recover, the durable promotion record — `prepared`,
 *      binding recorded, `baseCommit` = the exact value the fence just
 *      acquired (never re-read independently, so the two can never
 *      disagree). A project-scoped partial unique index allows at most one
 *      `prepared` record per project; a second, different promotion racing
 *      in gets {@link PromotionInProgress} instead of co-mingling files. A
 *      pre-existing record (Phase 5n's own legacy-compatibility path) is
 *      never replaced — the fence was acquired using *its* `baseCommit`, so
 *      the two already agree by construction.
 *   E. search canonical history — the whole of it, not merely HEAD — for a
 *      commit carrying this promotion's exact marker.
 *   F1. found: verify it agrees with the record (or the record's own
 *       `commitSha`, if already `committed`), finalise Mongo to
 *       `committed` if it was still `prepared`, and return — no second
 *       commit is ever created. This is what makes "Git commit succeeded,
 *       process died before Mongo finalised" recoverable: the commit itself
 *       is the evidence, and this is where a retry finds it.
 *   F2. not found: verify canonical HEAD still equals the record's
 *       `baseCommit` (else {@link PromotionBaseConflict} — someone else's
 *       canonical write landed first), materialise the exact candidate
 *       (idempotent — the same accepted candidate, written again, is a
 *       no-op if some of it is already on disk from a prior crashed
 *       attempt), and commit once with the marker.
 *   G. finalise the record to `committed` with the commit this attempt
 *      just created.
 *
 * Once `committed`, calling this again is a pure read-and-verify: it
 * re-derives the same promotion id, re-acquires (idempotently) the same
 * fence, finds the same record already `committed`, confirms the marker is
 * still exactly where it was, and returns the same result — no new commit,
 * no new record, no touch to job or artifact-acceptance state.
 */
export async function promoteAcceptedFrontendBackendCandidate(
  jobId: string,
  deps: FrontendBackendPromotionDeps,
): Promise<FrontendBackendPromotionResult> {
  const job: JobDocument | null = await deps.store.jobs.findOne({ _id: jobId });
  if (!job) throw new PromotionJobNotFound(jobId);
  if (job.role !== ROLE) throw new PromotionRoleMismatch(jobId, job.role);
  if (job.state !== 'accepted') throw new PromotionStateMismatch(jobId, job.state);

  const outputs = job.executionOutputs;
  if (!outputs || outputs.length === 0) throw new PromotionMissingOutputs(jobId);
  if (outputs.length !== 1) throw new PromotionOutputCountMismatch(jobId, outputs.length);
  const outputRef = outputs[0]!;

  const namespace = jobOutputNamespace(job._id, job.attempt);
  if (!outputRef.name.startsWith(namespace)) {
    throw new PromotionNamespaceMismatch(job._id, job.attempt, outputRef.name);
  }

  // Project-relative, exact ref, never "latest": the artifact document's own
  // id embeds `job.projectId`, and `version` is read directly from the
  // job's own attached ref — never resolved by sort order.
  const doc = await deps.registry.getDocument(job.projectId, outputRef);
  if (!doc) throw new PromotionCandidateMissing(job._id, outputRef);
  if (doc.acceptedAt === null) throw new PromotionCandidateNotAccepted(job._id, outputRef);

  const parsed = CandidateShape.safeParse(doc.data);
  if (!parsed.success) {
    throw new PromotionCandidateShapeInvalid(job._id, parsed.error.issues.map((i) => i.message).join('; '));
  }
  const candidate = parsed.data as BuildCandidate;

  const binding: PromotionBinding = { projectId: job.projectId, jobId: job._id, attempt: job.attempt, output: outputRef };
  const promotionId = computePromotionId(binding);

  const ws = await ProjectWorkspace.open(job.projectId, deps.workspacesRoot);

  // Read-only preflight, in strict authority order. Whichever source wins
  // here is what `baseCommit` *is* for the rest of this call — it is never
  // re-proposed from a fresh HEAD read once a durable record of it exists,
  // because HEAD may since have moved and this promotion's own base must
  // not silently follow it.
  //
  //   1. An existing `promotionFence` on the authoritative job document.
  //      The fence *is* promotion authority (Phase 5n): if one exists, its
  //      `baseCommit` is the answer, full stop. Reading HEAD here instead
  //      would mean a retry after "fence acquired, receipt never written"
  //      re-proposed the fence from whatever HEAD happens to be now, and
  //      then failed — if it failed at all — only incidentally, because
  //      the stored fence disagreed with the freshly-read value. The
  //      base-commit conflict below is where a moved HEAD must be caught,
  //      against the fence's own recorded base, not here.
  //   2. Otherwise, an existing promotion receipt — the pre-5n durable
  //      shape, whose own `baseCommit` is what it was genuinely prepared
  //      against, and which the fence below is backfilled to match.
  //   3. Otherwise this promotion has no durable base yet at all: read
  //      canonical HEAD, exactly once, and that becomes it.
  const existingFence = job.promotionFence ?? null;
  let record = await deps.store.promotions.findOne({ _id: promotionId });
  if (record) assertRecordMatchesBinding(record, binding);
  const baseCommit = existingFence
    ? existingFence.baseCommit
    : record
      ? record.baseCommit
      : await ws.currentCommit();

  // The fence, before any canonical mutation and before a new record is
  // ever created. Fails closed here — before step D — if accepted-state
  // abandonment already won: the job is no longer `accepted`.
  await deps.engine.acquirePromotionFence(job._id, {
    promotionId,
    attempt: binding.attempt,
    candidate: outputRef,
    baseCommit,
    actor: PROMOTION_FENCE_ACTOR,
  });

  if (!record) {
    const now = new Date();
    const prepared: JobPromotionRecord = {
      _id: promotionId,
      projectId: binding.projectId,
      jobId: binding.jobId,
      attempt: binding.attempt,
      output: outputRef,
      baseCommit,
      status: 'prepared',
      commitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await deps.store.promotions.insertOne(prepared);
      record = prepared;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Either this exact promotion raced with itself (recover it below),
      // or the project-scoped partial index refused a *different*
      // in-progress promotion for this project — distinguished by whether
      // this exact `_id` exists now, not by parsing the driver's error
      // shape.
      const existing = await deps.store.promotions.findOne({ _id: promotionId });
      if (!existing) throw new PromotionInProgress(job.projectId, promotionId);
      assertRecordMatchesBinding(existing, binding);
      record = existing;
    }
  }

  const marker = promotionMarker(promotionId);
  const existingSha = await ws.findCommitByMarker(marker);

  if (existingSha) {
    if (record.commitSha && record.commitSha !== existingSha) {
      throw new PromotionReceiptCorrupt(promotionId, 'recorded commitSha does not match the commit found under its own marker');
    }
    if (record.status === 'prepared') {
      const finalized = await deps.store.promotions.findOneAndUpdate(
        { _id: promotionId, status: 'prepared' },
        { $set: { status: 'committed', commitSha: existingSha, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      record = finalized ?? record;
    }
    return { jobId: job._id, attempt: job.attempt, candidate: outputRef, promotionId, commitSha: existingSha };
  }

  if (record.status === 'committed') {
    // Record says done, but the marker it should have produced is nowhere
    // in canonical history. Never trusted blindly.
    throw new PromotionReceiptCorrupt(promotionId, 'record is committed but no commit carries its promotion marker');
  }

  // Still `prepared`, no marker anywhere yet: this promotion's canonical
  // commit has genuinely never happened. Before writing anything, the
  // canonical lineage must still be exactly what this promotion was
  // prepared against.
  const currentHead = await ws.currentCommit();
  if (currentHead !== record.baseCommit) {
    throw new PromotionBaseConflict(job.projectId, promotionId, record.baseCommit, currentHead);
  }

  // `ProjectWorkspace.commit()` stages the whole working tree (`git add
  // -A`), not just whatever this attempt itself writes — so committing
  // safely means knowing, in full, what "this candidate's own materialised
  // output" covers: its own files, plus whatever the deterministic, never
  // model-influenced harness scaffold places alongside them (the platform
  // template tree — real on a project's first-ever promotion, a no-op on
  // any later one, since `scaffoldSite` never overwrites an existing file).
  // Anything dirty outside that closed set — before this attempt touches
  // the tree at all, or found dirty afterwards for some other reason — is a
  // foreign, unrelated change that must block the commit rather than ride
  // along inside it.
  const desiredPaths = new Set([
    ...candidate.files.map((f) => ws.siteFileRepoPath(f.path)),
    ...(await scaffoldTemplatePaths()).map((p) => ws.siteFileRepoPath(p)),
  ]);

  /**
   * What the predecessor site still tracks that this promotion does not want.
   *
   * Promotion used to be an overlay: scaffold, then write the candidate's
   * files over whatever was already there. That is indistinguishable from a
   * replacement right up until an accepted candidate *removes* something — a
   * revised plan that drops a route produces a candidate with no file for it,
   * and the predecessor's page stayed committed and deployable, with no gate
   * to catch it (`spec-coverage` asks only whether every planned route was
   * exported, never whether an exported route is still planned).
   *
   * So the promoted result is defined as a set rather than a diff:
   * `desiredPaths` is the whole managed site, and anything the index still
   * tracks under the site root that is absent from it is stale. Every member
   * is therefore tracked by git, inside the managed namespace, and provably
   * not part of what was accepted — no other file is eligible.
   */
  const stalePaths = (await ws.trackedSiteFiles()).filter((p) => !desiredPaths.has(p));
  const staleSet = new Set(stalePaths);

  /**
   * Two mutation classes are legitimate here, and exactly two: writing a path
   * this promotion owns, and removing a stale one.
   *
   * The deletion allowance is deliberately narrow. A stale path that is
   * *modified* rather than deleted is somebody's uncommitted work sitting on
   * a file this promotion happens to want gone — erasing it because the
   * destination matches would be silent data loss, so only git's own `D`
   * status qualifies. An untracked path can never qualify at all, because
   * `stalePaths` is drawn from the index. What that buys is convergence: a
   * promotion interrupted after deleting leaves those paths reported deleted,
   * and its exact retry recomputes the identical `stalePaths` — the deleted
   * file is still in the index — and recognises its own unfinished work
   * instead of refusing forever.
   */
  const isExpectedMutation = (entry: { status: string; path: string }): boolean =>
    desiredPaths.has(entry.path) || (entry.status.includes('D') && staleSet.has(entry.path));

  const foreignBeforeStart = (await ws.dirtyEntries()).filter((e) => !isExpectedMutation(e));
  if (foreignBeforeStart.length > 0) {
    throw new PromotionWorkingTreeDirty(promotionId, foreignBeforeStart.map((e) => e.path));
  }

  // Idempotent materialisation: the harness scaffold never overwrites
  // existing files, and writing the same accepted candidate's files again —
  // whether this is the first attempt or a retry recovering from a crash
  // mid-write — reproduces exactly the same working tree either way.
  await scaffoldSite(ws.siteRoot);
  await ws.writeSiteFiles(candidate.files);

  /**
   * Removal comes last, and the order is load-bearing rather than tidy:
   * `scaffoldSite` copies with `force: false` and `writeSiteFiles` writes the
   * candidate's own paths, so deleting first would let either of them
   * resurrect a path this attempt had already removed. Exact files only —
   * never `clearSite`, never a recursive sweep of the site root — so an
   * unrelated untracked file in the tree is refused above rather than
   * quietly tidied away here.
   */
  for (const stale of stalePaths) {
    await rm(join(ws.root, stale), { force: true });
  }

  // Nothing the three mutations above do can dirty a path outside the two
  // expected classes; this re-check is a consistency guard against that same
  // class of problem from the other side, not expected to ever actually fire
  // in ordinary operation.
  const unexpectedAfterWrite = (await ws.dirtyEntries()).filter((e) => !isExpectedMutation(e));
  if (unexpectedAfterWrite.length > 0) {
    throw new PromotionWorkingTreeDirty(promotionId, unexpectedAfterWrite.map((e) => e.path));
  }

  const commitSha = await ws.commit(promotionCommitMessage(promotionId));
  if (!commitSha) throw new PromotionCommitProducedNothing(promotionId);

  const finalized = await deps.store.promotions.findOneAndUpdate(
    { _id: promotionId, status: 'prepared' },
    { $set: { status: 'committed', commitSha, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  record = finalized ?? record;

  return { jobId: job._id, attempt: job.attempt, candidate: outputRef, promotionId, commitSha };
}
