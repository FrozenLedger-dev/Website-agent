/**
 * Job contract and job lifecycle (v1.2 §4).
 *
 * Two shapes, deliberately separated:
 *
 *   JobSpec    the exchange contract — exactly what a worker is handed. Matches
 *              the example in §4. Contains no control-plane state, so it can be
 *              serialised into a prompt without leaking scheduler internals.
 *   JobRecord  the persisted document — the spec plus everything the engine
 *              needs to schedule, lease, retry and audit it.
 */
import * as z from 'zod/v4';
import { ArtifactRef, JobId, ProjectId, ToolId, WorkerRole } from './primitives.js';

// ---------------------------------------------------------------------------
// Job state machine (v1.2 §4, "Job Lifecycle")
// ---------------------------------------------------------------------------

export const JobState = z.enum([
  'draft',
  'ready',
  'running',
  'validating',
  'accepted',
  'failed',
  'repair_requested',
  'blocked',
  'superseded',
]);
export type JobState = z.infer<typeof JobState>;

/**
 * Legal transitions. The document specifies
 * Draft → Ready → Running → Validating → Accepted, with Failed /
 * Repair Requested for failures and Blocked for dependency problems.
 *
 * `running → ready` is the one edge added beyond the document's prose: it is
 * lease reclamation. Without it a worker crash strands the job in `running`
 * forever, since nothing else can claim it.
 *
 * `superseded` (Phase 5m) closes the gap the architecture review once noted
 * here: an operator explicitly abandoning a durably-bound build now has a
 * defined disposition for that build's pre-acceptance job, distinct from
 * `blocked` — `blocked` means a dependency/policy problem that may still be
 * resolved forward; `superseded` means this exact execution has been
 * permanently revoked and will never run, validate, or accept again.
 * Reachable from every pre-acceptance state (`draft`, `ready`, `running`,
 * `validating`, `failed`, `repair_requested`, `blocked`) — and, as of Phase
 * 5n, from `accepted` too, but only through the narrow guarded primitive
 * that requires the accepted job to still own no promotion fence
 * (`JobEngine.supersedeAcceptedBeforePromotion` — see
 * `packages/state/src/documents.ts`'s `JobDocument.promotionFence` and
 * `docs/upgrade-status.md`'s Phase 5n section). The generic
 * `JobEngine.supersede()` still never offers this edge — its own guarded
 * filter simply never names `accepted` as a source state, unchanged since
 * Phase 5m — so this table entry alone does not, by itself, let anything
 * casually supersede an accepted job; it only makes the edge *structurally*
 * legal for the one narrow, fence-checked caller that needs it. `superseded`
 * itself still has no outgoing edges — once reached, permanently terminal,
 * never reclaimed, released, retried, or re-accepted.
 */
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  draft: ['ready', 'blocked', 'superseded'],
  ready: ['running', 'blocked', 'superseded'],
  running: ['validating', 'failed', 'ready', 'superseded'],
  validating: ['accepted', 'failed', 'repair_requested', 'superseded'],
  failed: ['ready', 'repair_requested', 'blocked', 'superseded'],
  repair_requested: ['ready', 'accepted', 'blocked', 'superseded'],
  blocked: ['ready', 'failed', 'superseded'],
  accepted: ['superseded'],
  superseded: [],
});

/**
 * Not "every state with no outgoing transition" — `accepted` and
 * `superseded` are both that, structurally, but this array means
 * specifically *successful* completion: the one state a job dependency
 * (`JobRecord.dependsOn`, `JobEngine.dependenciesSatisfied`) is satisfied
 * by. Deliberately still exactly `['accepted']` after Phase 5m added
 * `superseded` — inspected before editing, per that phase's own brief:
 * this array has no consumer in the codebase today (grepped, confirmed),
 * but its meaning is the one a future dependency-satisfaction consumer
 * would read it for, and `superseded` must never satisfy a dependency the
 * way `accepted` does (a permanently-revoked upstream job must leave its
 * dependents permanently unschedulable, not accidentally unblocked). If a
 * future need arises for "every state execution can never leave," that is
 * a different array with a different name, not a redefinition of this one.
 */
export const TERMINAL_JOB_STATES: readonly JobState[] = Object.freeze(['accepted']);

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new IllegalJobTransition(from, to);
  }
}

export class IllegalJobTransition extends Error {
  constructor(
    readonly from: JobState,
    readonly to: JobState,
  ) {
    super(`Illegal job transition ${from} → ${to}`);
    this.name = 'IllegalJobTransition';
  }
}

// ---------------------------------------------------------------------------
// Job origin — why this job exists
// ---------------------------------------------------------------------------

/**
 * Provenance. This is what makes the escalation ladder in §7 auditable, and
 * what lets the budget engine attribute a repair to the defect that caused it.
 */
export const JobOrigin = z.discriminatedUnion('kind', [
  /** Created by Sol from the initial plan. */
  z.object({ kind: z.literal('plan') }),
  /** Narrow Luna repair for one defect. */
  z.object({
    kind: z.literal('repair'),
    defectFingerprint: z.string().min(1),
    reviewCycle: z.number().int().nonnegative(),
    parentJobId: JobId,
  }),
  /** Escalation after repeated repair failure: Luna → Terra specialist. */
  z.object({
    kind: z.literal('specialist_escalation'),
    defectFingerprint: z.string().min(1),
    reviewCycle: z.number().int().nonnegative(),
    parentJobId: JobId,
  }),
  /** The single permitted controlled rebuild. */
  z.object({ kind: z.literal('rebuild'), reviewCycle: z.number().int().nonnegative() }),
  /** Sol specification/architecture revision. */
  z.object({ kind: z.literal('replan'), reviewCycle: z.number().int().nonnegative() }),
  /**
   * A bounded Terra visual refinement of the canonical build, authorised by the
   * harness from an exact visual quality review. Not a replan: the plan is unchanged.
   */
  z.strictObject({ kind: z.literal('visual_refine'), refinementCycle: z.number().int().min(1).max(1_000) }),
]);
export type JobOrigin = z.infer<typeof JobOrigin>;

