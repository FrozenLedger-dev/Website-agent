/**
 * Isolated deterministic validation of one fenced `frontend_backend` candidate
 * (Phase 5g-1).
 *
 * Phase 5f's handler (`job-handlers/frontend-backend.ts`) stages a
 * {@link BuildCandidate} under an execution-scoped artifact name and attaches
 * a reference to it as the validating job's own `executionOutputs` — but
 * proves nothing about whether that candidate is any good. This module closes
 * that gap with the same deterministic measurement `evaluateSite` already
 * runs against the direct delivery path (`runDeterministicGates`, extracted
 * from `phases/evaluate.js` for exactly this reuse), pointed at a disposable
 * workspace instead of the canonical one.
 *
 * What this module is not: it does not accept the job, does not accept the
 * candidate artifact, does not promote anything into the canonical project
 * workspace, does not request repair, and never calls a model — Terra's
 * subjective review is `evaluateSite`'s job, not this one's. It has no
 * lifecycle-transition authority and no model client, and writes nothing
 * outside the disposable workspace it creates and tears down for its own
 * use. Its result is in-process evidence only: this phase persists nothing
 * new, for a later slice to consume.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { GeneratedFile, type ArtifactRef, type BusinessProfile, type SitePlan } from '@statxai/contracts';
import type { JobDocument } from '@statxai/state';
import { ProjectWorkspace, scaffoldSite, type ArtifactRegistry, type BuildResult } from '@statxai/workspace';
import { jobOutputNamespace } from '@statxai/job-engine';
import { runDeterministicGates } from '../phases/evaluate.js';
import type { BuildCandidate } from '../phases/build.js';
import { FRONTEND_BACKEND_INPUT } from '../job-handlers/frontend-backend.js';

type DeterministicGateResult = Awaited<ReturnType<typeof runDeterministicGates>>;

const ROLE = 'frontend_backend';

/** The candidate belongs to a job whose role is not `frontend_backend`. */
export class CandidateValidationRoleMismatch extends Error {
  constructor(actual: string) {
    super(`frontend_backend candidate validation invoked with a job whose role is "${actual}", not "${ROLE}"`);
    this.name = 'CandidateValidationRoleMismatch';
  }
}

/** Only a `validating` job has a fenced candidate this module may validate. */
export class CandidateValidationStateMismatch extends Error {
  constructor(jobId: string, actual: string) {
    super(`job "${jobId}" is "${actual}", not "validating" — nothing fenced for this module to validate yet`);
    this.name = 'CandidateValidationStateMismatch';
  }
}

/** `executionOutputs` is null, undefined, or empty — no candidate is attached. */
export class CandidateValidationMissingOutputs extends Error {
  constructor(jobId: string) {
    super(`job "${jobId}" has no executionOutputs attached; nothing to validate`);
    this.name = 'CandidateValidationMissingOutputs';
  }
}

/**
 * The handler contract stages exactly one output ref per execution. A count
 * other than one is never silently narrowed to "the first one" or "the last
 * one" — it fails closed, because either shape would be guessing.
 */
export class CandidateValidationOutputCountMismatch extends Error {
  constructor(jobId: string, count: number) {
    super(`job "${jobId}" has ${count} executionOutputs ref(s); this module requires exactly 1`);
    this.name = 'CandidateValidationOutputCountMismatch';
  }
}

/**
 * The attached ref is not namespaced under this exact job and attempt
 * (Phase 5f's `jobOutputNamespace`). A ref belonging to another job, another
 * attempt, or an arbitrary name cannot be this execution's candidate.
 */
export class CandidateValidationNamespaceMismatch extends Error {
  constructor(jobId: string, attempt: number, refName: string) {
    super(
      `job "${jobId}" attempt ${attempt}: executionOutputs ref "${refName}" is not namespaced under ` +
        `${jobOutputNamespace(jobId, attempt)}`,
    );
    this.name = 'CandidateValidationNamespaceMismatch';
  }
}

