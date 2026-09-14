/**
 * Customer self-service initial draft generation against real durable state:
 * durable, idempotent request creation, the small concurrent-generation
 * bound, and the execution lease's claim/heartbeat/release/complete/
 * disposition lifecycle, fenced on its token exactly like a semantic edit's.
 *
 * Integration: needs the Mongo replica set. `resumeInitialDraftGeneration`'s
 * full happy path (a real `runProject` call) is exercised in
 * `packages/customer-editor/test/creation.integration.test.ts`, which already
 * has the rig that fakes the model/compiler/gates layer; its "already
 * concluded" fast path — the one this module adds on top of `runProject`'s own
 * resumability, for the crash window between a run concluding and this module
 * recording it — is proven there against a real concluded draft.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BusinessProfile } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import {
  claimInitialDraftGeneration,
  completeInitialDraftGeneration,
  createInitialDraftRequest,
  heartbeatInitialDraftGeneration,
  InitialDraftRequestRefused,
  MAX_ACTIVE_INITIAL_DRAFTS_PER_ACCOUNT,
  recordInitialDraftDisposition,
  recordInitialDraftExecutionFailure,
  releaseInitialDraftGeneration,
  updateInitialDraftProgress,
} from '../src/index.js';
import { createCustomerAccount } from '../../customer-auth/src/index.js';

let store: StateStore;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
});
afterAll(async () => {
  await store?.close();
});
beforeEach(async () => {
  for (const c of [store.initialDraftRequests, store.projectAccountBindings, store.customerAccounts]) await (c as { deleteMany(f: object): Promise<unknown> }).deleteMany({});
});

function intake(businessName: string): BusinessProfile {
  return {
    businessName,
    industry: 'joinery',
    location: 'Leeds, UK',
    audience: 'homeowners',
    services: [{ name: 'Custom cabinetry', description: 'Bespoke kitchen and built-in cabinetry.' }],
    differentiators: ['20 years of experience'],
    contact: { email: 'hello@example.com', phone: '01133456789' },
    tone: 'warm and professional',
    goals: ['generate qualified leads'],
  };
}

async function account(name: string) {
  return createCustomerAccount(store, { displayName: name });
}

describe('createInitialDraftRequest: durable, idempotent creation', () => {
  it('mints a fresh project, binds it to the account, and records one queued request', async () => {
    const acct = await account('Acme');
    const created = await createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake('Acme Joinery'), boundBy: 'test' });
    expect(created.status).toBe('queued');
    expect(created.projectId).toMatch(/^proj_acme_joinery_[a-z0-9]{6}$/);

    const request = await store.initialDraftRequests.findOne({ _id: created.requestId });
    expect(request).toMatchObject({ accountId: acct._id, projectId: created.projectId, status: 'queued', progress: 'queued' });
    const binding = await store.projectAccountBindings.findOne({ _id: created.projectId });
    expect(binding).toMatchObject({ accountId: acct._id, boundBy: 'test' });
  });

  it('an exact replay — same account, same customer, same intake — resolves to the same request and the same project, never a second one', async () => {
    const acct = await account('Acme');
    const first = await createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake('Acme Joinery'), boundBy: 'test' });
    const second = await createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake('Acme Joinery'), boundBy: 'test' });
    expect(second).toEqual(first);
    expect(await store.initialDraftRequests.countDocuments({ accountId: acct._id })).toBe(1);
    expect(await store.projectAccountBindings.countDocuments({ accountId: acct._id })).toBe(1);
  });

  it('a different intake is a different, independent request and project — never a conflict', async () => {
    const acct = await account('Acme');
    const a = await createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake('Acme Joinery'), boundBy: 'test' });
    const b = await createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake('Acme Cabinets'), boundBy: 'test' });
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.projectId).not.toBe(b.projectId);
  });

  it('the same customer requesting under a different account also mints an independent request, never colliding with the other account’s', async () => {
    const acmeAcct = await account('Acme');
    const otherAcct = await account('Bravo');
    const a = await createInitialDraftRequest(store, { accountId: acmeAcct._id, customerUserId: 'cu_1', intake: intake('Same Name'), boundBy: 'test' });
    const b = await createInitialDraftRequest(store, { accountId: otherAcct._id, customerUserId: 'cu_1', intake: intake('Same Name'), boundBy: 'test' });
    expect(a.requestId).not.toBe(b.requestId);
  });

  it('bounds active generations per account, and a replay of an already-counted request never itself trips the bound', async () => {
    const acct = await account('Acme');
    for (let i = 0; i < MAX_ACTIVE_INITIAL_DRAFTS_PER_ACCOUNT; i += 1) {
      await createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake(`Business ${i}`), boundBy: 'test' });
    }
    await expect(createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake('One Too Many'), boundBy: 'test' })).rejects.toBeInstanceOf(InitialDraftRequestRefused);
    // A replay of one of the two already-counted requests is not itself a new active generation.
    const replay = await createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake('Business 0'), boundBy: 'test' });
    expect(replay.status).toBe('queued');
  });
});

describe('execution lease: claim, heartbeat, release, complete, disposition — fenced on the token', () => {
  async function queued(businessName = 'Acme Joinery') {
    const acct = await account('Acme');
    return createInitialDraftRequest(store, { accountId: acct._id, customerUserId: 'cu_1', intake: intake(businessName), boundBy: 'test' });
  }

  it('claims the oldest runnable request, sets it active, and never claims a live lease twice', async () => {
    const a = await queued('Acme A');
    await new Promise((r) => setTimeout(r, 5));
    await queued('Acme B');

    const lease = await claimInitialDraftGeneration(store, { owner: 'w1', leaseMs: 60_000 });
    expect(lease?.requestId).toBe(a.requestId);
    expect((await store.initialDraftRequests.findOne({ _id: a.requestId }))?.status).toBe('active');

    // The same request cannot be claimed again while the lease is live.
    const second = await claimInitialDraftGeneration(store, { owner: 'w2', leaseMs: 60_000, requestId: a.requestId });
    expect(second).toBeNull();
  });

  it('a live lease renews with the correct token; a stale or wrong token is refused', async () => {
    const a = await queued();
    const lease = (await claimInitialDraftGeneration(store, { owner: 'w1', leaseMs: 1_000 }))!;
    expect(await heartbeatInitialDraftGeneration(store, lease, 60_000)).toBe(true);
    expect(await heartbeatInitialDraftGeneration(store, { requestId: a.requestId, token: 'wrong-token' }, 60_000)).toBe(false);
  });

  it('progress updates are fenced on the token: a stale worker’s write never lands', async () => {
    const a = await queued();
    const lease = (await claimInitialDraftGeneration(store, { owner: 'w1', leaseMs: 60_000 }))!;
    await updateInitialDraftProgress(store, lease, 'building');
    expect((await store.initialDraftRequests.findOne({ _id: a.requestId }))?.progress).toBe('building');
    await updateInitialDraftProgress(store, { requestId: a.requestId, token: 'stale' }, 'validating');
    expect((await store.initialDraftRequests.findOne({ _id: a.requestId }))?.progress).toBe('building');
  });

  it('release hands the lease back to queued; complete is fenced and records the exact result draft', async () => {
    const a = await queued();
    const lease = (await claimInitialDraftGeneration(store, { owner: 'w1', leaseMs: 60_000 }))!;
    expect(await releaseInitialDraftGeneration(store, lease)).toBe(true);
    const released = await store.initialDraftRequests.findOne({ _id: a.requestId });
    expect(released).toMatchObject({ status: 'queued' });
    expect(released?.execution).toBeUndefined();

    const release2 = (await claimInitialDraftGeneration(store, { owner: 'w2', leaseMs: 60_000 }))!;
    expect(await completeInitialDraftGeneration(store, { requestId: a.requestId, token: 'stale' }, 'draft_xyz')).toBe(false);
    expect(await completeInitialDraftGeneration(store, release2, 'draft_xyz')).toBe(true);
    const completed = await store.initialDraftRequests.findOne({ _id: a.requestId });
    expect(completed).toMatchObject({ status: 'completed', resultDraftId: 'draft_xyz', progress: 'finishing' });
    expect(completed?.execution).toBeUndefined();
    // Completed is terminal: a further complete or disposition under the same fenced conditions changes nothing.
    expect(await recordInitialDraftDisposition(store, release2, 'generation_failed')).toBe(false);
  });

  it('disposition records a terminal failure, fenced; execution failures count toward the bound and then disposition', async () => {
    const a = await queued();
    const lease = (await claimInitialDraftGeneration(store, { owner: 'w1', leaseMs: 60_000 }))!;
    expect(await recordInitialDraftDisposition(store, lease, 'invalid_request')).toBe(true);
    const failed = await store.initialDraftRequests.findOne({ _id: a.requestId });
    expect(failed).toMatchObject({ status: 'failed', disposition: { kind: 'failed', reason: 'invalid_request' } });

    const b = await queued('Acme B');
    const leaseB = (await claimInitialDraftGeneration(store, { owner: 'w1', leaseMs: 60_000 }))!;
    expect(await recordInitialDraftExecutionFailure(store, leaseB, { maxFailures: 2 })).toBe(1);
    expect((await store.initialDraftRequests.findOne({ _id: b.requestId }))?.status).toBe('queued');
    const leaseB2 = (await claimInitialDraftGeneration(store, { owner: 'w1', leaseMs: 60_000 }))!;
    expect(await recordInitialDraftExecutionFailure(store, leaseB2, { maxFailures: 2 })).toBe(2);
    expect(await store.initialDraftRequests.findOne({ _id: b.requestId })).toMatchObject({ status: 'failed', disposition: { reason: 'temporarily_unavailable' } });
  });

  it('an expired lease is claimable again by another worker', async () => {
    const a = await queued();
    await claimInitialDraftGeneration(store, { owner: 'w1', leaseMs: 1, now: new Date(Date.now() - 10_000) });
    const reclaimed = await claimInitialDraftGeneration(store, { owner: 'w2', leaseMs: 60_000 });
    expect(reclaimed?.requestId).toBe(a.requestId);
    expect(reclaimed?.token).toBeDefined();
  });
});
