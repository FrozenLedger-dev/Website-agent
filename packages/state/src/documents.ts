/**
 * Persisted document shapes.
 *
 * These are the platform's own state — the half of the system the model never
 * authors and cannot influence (Appendix B: "state belongs to the platform,
 * reasoning belongs to the model").
 */
import type { ArtifactRef, AutonomyMode, JobRecord, JobSpec, ReviewOutcomeRecord, WorkerRole } from '@statxai/contracts';

/** Project lifecycle, distinct from job lifecycle. */
export type ProjectState =
  | 'intake'
  /**
   * Terminal. Intake did not meet the minimum business-profile bar, so the
   * project never reaches Build. Kept separate from `blocked` because the
   * remedy is different: `blocked` needs an engineering or policy decision,
   * this needs more information from the client.
   */
  | 'intake_insufficient'
  | 'planning'
  | 'building'
  | 'validating'
  | 'awaiting_human_review'
  | 'releasing'
  | 'released'
  | 'blocked'
  | 'rolled_back';

export interface ProjectDocument {
  _id: string;
  state: ProjectState;
  autonomyMode: AutonomyMode;
  /** Monotonic counter; increments on every completed review cycle. */
  reviewCycle: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A job document is its contract record plus the routing keys Mongo indexes. */
export interface JobDocument extends JobRecord {
  _id: string;
  projectId: string;
  role: WorkerRole;
}

/**
 * Project-level execution budgets (v1.2 §7).
 *
 * `limits` is per-project rather than global: §7 states these are starting
 * defaults, that Sol may lower them for high-risk projects, and that budget
 * changes are themselves recorded as project decisions.
 */
export interface BudgetLimits {
  reviewRejections: number;
  repairsPerDefect: number;
  totalRepairJobs: number;
  fullRebuilds: number;
  replans: number;
  failedDeployments: number;
}

export interface BudgetUsage {
  reviewRejections: number;
  totalRepairJobs: number;
  fullRebuilds: number;
  replans: number;
  failedDeployments: number;
}

export interface BudgetDocument {
  _id: string;
  limits: BudgetLimits;
  used: BudgetUsage;
  updatedAt: Date;
}

/**
 * Per-defect repair counter, keyed by fingerprint.
 *
 * Held in its own collection rather than as a map inside BudgetDocument so the
 * "repairs for this defect" and "repairs for this project" guards can each be a
 * single conditional update inside one transaction.
 */
export interface DefectBudgetDocument {
  _id: string;
  projectId: string;
  fingerprint: string;
  repairsUsed: number;
  firstSeenCycle: number;
  updatedAt: Date;
}

export function defectBudgetId(projectId: string, fingerprint: string): string {
  return `${projectId}:${fingerprint}`;
}

/** Stored artifact version. Immutable once written (Appendix B). */
export interface ArtifactDocument {
  _id: string;
  projectId: string;
  name: string;
  version: number;
  contentHash: string;
  data: unknown;
  /** Set when Sol accepts this version as an input for downstream work. */
  acceptedAt: Date | null;
  /**
   * Where this artifact sits in the project's persisted lineage.
   *
   * `version` is monotonic within one *name* — `site-plan@1`, `site-plan@2` —
   * and says nothing about whether the plan was written before or after the
   * route decision that followed it. This is monotonic across every artifact
   * the project has, allocated atomically by the store, and is the authority
   * for that question.
   *
   * Optional only because artifacts written before it existed do not have one.
   * Everything `ArtifactRegistry.put` writes does.
   */
  lineageSeq?: number;
  /**
   * When the artifact was recorded. Observational metadata, deliberately not
   * the ordering authority: it has millisecond resolution, and two writes in
   * the same millisecond are indistinguishable by it. Use {@link lineageSeq}
   * to ask what came before what.
   */
  createdAt: Date;
}

/**
 * The per-project artifact lineage counter.
 *
 * Its own collection rather than a field on `ProjectDocument`, because a run
 * deletes and recreates the project record at startup and artifact history
 * outlives that: a counter living there would reset, and the second run's
 * artifacts would claim to precede the first run's.
 *
 * `_id` is the project id, so Mongo's own `_id` uniqueness gives exactly one
 * counter per project with no extra index.
 */
export interface ArtifactSequenceDocument {
  _id: string;
  lastAllocated: number;
  updatedAt: Date;
}

export function artifactId(projectId: string, name: string, version: number): string {
  return `${projectId}:${name}@${version}`;
}

export interface ReviewDocument extends ReviewOutcomeRecord {
  _id: string;
}

/**
 * Append-only audit trail (§9). Records every sensitive tool call, approval,
 * release and budget decision.
 */
export interface AuditEvent {
  _id?: never;
  projectId: string;
  jobId: string | null;
  kind:
    | 'job_transition'
    | 'budget_spend'
    | 'budget_exhausted'
    | 'tool_call'
    | 'tool_denied'
    | 'artifact_accepted'
    | 'review_recorded'
    | 'release_decision';
  actor: string;
  detail: Record<string, unknown>;
  at: Date;
}

export type JobPromotionStatus = 'prepared' | 'committed';

/**
 * Durable receipt for one canonical promotion of an accepted job's exact
 * execution output (Phase 5h).
 *
 * `_id` is the deterministic promotion identity: the same accepted
 * execution (project, job, attempt, exact candidate ref) always derives the
 * same one, so a retry after any crash — mid-write, after the canonical Git
 * commit but before this record is finalized, or long after — finds and
 * resumes this exact record rather than ever creating a second one. This is
 * the durable half of promotion's replay safety; the other half is the
 * machine-readable marker Phase 5h writes into the promotion commit itself,
 * since a crash between the Git commit succeeding and this record being
 * finalized means Mongo alone cannot yet know the commit happened at all —
 * only the commit can prove that on the next attempt.
 *
 * `status` only ever moves `prepared -> committed`, once, by whichever
 * caller's retry is first to either create the canonical commit or discover
 * one already exists. There is no `promoted` `JobState`: acceptance and
 * canonical promotion are separate lifecycle dimensions, and this record —
 * not `JobDocument` — is where promotion's own state lives.
 */
export interface JobPromotionRecord {
  _id: string;
  projectId: string;
  jobId: string;
  attempt: number;
  output: ArtifactRef;
  /**
   * The canonical workspace commit this promotion was prepared against —
   * `null` when the workspace had no commit at all yet (a legitimate first
   * build, not a placeholder). Before applying a still-`prepared` promotion,
   * current canonical HEAD must still equal this, or promotion fails closed
   * rather than silently building on an unexpected lineage.
   */
  baseCommit: string | null;
  status: JobPromotionStatus;
  /** Set only once, the moment the canonical promotion commit is known — created by this attempt, or discovered already there. */
  commitSha: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FrontendBackendBuildBindingStatus = 'prepared' | 'promoted';

/**
 * The durable record that lets a fresh `runProject` invocation (Phase 5k)
 * resume an incomplete `frontend_backend` job-mode build after a restart,
 * rather than starting discovery/planning again and producing a different
 * `businessProfile`/`sitePlan` version — and therefore a different
 * deterministic `JobSpec`/`jobId` — for a build Phase 5i may already be
 * partway through.
 *
 * `_id` is deterministic (see `computeBindingId`,
 * `run-binding/frontend-backend.ts`), so a second fresh invocation for the
 * same logical request always derives the same record rather than ever
 * creating a second one. `jobSpec` is stored in full, not only as a hash: a
 * future code deployment could change the factory's defaults (objective
 * wording, `allowedTools`, output conventions), and reconstructing the spec
 * from new code on resume could silently address a different request than
 * the one Phase 5i is actually partway through executing. The stored spec
 * is authoritative for resume; `jobSpecHash` is an integrity/indexing aid,
 * never a substitute for it.
 *
 * `status` moves `prepared -> promoted` exactly once, the moment Phase 5i
 * returns `promoted` — mirroring `JobPromotionRecord`'s own
 * `prepared -> committed` shape. A `promoted` binding is retained as
 * historical control-plane evidence, never deleted, and no longer occupies
 * the project's one-active-binding slot (see the partial unique index on
 * `{ projectId }` in `StateStore.ensureIndexes`), so a later, genuinely new
 * build generation for the same project is free to prepare a new one.
 */
export interface FrontendBackendBuildBindingDocument {
  _id: string;
  projectId: string;
  status: FrontendBackendBuildBindingStatus;
  /** Identifies the logical request this binding answers — see `computeRunIntentHash`. */
  runIntentHash: string;
  businessProfile: ArtifactRef;
  sitePlan: ArtifactRef;
  /** The exact immutable request Phase 5i must resume — authoritative on resume, never reconstructed from current code. */
  jobSpec: JobSpec;
  jobSpecHash: string;
  jobId: string;
  /** Canonical HEAD at the moment this binding was prepared, before its specification commit — `null` for a project's first-ever commit. */
  specificationBaseCommit: string | null;
  /** Set once the specification commit is known to exist — created by this invocation, or discovered already there via its marker. */
  specificationCommitSha: string | null;
  /** Set only once `status` becomes `promoted`, from Phase 5i/5h's own returned values. */
  promotionId: string | null;
  promotionCommitSha: string | null;
  createdAt: Date;
  updatedAt: Date;
}