/** A required pinned input (`businessProfile` or `sitePlan`) was absent from the job. */
export class CandidateValidationInputInvalid extends Error {
  constructor(jobId: string, key: string) {
    super(`job "${jobId}" is missing required pinned input "${key}"; cannot validate its candidate`);
    this.name = 'CandidateValidationInputInvalid';
  }
}

/** The resolved candidate does not have the shape `BuildCandidate` requires. */
export class CandidateValidationShapeInvalid extends Error {
  constructor(jobId: string, issue: string) {
    super(`job "${jobId}"'s staged candidate does not match the expected BuildCandidate shape: ${issue}`);
    this.name = 'CandidateValidationShapeInvalid';
  }
}

/**
 * The minimal runtime shape check {@link BuildCandidate} needs before
 * anything it carries is written to disk. `routeDecisions` is not read by
 * deterministic validation at all (it feeds nothing gates or the build read),
 * so it is checked only for presence as an array, not deeply — `files` is
 * what materialises, and reuses the one existing `GeneratedFile` schema
 * (`@statxai/contracts`) rather than inventing a second one.
 */
const CandidateShape = z.object({
  routeDecisions: z.array(z.unknown()),
  files: z.array(GeneratedFile),
});

export interface FrontendBackendCandidateValidationDeps {
  readonly registry: ArtifactRegistry;
  /**
   * Root under which a fresh, disposable validation workspace is created for
   * each call and removed again in `finally` — never the canonical
   * `workspacesRoot` a `ProjectWorkspace` for this project might otherwise
   * live under. Must already exist.
   */
  readonly validationWorkspacesRoot: string;
}

/**
 * Everything a later acceptance step (Phase 5g-2) needs to re-prove this
 * evidence is still current, before trusting it: which project, which job,
 * which exact execution ("attempt"), and the exact three artifact refs
 * deterministic validation actually ran against — the staged candidate and
 * the two pinned inputs it was built and gated with. Not persisted anywhere
 * by this module; carried only in the in-process result below.
 */
export interface FrontendBackendValidationBinding {
  readonly projectId: string;
  readonly jobId: string;
  readonly attempt: number;
  /** The exact ref validated — `job.executionOutputs[0]`, never "latest". */
  readonly candidate: ArtifactRef;
  readonly businessProfile: ArtifactRef;
  readonly sitePlan: ArtifactRef;
}

/** What one isolated, deterministic pass over a fenced candidate found. */
export interface FrontendBackendCandidateValidation {
  readonly binding: FrontendBackendValidationBinding;
  /** `compiled.ok && gateRun.passed`. */
  readonly ok: boolean;
  readonly compiled: BuildResult;
  readonly gateRun: DeterministicGateResult['gateRun'];
}

/** A {@link FrontendBackendCandidateValidation} narrowed to the branch acceptance may ever act on. */
export type SuccessfulFrontendBackendCandidateValidation = FrontendBackendCandidateValidation & { readonly ok: true };

function cloneArtifactRef(ref: ArtifactRef): ArtifactRef {
  return Object.freeze(
    ref.contentHash === undefined
      ? { name: ref.name, version: ref.version }
      : { name: ref.name, version: ref.version, contentHash: ref.contentHash },
  );
}

/** A binding, copied field-by-field into fresh objects nothing outside this module ever holds a reference to. */
function cloneValidationBinding(binding: FrontendBackendValidationBinding): FrontendBackendValidationBinding {
  return Object.freeze({
    projectId: binding.projectId,
    jobId: binding.jobId,
    attempt: binding.attempt,
    candidate: cloneArtifactRef(binding.candidate),
    businessProfile: cloneArtifactRef(binding.businessProfile),
    sitePlan: cloneArtifactRef(binding.sitePlan),
  });
}

