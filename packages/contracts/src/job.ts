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
 * Note for the architecture review: there is no `superseded` state. When Sol
 * re-plans, in-flight jobs from the previous plan have no defined disposition —
 * `blocked` is the closest fit but does not mean the same thing. Left as the
 * document specifies rather than invented here.
 */
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  draft: ['ready', 'blocked'],
  ready: ['running', 'blocked'],
  running: ['validating', 'failed', 'ready'],
  validating: ['accepted', 'failed', 'repair_requested'],
  failed: ['ready', 'repair_requested', 'blocked'],
  repair_requested: ['ready', 'accepted', 'blocked'],
  blocked: ['ready', 'failed'],
  accepted: [],
});

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
