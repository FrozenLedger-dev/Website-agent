/**
 * Atomic acceptance of one fenced `frontend_backend` candidate (Phase 5g-2).
 *
 * Phase 5g-1 (`job-validation/frontend-backend.ts`) produces evidence — a
 * {@link FrontendBackendCandidateValidation} — that one job's exact staged
 * candidate passed the repo's deterministic gates. It accepts nothing: the
 * job stays `validating` and the candidate artifact stays unaccepted, on
 * both a pass and a fail. This module is the separate, explicit step that
 * consumes *successful* evidence and, in one Mongo transaction, accepts
 * exactly that candidate artifact and moves the job `validating -> accepted`
 * — never both, never neither, never one without the other.
 *
 * What this module is not: it does not re-run deterministic validation
 * (that authority belongs entirely to 5g-1), does not materialise the
 * candidate into the canonical project workspace, does not commit anything,
 * and never calls a model. It has no canonical-workspace dependency, no
 * model-client dependency, and no repair/deployment dependency of any kind
 * — nothing here could reach any of those even if it wanted to.
 */
import type { ClientSession } from 'mongodb';
import type { ArtifactRef } from '@statxai/contracts';
import type { JobDocument, StateStore } from '@statxai/state';
import type { ArtifactRegistry } from '@statxai/workspace';
import { jobOutputNamespace, type JobEngine } from '@statxai/job-engine';
import {
  authenticSuccessfulValidationBinding,
  type FrontendBackendCandidateValidation,
  type FrontendBackendValidationBinding,
} from '../job-validation/frontend-backend.js';
import { FRONTEND_BACKEND_INPUT } from '../job-handlers/frontend-backend.js';

const ROLE = 'frontend_backend';

/**
 * Fixed control-plane identity for every acceptance this module performs.
 * Never the original build worker's id, never `sol`/`terra`/`luna` — those
 * name *execution* authority (Phase 5f); this names *acceptance* authority,
 * which the harness alone holds. The same literal already used by every
 * generic `JobEngine.accept` test in this repo.
 */
export const ACCEPTANCE_ACTOR = 'harness:validator';

/**
 * `validation` has no authenticated passing binding — not the exact object
 * `validateFrontendBackendCandidate` returned for a pass, in this process.
 * Covers every way that can fail to hold: a hand-built lookalike, a clone
 * (`JSON.parse(JSON.stringify(...))`) of genuine evidence, a real result the
 * validator produced for a *failed* candidate (never registered as
 * acceptance-capable to begin with, regardless of what its own `ok` field
 * says now), or a real failed result mutated in place after the fact. All
 * four are indistinguishable once evidence stops being trustworthy on its
 * own terms, so this is the one check and the one error for all of them —
 * checked before `validation.binding` (the public, mutable field) is ever
 * read for anything but this error's own message.
 */
export class AcceptanceEvidenceNotAuthentic extends Error {
  constructor(jobId: string) {
    super(
      `job "${jobId}": no authenticated passing validation evidence is available for this exact object; refusing to accept`,
    );
    this.name = 'AcceptanceEvidenceNotAuthentic';
  }
}

/**
 * The job's *current* state no longer matches the exact binding the
 * validation evidence describes — read fresh, inside the same transaction
 * that would otherwise accept it. Any of `projectId`, `role`, `state`,
 * `attempt`, the candidate's namespace, the candidate ref itself, or either
 * pinned input can be the one that moved; `reason` says which was first to
 * fail, not which was the only one wrong.
 */
export class AcceptanceBindingStale extends Error {
  constructor(
    readonly jobId: string,
    readonly reason:
      | 'not_found'
      | 'projectId'
      | 'role'
      | 'state'
      | 'attempt'
      | 'namespace'
      | 'outputs'
      | 'businessProfile'
      | 'sitePlan',
  ) {
    super(`job "${jobId}": current ${reason} no longer matches the validated evidence; refusing to accept`);
    this.name = 'AcceptanceBindingStale';
  }
}

/** The exact validated candidate could not be found or accepted — a platform/data-integrity fault, not a validation failure. */
export class AcceptanceCandidateMissing extends Error {
  constructor(jobId: string, ref: ArtifactRef) {
    super(`job "${jobId}": candidate "${ref.name}@${ref.version}" could not be resolved or accepted`);
    this.name = 'AcceptanceCandidateMissing';
  }
}

