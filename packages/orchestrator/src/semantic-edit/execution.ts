/**
 * Semantic-edit execution: which worker is continuing an edit right now, and
 * where an edit stands — for workers and for a future customer route.
 *
 * Two kinds of ownership, never confused:
 *
 * - The edit's semantic authority is its draft's claim. It has no expiry, and
 *   nothing here reads, writes, releases or re-derives it.
 * - A worker's execution lease on an intent is liveness only. It expires unless
 *   renewed; once expired, another worker may continue exactly the same edit —
 *   the same intent, model, source, job and successor. Every write is a
 *   compare-and-set on the lease's opaque token, so a worker that lost its lease
 *   changes nothing.
 *
 * `semantic_edit_intents` are the durable work records. Discovery orders by
 * creation time for scheduling; it decides no authority, and every continuation
 * re-proves its own.
 */
import { randomUUID } from 'node:crypto';
import type { ArtifactRef } from '@statxai/contracts';
import type { SemanticEditFailureReason, SemanticEditIntentDocument, StateStore } from '@statxai/state';

/** The statuses a worker still has something to do for. */
export const RUNNABLE_SEMANTIC_EDIT_STATUSES = Object.freeze(['building', 'promoted', 'evaluated'] as const);

export interface ClaimedSemanticEditExecution {
  readonly intentId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly status: SemanticEditIntentDocument['status'];
  readonly token: string;
  readonly expiresAt: Date;
}

const runnable = (now: Date) => ({
  status: { $in: [...RUNNABLE_SEMANTIC_EDIT_STATUSES] },
  disposition: { $exists: false },
  $or: [{ execution: { $exists: false } }, { 'execution.expiresAt': { $lte: now } }],
});

/**
 * Atomically lease one runnable edit — the oldest by creation, or exactly
 * `intentId` — whose execution is unowned or whose lease has expired. `null`
 * when there is none. A live lease is never taken, however long its work runs.
 */
