/**
 * Persisted document shapes.
 *
 * These are the platform's own state — the half of the system the model never
 * authors and cannot influence (Appendix B: "state belongs to the platform,
 * reasoning belongs to the model").
 */
import type { AutonomyMode, JobRecord, ReviewOutcomeRecord, WorkerRole } from '@statxai/contracts';

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
  createdAt: Date;
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