/**
 * The job is already `accepted`, but its own state is inconsistent with the
 * validated binding — an accepted job whose candidate is unaccepted, or
 * whose binding no longer matches. Never silently repaired (§22): this is a
 * genuine control-plane fault to report, not a retryable acceptance.
 */
export class AcceptanceInconsistentState extends Error {
  constructor(jobId: string, detail: string) {
    super(`job "${jobId}": accepted job is in an inconsistent state — ${detail}`);
    this.name = 'AcceptanceInconsistentState';
  }
}

export interface FrontendBackendAcceptanceDeps {
  readonly store: StateStore;
  readonly registry: ArtifactRegistry;
  readonly engine: JobEngine;
}

/** What successful acceptance reports. Nothing else — no run/deployment/release shape. */
export interface FrontendBackendAcceptanceResult {
  readonly jobId: string;
  readonly attempt: number;
  readonly candidate: ArtifactRef;
  readonly state: 'accepted';
}

function refsEqual(a: ArtifactRef | undefined, b: ArtifactRef): boolean {
  return a !== undefined && a.name === b.name && a.version === b.version && a.contentHash === b.contentHash;
}

/**
 * `current` is typed `ArtifactRef[] | null`, but a legacy `JobDocument`
 * written before Phase 5f's `executionOutputs` field existed reads back with
 * it genuinely `undefined` at runtime — the schema's `.nullable().default`
 * only applies when a document is parsed through it, and nothing on this
 * read path does that (the same gap 5f's own compatibility test pins). `==
 * null` catches both, deliberately.
 */
function oneOutputEquals(current: readonly ArtifactRef[] | null | undefined, expected: ArtifactRef): boolean {
  return current != null && current.length === 1 && refsEqual(current[0], expected);
}

/**
 * Every fact the guarded acceptance re-proves against the job as read fresh
 * inside the transaction — everything 5g-1 already checked once, checked
 * again here independently, because evidence that was true when 5g-1 ran is
 * not evidence that it is still true now.
 */
function assertBindingCurrent(job: JobDocument, binding: FrontendBackendValidationBinding): void {
  if (job.projectId !== binding.projectId) throw new AcceptanceBindingStale(binding.jobId, 'projectId');
  if (job.role !== ROLE) throw new AcceptanceBindingStale(binding.jobId, 'role');
  if (job.state !== 'validating') throw new AcceptanceBindingStale(binding.jobId, 'state');
  if (job.attempt !== binding.attempt) throw new AcceptanceBindingStale(binding.jobId, 'attempt');

  // Re-proven independently of 5g-1, not merely trusted from its result —
  // the same helper (Phase 5f) it used, not a second implementation.
  const namespace = jobOutputNamespace(job._id, job.attempt);
  if (!binding.candidate.name.startsWith(namespace)) {
    throw new AcceptanceBindingStale(binding.jobId, 'namespace');
  }

  if (!oneOutputEquals(job.executionOutputs, binding.candidate)) {
    throw new AcceptanceBindingStale(binding.jobId, 'outputs');
  }

  const currentProfileRef = job.spec.inputs[FRONTEND_BACKEND_INPUT.businessProfile];
  if (!refsEqual(currentProfileRef, binding.businessProfile)) {
    throw new AcceptanceBindingStale(binding.jobId, 'businessProfile');
  }
  const currentPlanRef = job.spec.inputs[FRONTEND_BACKEND_INPUT.sitePlan];
  if (!refsEqual(currentPlanRef, binding.sitePlan)) {
    throw new AcceptanceBindingStale(binding.jobId, 'sitePlan');
  }
}

/**
 * An exact replay of an already-successful acceptance (§22 of the brief this
 * shipped under): read-only, and only ever a *success* echo — never a
 * silent repair. A job already `accepted` whose binding and candidate
 * acceptance still agree returns the same result acceptance would have
 * produced, without a second transition audit or a second candidate write.
 * Disagreement is reported, never guessed at.
 */
async function reconcileAlreadyAccepted(
  job: JobDocument,
  binding: FrontendBackendValidationBinding,
  deps: FrontendBackendAcceptanceDeps,
): Promise<FrontendBackendAcceptanceResult> {
  if (job.projectId !== binding.projectId || job.attempt !== binding.attempt || !oneOutputEquals(job.executionOutputs, binding.candidate)) {
    throw new AcceptanceInconsistentState(binding.jobId, 'the accepted job no longer matches the validated binding');
  }
  const doc = await deps.store.artifacts.findOne({ projectId: binding.projectId, name: binding.candidate.name, version: binding.candidate.version });
  if (!doc || doc.acceptedAt === null) {
    throw new AcceptanceInconsistentState(binding.jobId, 'the job is accepted but its exact candidate artifact is not');
  }
  return { jobId: job._id, attempt: job.attempt, candidate: binding.candidate, state: 'accepted' };
}

