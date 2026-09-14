/**
 * Initial draft generation execution: which worker is continuing a customer's
 * requested D0 right now, and where it stands — for the worker and for a
 * customer-safe status route.
 *
 * The same split as a semantic edit's execution lease (`../semantic-edit/execution.js`):
 *
 * - The request's authority is the durable `initial_draft_requests` document
 *   itself, and `runProject`'s own idempotent resume machinery underneath it.
 *   Nothing here decides what generation *is* — only who is allowed to drive it
 *   right now.
 * - A worker's execution lease is liveness only. It expires unless renewed;
 *   once expired, another worker may continue exactly the same request. Every
 *   write is a compare-and-set on the lease's opaque token, so a worker that
 *   lost its lease changes nothing.
 */
import { randomUUID } from 'node:crypto';
import type { InitialDraftFailureReason, InitialDraftProgressHint, InitialDraftRequestDocument, StateStore } from '@statxai/state';

export interface ClaimedInitialDraftGeneration {
  readonly requestId: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly status: InitialDraftRequestDocument['status'];
  readonly token: string;
  readonly expiresAt: Date;
}

const runnable = (now: Date) => ({
  status: { $in: ['queued', 'active'] as const },
  disposition: { $exists: false },
  $or: [{ execution: { $exists: false } }, { 'execution.expiresAt': { $lte: now } }],
});

/**
 * Atomically lease one runnable request — the oldest by creation, or exactly
 * `requestId` — whose execution is unowned or whose lease has expired. `null`
 * when there is none. A live lease is never taken, however long its work runs.
 */
export async function claimInitialDraftGeneration(
  store: StateStore,
  options: { readonly owner: string; readonly leaseMs: number; readonly now?: Date; readonly requestId?: string },
): Promise<ClaimedInitialDraftGeneration | null> {
  const now = options.now ?? new Date();
  const token = randomUUID();
  const claimed = await store.initialDraftRequests.findOneAndUpdate(
    { ...runnable(now), ...(options.requestId !== undefined ? { _id: options.requestId } : {}) },
    {
      $set: {
        status: 'active',
        execution: { token, owner: options.owner, claimedAt: now, heartbeatAt: now, expiresAt: new Date(now.getTime() + options.leaseMs) },
        updatedAt: now,
      },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!claimed?.execution) return null;
  return { requestId: claimed._id, accountId: claimed.accountId, projectId: claimed.projectId, status: claimed.status, token, expiresAt: claimed.execution.expiresAt };
}

/** Renew a live lease, by its exact token. `false` when it is no longer this execution's — expired or replaced. */
export async function heartbeatInitialDraftGeneration(
  store: StateStore,
  lease: { readonly requestId: string; readonly token: string },
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await store.initialDraftRequests.updateOne(
    { _id: lease.requestId, 'execution.token': lease.token, 'execution.expiresAt': { $gt: now } },
    { $set: { 'execution.heartbeatAt': now, 'execution.expiresAt': new Date(now.getTime() + leaseMs), updatedAt: now } },
  );
  return result.matchedCount === 1;
}

/**
 * Update the bounded, customer-facing progress hint, by the lease's exact
 * token. Never authority, never retried, never allowed to fail the caller: a
 * lost race for this write means a stale progress line, not a wrong one — the
 * next heartbeat or a fresher worker's own write supersedes it.
 */
export async function updateInitialDraftProgress(store: StateStore, lease: { readonly requestId: string; readonly token: string }, progress: InitialDraftProgressHint, now: Date = new Date()): Promise<void> {
  await store.initialDraftRequests.updateOne({ _id: lease.requestId, 'execution.token': lease.token }, { $set: { progress, updatedAt: now } });
}

/** Hand the lease back, by its exact token, so another worker need not wait for it to expire. Status returns to `queued`; nothing else changes. */
export async function releaseInitialDraftGeneration(store: StateStore, lease: { readonly requestId: string; readonly token: string }, now: Date = new Date()): Promise<boolean> {
  const result = await store.initialDraftRequests.updateOne({ _id: lease.requestId, 'execution.token': lease.token }, { $set: { status: 'queued', updatedAt: now }, $unset: { execution: '' } });
  return result.matchedCount === 1;
}

/** Record the request completed, by the lease's exact token. The draft it names is proven again by every reader — this write is not itself the proof. */
export async function completeInitialDraftGeneration(store: StateStore, lease: { readonly requestId: string; readonly token: string }, resultDraftId: string, now: Date = new Date()): Promise<boolean> {
  const result = await store.initialDraftRequests.updateOne(
    { _id: lease.requestId, 'execution.token': lease.token, status: { $ne: 'completed' }, disposition: { $exists: false } },
    { $set: { status: 'completed', progress: 'finishing', resultDraftId, updatedAt: now }, $unset: { execution: '' } },
  );
  return result.matchedCount === 1;
}

/** Record that this request will not be continued automatically again, by the lease that decided it. */
export async function recordInitialDraftDisposition(store: StateStore, lease: { readonly requestId: string; readonly token: string }, reason: InitialDraftFailureReason, now: Date = new Date()): Promise<boolean> {
  const result = await store.initialDraftRequests.updateOne(
    { _id: lease.requestId, 'execution.token': lease.token, status: { $ne: 'completed' }, disposition: { $exists: false } },
    { $set: { status: 'failed', disposition: { kind: 'failed', reason, at: now }, updatedAt: now }, $unset: { execution: '' } },
  );
  return result.matchedCount === 1;
}

/**
 * Count one unexpected continuation failure against the request, by the lease
 * that saw it, and release the lease — or, at the bound, record
 * `temporarily_unavailable`. Returns the count, or `null` when the lease was
 * no longer this execution's.
 */
export async function recordInitialDraftExecutionFailure(store: StateStore, lease: { readonly requestId: string; readonly token: string }, bound: { readonly maxFailures: number }, now: Date = new Date()): Promise<number | null> {
  const counted = await store.initialDraftRequests.findOneAndUpdate(
    { _id: lease.requestId, 'execution.token': lease.token, status: { $ne: 'completed' }, disposition: { $exists: false } },
    { $inc: { executionFailures: 1 }, $set: { updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!counted) return null;
  const failures = counted.executionFailures ?? 1;
  if (failures >= bound.maxFailures) await recordInitialDraftDisposition(store, lease, 'temporarily_unavailable', now);
  else await releaseInitialDraftGeneration(store, lease, now);
  return failures;
}