export async function claimSemanticEditExecution(
  store: StateStore,
  options: { readonly owner: string; readonly leaseMs: number; readonly now?: Date; readonly intentId?: string },
): Promise<ClaimedSemanticEditExecution | null> {
  const now = options.now ?? new Date();
  const token = randomUUID();
  const claimed = await store.semanticEditIntents.findOneAndUpdate(
    { ...runnable(now), ...(options.intentId !== undefined ? { _id: options.intentId } : {}) },
    { $set: { execution: { token, owner: options.owner, claimedAt: now, heartbeatAt: now, expiresAt: new Date(now.getTime() + options.leaseMs) } } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!claimed?.execution) return null;
  return { intentId: claimed._id, projectId: claimed.projectId, jobId: claimed.jobId, status: claimed.status, token, expiresAt: claimed.execution.expiresAt };
}

/** Renew a live lease, by its exact token. `false` when it is no longer this execution's — expired or replaced. */
export async function heartbeatSemanticEditExecution(
  store: StateStore,
  lease: { readonly intentId: string; readonly token: string },
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await store.semanticEditIntents.updateOne(
    { _id: lease.intentId, 'execution.token': lease.token, 'execution.expiresAt': { $gt: now } },
    { $set: { 'execution.heartbeatAt': now, 'execution.expiresAt': new Date(now.getTime() + leaseMs) } },
  );
  return result.matchedCount === 1;
}

/** Hand the lease back, by its exact token, so another worker need not wait for it to expire. Nothing else changes. */
export async function releaseSemanticEditExecution(store: StateStore, lease: { readonly intentId: string; readonly token: string }): Promise<boolean> {
  const result = await store.semanticEditIntents.updateOne({ _id: lease.intentId, 'execution.token': lease.token }, { $unset: { execution: '' } });
  return result.matchedCount === 1;
}

/** Record that this edit will not be continued automatically again, by the lease that decided it. The draft's claim is untouched. */
export async function recordSemanticEditDisposition(
  store: StateStore,
  lease: { readonly intentId: string; readonly token: string },
  reason: SemanticEditFailureReason,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await store.semanticEditIntents.updateOne(
    { _id: lease.intentId, 'execution.token': lease.token, status: { $ne: 'completed' }, disposition: { $exists: false } },
    { $set: { disposition: { kind: 'failed', reason, at: now } }, $unset: { execution: '' } },
  );
  return result.matchedCount === 1;
}

/**
 * Count one unexpected continuation failure against the edit, by the lease that
 * saw it, and release the lease — or, at the bound, record `failureReason`.
 * Returns the count, or `null` when the lease was no longer this execution's.
 */
export async function recordSemanticEditExecutionFailure(
  store: StateStore,
  lease: { readonly intentId: string; readonly token: string },
  bound: { readonly maxFailures: number; readonly failureReason: SemanticEditFailureReason },
  now: Date = new Date(),
): Promise<number | null> {
  const counted = await store.semanticEditIntents.findOneAndUpdate(
    { _id: lease.intentId, 'execution.token': lease.token, status: { $ne: 'completed' }, disposition: { $exists: false } },
    { $inc: { executionFailures: 1 } },
    { returnDocument: 'after' },
  );
  if (!counted) return null;
  const failures = counted.executionFailures ?? 1;
  if (failures >= bound.maxFailures) await recordSemanticEditDisposition(store, lease, bound.failureReason, now);
  else await releaseSemanticEditExecution(store, lease);
  return failures;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Where an edit stands, in terms a customer route can show directly:
 *
 * - `queued` — submitted, waiting for a worker;
 * - `running` — a worker holds a live lease and is building it;
 * - `finishing` — the new build is promoted; it is being evaluated and concluded;
 * - `completed` — the new draft exists;
 * - `failed` — it will not continue automatically; the current draft is unchanged.
 */
export type SemanticEditExecutionState = 'queued' | 'running' | 'finishing' | 'completed' | 'failed';

/** A failure a customer may be told about. Nothing internal. */
export type SemanticEditPublicFailure = 'validation_failed' | 'build_failed' | 'temporarily_unavailable' | 'needs_attention';

export interface SemanticEditExecutionStatus {
  readonly intentId: string;
  readonly state: SemanticEditExecutionState;
  readonly sourceDraftId: string;
  readonly baseEditableSiteModel: ArtifactRef;
  readonly editableSiteModel: ArtifactRef;
  /** Present exactly when `completed`. */
  readonly resultDraftId: string | null;
  /** Present exactly when `failed`. */
  readonly failure: SemanticEditPublicFailure | null;
}

const PUBLIC_FAILURE: Readonly<Record<SemanticEditFailureReason, SemanticEditPublicFailure>> = Object.freeze({
  validation_failed: 'validation_failed',
  build_failed: 'build_failed',
  evaluation_unavailable: 'temporarily_unavailable',
  execution_failed: 'temporarily_unavailable',
  authority_corrupt: 'needs_attention',
});

/**
 * One edit's status, by exact project and intent id — bounded and safe to show:
 * no lease token, job token, provider message or internal document. `null` when
 * the project has no such edit.
 */
export async function readSemanticEditExecutionStatus(
  store: StateStore,
  projectId: string,
  intentId: string,
  now: Date = new Date(),
): Promise<SemanticEditExecutionStatus | null> {
  const intent = await store.semanticEditIntents.findOne({ _id: intentId, projectId });
  if (!intent) return null;
  const state: SemanticEditExecutionState =
    intent.status === 'completed'
      ? 'completed'
      : intent.disposition
        ? 'failed'
        : intent.status !== 'building'
          ? 'finishing'
          : intent.execution && intent.execution.expiresAt.getTime() > now.getTime()
            ? 'running'
            : 'queued';
  return {
    intentId: intent._id,
    state,
    sourceDraftId: intent.sourceDraftId,
    baseEditableSiteModel: intent.baseEditableSiteModel,
    editableSiteModel: intent.editableSiteModel,
    resultDraftId: state === 'completed' ? (intent.resultDraftId ?? null) : null,
    failure: state === 'failed' && intent.disposition ? PUBLIC_FAILURE[intent.disposition.reason] : null,
  };
}