/**
 * In-process evidence authenticity (Phase 5g-2's requirement on this
 * module's output, not a concern of validation itself) — and, deliberately,
 * *only* for a pass, and *only* by a private, unreachable snapshot of the
 * binding, never the public `result.binding` a caller can still mutate.
 *
 * This mechanism has already been through two narrower versions, each
 * closing a gap the previous one left:
 *
 *   1. A `WeakSet` registering every result, pass or fail alike, keyed on
 *      object identity. It proved an object was genuinely the validator's
 *      own but nothing about whether `ok` could still be trusted —
 *      `readonly` is a compile-time fiction, so a failed result mutated in
 *      place (`(validation as { ok: boolean }).ok = true`) was still the
 *      exact registered object.
 *   2. Registering *only* a passing result closed that — a failed result is
 *      never a member at all, so no mutation of `ok` after the fact can
 *      retroactively add it. But `assertBindingCurrent` (in the acceptance
 *      module) still read `validation.binding` — the same public, mutable
 *      field a caller holds a reference to — for every authority decision.
 *      Proving the *result object* was authentic said nothing about whether
 *      its *binding* still described what was actually validated: mutate
 *      `result.binding` in place to describe a different candidate, and if
 *      the live job has *also* moved to describe that same candidate by
 *      then, every check would agree with the tampered binding, and a
 *      candidate that was never deterministically validated would be
 *      accepted.
 *
 * This third version is a `WeakMap`, not a `WeakSet`: what it stores per
 * result is not a bare "yes, registered" flag but an independent snapshot of
 * the binding, cloned field-by-field at the moment validation actually
 * passed, into objects the public `result.binding` never shares a reference
 * with and no caller outside this module ever sees. Acceptance must use
 * *this* snapshot for every authority decision — never `validation.binding`
 * — so mutating the public copy changes nothing about what was actually
 * authenticated: the two can now disagree, and when they do, the private
 * snapshot is what acceptance still checks the live job against.
 */
const AUTHENTIC_SUCCESSFUL_VALIDATIONS = new WeakMap<object, FrontendBackendValidationBinding>();

/**
 * The private, authenticated binding snapshot for `value`, or `null` if
 * `value` is not the exact passing object `validateFrontendBackendCandidate`
 * returned in this process. This — never `(value as FrontendBackendCandidateValidation).binding`
 * — is the only binding acceptance may ever use for an authority decision.
 */
export function authenticSuccessfulValidationBinding(value: unknown): FrontendBackendValidationBinding | null {
  if (typeof value !== 'object' || value === null) return null;
  return AUTHENTIC_SUCCESSFUL_VALIDATIONS.get(value) ?? null;
}

function requiredRef(job: JobDocument, key: string): ArtifactRef {
  const ref = job.spec.inputs[key];
  if (!ref) throw new CandidateValidationInputInvalid(job._id, key);
  return ref;
}

/**
 * Validate the exact fenced candidate one `validating` `frontend_backend` job
 * has attached, against the repo's own deterministic gates, inside a
 * disposable workspace. Never mutates the job, the candidate, or the
 * canonical project workspace — see the module doc comment for the full list
 * of what this deliberately does not do.
 *
 * Every check below fails closed, in this order, before anything is resolved
 * or written: role, then state, then that a candidate is attached at all,
 * then that there is exactly one, then that it is namespaced under this exact
 * job and attempt. Only once all of that holds does resolution — always via
 * `job.projectId`, always the exact pinned ref, never "latest" — even begin.
 */
