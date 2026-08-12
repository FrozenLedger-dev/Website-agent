/**
 * Integration tests against a real Mongo replica set.
 *
 * These deliberately do not mock the driver: the properties under test are
 * transaction semantics, and a mock would assert only that the code calls the
 * functions it calls, not that the database enforces anything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetExhausted,
  DEFAULT_BUDGET_LIMITS,
  StateStore,
  createBudget,
  defectBudgetId,
  remaining,
  spend,
  spendRepairAttempt,
} from '../src/index.js';

const PROJECT = 'proj_budget_test';

let store: StateStore;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
});

afterAll(async () => {
  await store?.close();
});

beforeEach(async () => {
  await store.budgets.deleteMany({});
  await store.defectBudgets.deleteMany({});
  await store.jobs.deleteMany({});
  await createBudget(store, PROJECT);
});

describe('project budgets', () => {
  it('seeds the documented §7 defaults', async () => {
    const left = await remaining(store, PROJECT);
    expect(left).toEqual({
      reviewRejections: 3,
      totalRepairJobs: 8,
      fullRebuilds: 1,
      replans: 2,
      failedDeployments: 2,
    });
  });

  it('permits exactly the configured number of spends, then refuses', async () => {
    await spend(store, PROJECT, 'replans');
    await spend(store, PROJECT, 'replans');
    await expect(spend(store, PROJECT, 'replans')).rejects.toBeInstanceOf(BudgetExhausted);

    const left = await remaining(store, PROJECT);
    expect(left?.replans).toBe(0);
  });

  it('allows only one controlled full rebuild', async () => {
    await spend(store, PROJECT, 'fullRebuilds');
    await expect(spend(store, PROJECT, 'fullRebuilds')).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it('does not let one budget draw down another', async () => {
    for (let i = 0; i < DEFAULT_BUDGET_LIMITS.reviewRejections; i++) {
      await spend(store, PROJECT, 'reviewRejections');
    }
    await expect(spend(store, PROJECT, 'reviewRejections')).rejects.toBeInstanceOf(BudgetExhausted);
    await expect(spend(store, PROJECT, 'replans')).resolves.toBeUndefined();
  });
});

describe('repair budgets', () => {
  const FP = 'a1b2c3d4e5f60718';

  it('caps repairs for one defect at the per-defect limit', async () => {
    await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 0, s));
    await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 1, s));

    await expect(
      store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 2, s)),
    ).rejects.toBeInstanceOf(BudgetExhausted);

    const doc = await store.defectBudgets.findOne({ _id: defectBudgetId(PROJECT, FP) });
    expect(doc?.repairsUsed).toBe(2);
  });

  it('rolls the release-cycle total back when the per-defect cap trips', async () => {
    // The property that matters: a refused repair must not silently consume one
    // of the 8 release-cycle repair jobs.
    await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 0, s));
    await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 1, s));
    expect((await remaining(store, PROJECT))?.totalRepairJobs).toBe(6);

    await expect(
      store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 2, s)),
    ).rejects.toBeInstanceOf(BudgetExhausted);

    expect((await remaining(store, PROJECT))?.totalRepairJobs).toBe(6);
  });

  it('tracks distinct defects independently', async () => {
    const other = 'ffffffffffffffff';
    await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 0, s));
    await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 1, s));

    await expect(
      store.withTransaction((s) => spendRepairAttempt(store, PROJECT, other, 2, s)),
    ).resolves.toBeUndefined();
  });

  it('exhausts the release-cycle total across many distinct defects', async () => {
    for (let i = 0; i < DEFAULT_BUDGET_LIMITS.totalRepairJobs; i++) {
      const fp = `defect${String(i).padStart(10, '0')}`;
      await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, fp, 0, s));
    }
    await expect(
      store.withTransaction((s) => spendRepairAttempt(store, PROJECT, 'defect_overflow', 0, s)),
    ).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it('rolls back a job claim made in the same transaction as a refused spend', async () => {
    // This is the core invariant: work and the budget that authorises it commit
    // or fail together. A crash-free abort must leave no claimed job behind.
    await store.jobs.insertOne({
      _id: 'job_repair_probe',
      projectId: PROJECT,
      state: 'ready',
    } as never);

    await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 0, s));
    await store.withTransaction((s) => spendRepairAttempt(store, PROJECT, FP, 1, s));

    await expect(
      store.withTransaction(async (s) => {
        await store.jobs.updateOne({ _id: 'job_repair_probe' }, { $set: { state: 'running' } }, { session: s });
        await spendRepairAttempt(store, PROJECT, FP, 2, s);
      }),
    ).rejects.toBeInstanceOf(BudgetExhausted);

    const job = await store.jobs.findOne({ _id: 'job_repair_probe' });
    expect(job?.state).toBe('ready');
  });
});