/**
 * Accept exactly the candidate one successful {@link FrontendBackendCandidateValidation}
 * describes, atomically with moving its job `validating -> accepted`.
 *
 * The binding used for every authority decision below is the private,
 * authenticated snapshot `authenticSuccessfulValidationBinding` returns —
 * never `validation.binding` itself. That field is real, but it is also the
 * exact object a caller still holds a reference to, and mutating it in
 * place (`(validation as { binding: X }).binding = tampered`) is enough to
 * make it describe a different candidate entirely. Proving `validation` is
 * the real validator's own object, by itself, says nothing about whether
 * its *public* binding still matches what was actually validated — only the
 * *private* snapshot, cloned at the moment deterministic validation passed
 * and never exposed for mutation, can answer that. If it disagrees with the
 * live job, `assertBindingCurrent` below still catches it; if it has been
 * made to agree by tampering with the public field instead of the private
 * one, checking the public field would not have caught it at all, which is
 * exactly why this function never reads `validation.binding` again once
 * this line has run.
 *
 * No snapshot is returned for anything but a genuine pass, checked first,
 * before any of it: a failed, forged, cloned, or forge-mutated result has no
 * private binding to retrieve at all, regardless of what its own `ok` field
 * says now. Otherwise: the job is re-read fresh, inside one Mongo
 * transaction, and every fact the snapshot depends on (project, role,
 * state, attempt, output namespace, the exact candidate ref, and both
 * pinned inputs) is re-proven against that read before either write is
 * attempted. `ArtifactRegistry.accept` and `JobEngine.accept`'s guarded form
 * share the same session; if either fails, the whole transaction aborts and
 * neither side is left partially accepted.
 */
export async function acceptValidatedFrontendBackendCandidate(
  validation: FrontendBackendCandidateValidation,
  deps: FrontendBackendAcceptanceDeps,
): Promise<FrontendBackendAcceptanceResult> {
  const binding = authenticSuccessfulValidationBinding(validation);
  if (!binding) {
    throw new AcceptanceEvidenceNotAuthentic(validation.binding.jobId);
  }

  // Cheap, read-only pre-check — not the authoritative one (§16 of the
  // brief this shipped under permits this before any transaction opens).
  // Exists only to make an exact replay of an already-successful acceptance
  // safe; every other case falls through to the guarded transaction below,
  // which re-reads and re-proves everything again regardless.
  const preCheck = await deps.store.jobs.findOne({ _id: binding.jobId });
  if (preCheck?.state === 'accepted') {
    return reconcileAlreadyAccepted(preCheck, binding, deps);
  }

  return deps.store.withTransaction(async (session: ClientSession) => {
    const currentJob = await deps.store.jobs.findOne({ _id: binding.jobId }, { session });
    if (!currentJob) throw new AcceptanceBindingStale(binding.jobId, 'not_found');
    assertBindingCurrent(currentJob, binding);

    // The control-plane existence/identity check before acceptance — not a
    // second validation run. `accept` is addressed by the exact
    // `(projectId, name, version)` identity, so a `false` return means no
    // artifact exists under that exact identity at all: a data-integrity
    // fault (§32 of the brief this shipped under), surfaced here rather than
    // treated as a silent no-op. Checked transactionally, inside this same
    // session, rather than by a separate untransacted `resolve` beforehand
    // that could only ever restate the identical fact.
    const accepted = await deps.registry.accept(currentJob.projectId, binding.candidate, session);
    if (!accepted) throw new AcceptanceCandidateMissing(binding.jobId, binding.candidate);

    // JobEngine's own guarded form — it does not trust the checks above; it
    // re-reads and re-proves attempt/executionOutputs itself, inside this
    // same session, before it will move the job at all.
    const acceptedJob = await deps.engine.accept(binding.jobId, ACCEPTANCE_ACTOR, {
      expectedAttempt: binding.attempt,
      expectedOutputs: [binding.candidate],
      session,
    });

    return {
      jobId: acceptedJob._id,
      attempt: acceptedJob.attempt,
      candidate: binding.candidate,
      state: 'accepted' as const,
    };
  });
}