export async function validateFrontendBackendCandidate(
  job: JobDocument,
  deps: FrontendBackendCandidateValidationDeps,
): Promise<FrontendBackendCandidateValidation> {
  if (job.role !== ROLE) throw new CandidateValidationRoleMismatch(job.role);
  if (job.state !== 'validating') throw new CandidateValidationStateMismatch(job._id, job.state);

  const outputs = job.executionOutputs;
  if (!outputs || outputs.length === 0) throw new CandidateValidationMissingOutputs(job._id);
  if (outputs.length !== 1) throw new CandidateValidationOutputCountMismatch(job._id, outputs.length);

  const candidateRef = outputs[0]!;
  const namespace = jobOutputNamespace(job._id, job.attempt);
  if (!candidateRef.name.startsWith(namespace)) {
    throw new CandidateValidationNamespaceMismatch(job._id, job.attempt, candidateRef.name);
  }

  const profileRef = requiredRef(job, FRONTEND_BACKEND_INPUT.businessProfile);
  const planRef = requiredRef(job, FRONTEND_BACKEND_INPUT.sitePlan);

  // Project-relative, and always the exact pinned/attached ref: `resolve`
  // never sorts by version, so a version accepted or staged after this job
  // reached `validating` cannot change what gets validated, and the artifact
  // document's own id embeds `job.projectId`, so a ref cannot address another
  // project's artifact regardless of what the job itself claims.
  const [rawCandidate, profile, plan] = await Promise.all([
    deps.registry.resolve(job.projectId, candidateRef),
    deps.registry.resolve<BusinessProfile>(job.projectId, profileRef),
    deps.registry.resolve<SitePlan>(job.projectId, planRef),
  ]);

  const parsed = CandidateShape.safeParse(rawCandidate);
  if (!parsed.success) {
    throw new CandidateValidationShapeInvalid(job._id, parsed.error.issues.map((i) => i.message).join('; '));
  }
  const candidate = parsed.data as BuildCandidate;

  const validationRoot = await mkdtemp(join(deps.validationWorkspacesRoot, `${job._id}-attempt${job.attempt}-`));
  try {
    // A disposable `ProjectWorkspace`, never the canonical one this project
    // might otherwise have — a fresh temp root, unrelated to whatever
    // `workspacesRoot` the harness uses for real project workspaces. Reuses
    // the same safe file writer (`safeSitePath`/`writeSiteFiles`) the direct
    // delivery path and the real handler both rely on, rather than a second,
    // competing implementation of path safety. `.commit()` is never called.
    const ws = await ProjectWorkspace.open(job.projectId, validationRoot);
    await scaffoldSite(ws.siteRoot);
    await ws.writeSiteFiles(candidate.files);

    const { compiled, gateRun } = await runDeterministicGates(ws.siteRoot, profile, plan);

    const binding: FrontendBackendValidationBinding = {
      projectId: job.projectId,
      jobId: job._id,
      attempt: job.attempt,
      candidate: candidateRef,
      businessProfile: profileRef,
      sitePlan: planRef,
    };
    const result: FrontendBackendCandidateValidation = {
      binding,
      ok: compiled.ok && gateRun.passed,
      compiled,
      gateRun,
    };

    // A private snapshot, registered only on this exact branch — never for a
    // fail — and cloned rather than pointed at the same `binding` object
    // `result.binding` exposes: mutating the public field afterward, or the
    // objects nested in it, changes nothing about what this snapshot says.
    // See the module doc comment on the `WeakMap` itself for the two
    // narrower designs this replaced and exactly what each one still let
    // through.
    if (result.ok) {
      AUTHENTIC_SUCCESSFUL_VALIDATIONS.set(result, cloneValidationBinding(binding));
    }
    return result;
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
}

/**
 * Convenience factory matching `createTerraFrontendBackendHandler`'s shape:
 * deps fixed once, a plain `(job) => Promise<...>` function handed to
 * whatever calls it per job. Ensures `validationWorkspacesRoot` exists once,
 * rather than on every call.
 */
export function createFrontendBackendCandidateValidator(
  deps: FrontendBackendCandidateValidationDeps,
): (job: JobDocument) => Promise<FrontendBackendCandidateValidation> {
  const ready = ensureRoot(deps.validationWorkspacesRoot);
  return async (job: JobDocument) => {
    await ready;
    return validateFrontendBackendCandidate(job, deps);
  };
}