// ---------------------------------------------------------------------------
// Job specification — the §4 exchange contract
// ---------------------------------------------------------------------------

export const JobSpec = z.object({
  projectId: ProjectId,
  jobId: JobId,
  role: WorkerRole,
  objective: z.string().min(1),

  /** Named, version-pinned inputs. Keys are the worker-facing input names. */
  inputs: z.record(z.string().min(1), ArtifactRef),

  /**
   * What "done" means for this job. §7 forbids accepting "the builder says it
   * is done", and every rejection must cite one of these, so a job without
   * acceptance criteria is unreviewable by construction.
   */
  acceptanceCriteria: z.array(z.string().min(1)).min(1),

  /** Least privilege: tools not listed here are denied by the gateway. */
  allowedTools: z.array(ToolId),

  /**
   * Declared output paths. Also the concurrency lever: two ready jobs whose
   * output sets intersect cannot run in parallel against one project
   * repository, and the scheduler uses this to serialise them.
   */
  output: z.array(z.string().min(1)).min(1),
});
export type JobSpec = z.infer<typeof JobSpec>;

// ---------------------------------------------------------------------------
// Job record — the persisted document
// ---------------------------------------------------------------------------

/**
 * Exclusive claim on a job. `expiresAt` is what allows a crashed worker's job
 * to be reclaimed instead of stranding it in `running`.
 */
export const JobLease = z.object({
  holder: z.string().min(1),
  expiresAt: z.date(),
});
export type JobLease = z.infer<typeof JobLease>;

export const JobFailure = z.object({
  message: z.string(),
  at: z.date(),
  /** Set when the failure was a gateway policy denial rather than a defect. */
  policyViolation: z.boolean().default(false),
});
export type JobFailure = z.infer<typeof JobFailure>;

/**
 * Durable, non-expiring promotion ownership authority for one `accepted`
 * job (Phase 5n). Stored on the authoritative `JobDocument` itself rather
 * than a second collection: canonical promotion (Phase 5h) and
 * accepted-state abandonment (Phase 5m/5n) already compete over this exact
 * document, so this is one Mongo serialisation point rather than a second
 * lock system layered alongside it.
 *
 * `promotionId`/`attempt`/`candidate`/`baseCommit` are never re-derived
 * once acquired — they pin the *exact* execution this fence authorises, so
 * a later reader never has to guess whether a fence describes the promotion
 * currently in question. `acquiredAt` is observational only, never the
 * authority: unlike `JobLease`, this has no `expiresAt`, no heartbeat, and
 * no release primitive. Once written, it is permanent evidence — canonical
 * filesystem/Git mutation may already have happened by the time any process
 * reads it again, so nothing may ever "expire" or "reclaim" it the way a
 * worker lease can.
 */
export const JobPromotionFence = z.object({
  promotionId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  candidate: ArtifactRef,
  /** Canonical HEAD this fence was acquired against — `null` for a project's first-ever commit, never a placeholder. */
  baseCommit: z.string().nullable(),
  acquiredAt: z.date(),
});
export type JobPromotionFence = z.infer<typeof JobPromotionFence>;

export const JobRecord = z.object({
  spec: JobSpec,
  state: JobState,
  origin: JobOrigin,

  /** Dependency-aware job graph (§3). A job is schedulable when all are accepted. */
  dependsOn: z.array(JobId).default([]),

  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),

  lease: JobLease.nullable().default(null),
  failure: JobFailure.nullable().default(null),

  /**
   * Set only once, by `JobEngine.acquirePromotionFence` (Phase 5n) —
   * never by any other write path. `null` and `undefined` both mean "no
   * fence acquired": a `JobDocument` written before Phase 5n existed
   * simply lacks this key entirely, which is a normal, valid `accepted`
   * document, not one needing a migration — every read site treats the two
   * identically (`== null`), and the Mongo guard this field is checked
   * through (`{ promotionFence: null }`) already matches both a `null`
   * value and a missing key by Mongo's own query semantics.
   */
  promotionFence: JobPromotionFence.nullable().default(null),

  /**
   * What the exact execution that reached `validating` actually produced
   * (Phase 5f). Attached only by the guarded `running -> validating`
   * transition, in the same update as the state change — never written by a
   * handler directly, and never by an execution attempt other than the one
   * whose token the transition was guarded on. `null` until that happens;
   * still `null` for a job whose handler returns no output (existing `void`
   * handlers stay valid — an empty result is not an error).
   *
   * This is the job's *actual* output. `JobSpec` above stays what the work
   * was *expected* to produce, and is never mutated after enqueue.
   */
  executionOutputs: z.array(ArtifactRef).nullable().default(null),

  createdAt: z.date(),
  updatedAt: z.date(),
});
export type JobRecord = z.infer<typeof JobRecord>;

// ---------------------------------------------------------------------------
// Scheduling helpers
// ---------------------------------------------------------------------------

/** True when two jobs declare overlapping outputs and must not run concurrently. */
export function outputsConflict(a: Pick<JobSpec, 'output'>, b: Pick<JobSpec, 'output'>): boolean {
  const left = new Set(a.output);
  return b.output.some((path) => left.has(path));
}
