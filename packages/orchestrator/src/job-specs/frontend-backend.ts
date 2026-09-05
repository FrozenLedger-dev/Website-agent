/**
 * The one production `frontend_backend` `JobSpec` factory (Phase 5j).
 *
 * `runProject`'s job-mode build boundary needs exactly one deterministic
 * request per exact pinned input pair — never a `JobSpec` built inline at
 * the call site, and never a second, competing shape (`RunProjectJobSpec`,
 * `BuildJobSpecV2`). This module produces the existing `@statxai/contracts`
 * `JobSpec` that Phase 5i already consumes, nothing else.
 */
import { contentHash } from '@statxai/workspace';
import type { ArtifactRef, JobSpec } from '@statxai/contracts';
import { FRONTEND_BACKEND_INPUT } from '../job-handlers/frontend-backend.js';

const ROLE = 'frontend_backend';

/**
 * Stable, non-parameterised prose — never fed back into anything that reads
 * meaning from it, so keeping it constant across every request only
 * simplifies the identity computation below; it does not weaken it. The
 * pinned `businessProfileRef`/`sitePlanRef` are what actually identify a
 * request.
 */
const OBJECTIVE = 'Build the site from the approved plan.';
const ACCEPTANCE_CRITERIA = Object.freeze(['site files written from the approved plan']);

/**
 * No tool gateway reads `allowedTools` yet, and every existing
 * `frontend_backend` fixture already uses the empty set — granting more
 * here would be broadening it on spec, not on need.
 */
const ALLOWED_TOOLS = Object.freeze([]);

/**
 * The one logical output identity every `frontend_backend` job for a given
 * project must share (§21 of the brief this shipped under). `JobEngine`'s
 * output-conflict check (`outputsConflict`) is an exact-string-membership
 * test, not a prefix match — so this must be the *same* literal path for
 * every request a project ever makes here, never something derived from the
 * request itself (a jobId, an attempt, a pinned ref). Making it unique per
 * job would silently defeat the very serialisation this exists to provide:
 * two concurrent builds of the same project's frontend/backend output could
 * then run in parallel.
 */
const OUTPUT = Object.freeze(['app/']);

export interface CreateFrontendBackendJobSpecInput {
  readonly projectId: string;
  /** The exact, already-authoritative `businessProfile` ref — never "latest". */
  readonly businessProfileRef: ArtifactRef;
  /** The exact, already-authoritative `sitePlan` ref — never "latest". */
  readonly sitePlanRef: ArtifactRef;
}

/**
 * Every field that identifies this exact immutable request, and nothing
 * else. Deliberately excludes anything that is runtime state rather than
 * request intent — `createdAt`/`updatedAt`, a random id, `workerId`,
 * `attempt`, `lease`, `failure`, `executionOutputs`, a promotion commit, an
 * artifact `lineageSeq`, a `RunRecorder` sequence number, or canonical
 * `HEAD` — none of which describe *what was asked for*, only *what has
 * since happened*.
 */
type FrontendBackendJobIdentity = Omit<JobSpec, 'jobId'>;

function computeJobId(identity: FrontendBackendJobIdentity): string {
  // The exact same canonical-JSON identity primitive Phase 5i's own
  // `sameJobSpec` (`job-lifecycle/frontend-backend.ts`) already hashes a
  // full `JobSpec` with — reused here, not reinvented, and applied to every
  // field that primitive would later compare except `jobId` itself, which
  // cannot be part of its own preimage. Two calls with the same identity
  // always produce the same id; any field changing changes it.
  return `frontend-backend-${contentHash(identity)}`;
}

/**
 * Build the one deterministic `JobSpec` for a project's `frontend_backend`
 * build, pinned to the exact `businessProfile`/`sitePlan` refs supplied —
 * never resolved by this factory, always threaded in by the caller from
 * whatever already-authoritative source produced them.
 *
 * The same `(projectId, businessProfileRef, sitePlanRef)` always produces
 * the exact same `JobSpec`, including `jobId` — no current time, no
 * randomness, no artifact `lineageSeq`. A different pinned ref, of either
 * kind, always produces a different `jobId`, because it changes the
 * identity `jobId` is derived from.
 */
export function createFrontendBackendJobSpec(input: CreateFrontendBackendJobSpecInput): JobSpec {
  const identity: FrontendBackendJobIdentity = {
    projectId: input.projectId,
    role: ROLE,
    objective: OBJECTIVE,
    inputs: {
      [FRONTEND_BACKEND_INPUT.businessProfile]: input.businessProfileRef,
      [FRONTEND_BACKEND_INPUT.sitePlan]: input.sitePlanRef,
    },
    acceptanceCriteria: [...ACCEPTANCE_CRITERIA],
    allowedTools: [...ALLOWED_TOOLS],
    output: [...OUTPUT],
  };
  return { ...identity, jobId: computeJobId(identity) };
}
