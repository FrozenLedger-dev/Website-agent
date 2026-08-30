/**
 * The order a project's artifacts were recorded in.
 *
 * `version` is monotonic within one artifact *name*, so it cannot say whether
 * the site plan was written before or after the route decision that followed
 * it. That question used to be answered by sorting on `createdAt`, which is
 * millisecond-resolution observation: two writes in the same millisecond are
 * indistinguishable by it, and the only reason it held was that the awaits
 * between artifact writes happened to be slow enough. Phase 5 introduces real
 * concurrency, so it needed replacing before then rather than after.
 *
 * These need the real replica set: the property being tested is that Mongo
 * allocates atomically under contention, and a fake store would prove only that
 * the code calls the function it calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StateStore, allocateArtifactLineageSeq, artifactId } from '@statxai/state';
import { ArtifactRegistry, contentHash } from '../src/registry.js';

let store: StateStore;
let registry: ArtifactRegistry;

const PROJECT = 'proj_lineage';

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
});

afterAll(async () => {
  await store?.close();
});

/** Both halves: a project's artifacts and the counter that ordered them. */
const wipe = async (...projectIds: string[]) => {
  for (const projectId of projectIds) {
    await store.artifacts.deleteMany({ projectId });
    await store.artifactSequences.deleteOne({ _id: projectId });
  }
};

afterEach(async () => {
  vi.useRealTimers();
  await wipe(PROJECT, `${PROJECT}_a`, `${PROJECT}_b`, `${PROJECT}_legacy`, `${PROJECT}_concurrent`);
});

const seqs = async (projectId: string) =>
  (await registry.listLineage(projectId)).map((a) => a.lineageSeq);

describe('a lineage number per artifact', () => {
  it('starts at one and advances with each artifact', async () => {
    await registry.put(PROJECT, 'business-profile', { a: 1 });
    await registry.put(PROJECT, 'site-plan', { b: 2 });
    await registry.put(PROJECT, 'route-decision', { c: 3 });

    expect(await seqs(PROJECT)).toEqual([1, 2, 3]);
  });

  it('counts the project, not the artifact name', async () => {
    // The clearest statement that the two numbers are different things: the
    // plan reaches version 2 while the project reaches lineage 3.
    await registry.put(PROJECT, 'site-plan', { v: 1 });
    await registry.put(PROJECT, 'route-decision', { r: 1 });
    await registry.put(PROJECT, 'site-plan', { v: 2 });

    const lineage = await registry.listLineage(PROJECT);

    expect(lineage.map((a) => `${a.name}@${a.version}`)).toEqual([
      'site-plan@1',
      'route-decision@1',
      'site-plan@2',
    ]);
    expect(lineage.map((a) => a.lineageSeq)).toEqual([1, 2, 3]);
  });

  it('gives each project its own count', async () => {
    await registry.put(`${PROJECT}_a`, 'site-plan', { a: 1 });
    await registry.put(`${PROJECT}_a`, 'route-decision', { a: 2 });
    await registry.put(`${PROJECT}_b`, 'site-plan', { b: 1 });

    expect(await seqs(`${PROJECT}_a`)).toEqual([1, 2]);
    expect(await seqs(`${PROJECT}_b`)).toEqual([1]);
  });
});

describe('when the clock cannot tell two artifacts apart', () => {
  it('still knows which came first', async () => {
    /**
     * The regression this phase exists for. Four artifacts written at one
     * frozen instant: every `createdAt` is identical, so any implementation
     * that sorts on it is choosing arbitrarily. The lineage numbers are not.
     */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));

    await registry.put(PROJECT, 'business-profile', { a: 1 });
    await registry.put(PROJECT, 'site-plan', { b: 2 });
    await registry.put(PROJECT, 'route-decision', { c: 3 });
    await registry.put(PROJECT, 'test-report', { d: 4 });

    const lineage = await registry.listLineage(PROJECT);
    const stamps = new Set(lineage.map((a) => a.createdAt.getTime()));

    // The premise: the timestamps really are indistinguishable.
    expect(stamps.size).toBe(1);

    expect(lineage.map((a) => a.name)).toEqual([
      'business-profile',
      'site-plan',
      'route-decision',
      'test-report',
    ]);
    expect(lineage.map((a) => a.lineageSeq)).toEqual([1, 2, 3, 4]);
  });
});

describe('when writers race', () => {
  it('gives every artifact a distinct place in the history', async () => {
    /**
     * Twenty different names, so the existing per-name version race is not what
     * is under test — this is about the project-wide counter surviving
     * contention. What is asserted is that a total order exists, not that it
     * matches the order the promises were created in: concurrent scheduling
     * never promised that, and requiring it would be testing the event loop.
     */
    const project = `${PROJECT}_concurrent`;
    const names = Array.from({ length: 20 }, (_, i) => `artifact-${String(i).padStart(2, '0')}`);

    await Promise.all(names.map((name) => registry.put(project, name, { name })));

    const lineage = await registry.listLineage(project);
    const allocated = lineage.map((a) => a.lineageSeq);

    expect(lineage).toHaveLength(20);
    expect(allocated.every((s) => typeof s === 'number')).toBe(true);
    expect(new Set(allocated).size).toBe(20);

    // Strictly increasing, which is what "a total order" means here.
    for (let i = 1; i < allocated.length; i += 1) {
      expect(allocated[i]!).toBeGreaterThan(allocated[i - 1]!);
    }
  });

  it('never hands the same number to two allocations', async () => {
    const project = `${PROJECT}_concurrent`;
    const allocated = await Promise.all(
      Array.from({ length: 50 }, () => allocateArtifactLineageSeq(store, project)),
    );

    expect(new Set(allocated).size).toBe(50);
    expect([...allocated].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });
});

describe('artifacts written before lineage numbers existed', () => {
  const legacy = async (name: string, version: number, createdAt: string) => {
    await store.artifacts.insertOne({
      _id: artifactId(`${PROJECT}_legacy`, name, version),
      projectId: `${PROJECT}_legacy`,
      name,
      version,
      contentHash: 'x',
      data: {},
      acceptedAt: null,
      createdAt: new Date(createdAt),
    });
  };

  it('sort first, and deterministically among themselves', async () => {
    await legacy('route-decision', 1, '2026-08-01T00:00:02.000Z');
    // Identical timestamps: the true order was never recorded, so `_id` breaks
    // the tie to make presentation stable rather than to claim a history.
    await legacy('site-plan', 1, '2026-08-01T00:00:01.000Z');
    await legacy('business-profile', 1, '2026-08-01T00:00:01.000Z');

    await registry.put(`${PROJECT}_legacy`, 'approval-recommendation', { a: 1 });

    const lineage = await registry.listLineage(`${PROJECT}_legacy`);

    expect(lineage.map((a) => a.name)).toEqual([
      'business-profile',
      'site-plan',
      'route-decision',
      'approval-recommendation',
    ]);
    expect(lineage.slice(0, 3).every((a) => a.lineageSeq === undefined)).toBe(true);
    expect(lineage[3]?.lineageSeq).toBe(1);
  });

  it('still enforce uniqueness on the artifacts that do have a number', async () => {
    await legacy('site-plan', 1, '2026-08-01T00:00:00.000Z');
    const ref = await registry.put(`${PROJECT}_legacy`, 'route-decision', { a: 1 });
    const doc = await store.artifacts.findOne({
      _id: artifactId(`${PROJECT}_legacy`, ref.name, ref.version),
    });

    await expect(
      store.artifacts.insertOne({
        ...doc!,
        _id: artifactId(`${PROJECT}_legacy`, 'forced-duplicate', 1),
        name: 'forced-duplicate',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});

describe('what lineage numbering does not touch', () => {
  it('leaves the pinned reference exactly as it was', async () => {
    // A reference identifies an artifact. Where that artifact sits in the
    // project's history is platform metadata, and a worker pinning an input
    // has no business depending on it.
    const ref = await registry.put(PROJECT, 'site-plan', { a: 1 });
    expect(Object.keys(ref).sort()).toEqual(['contentHash', 'name', 'version']);
  });

  it('leaves the content hash alone', async () => {
    // The same data hashes the same before and after, because neither the
    // lineage number nor either timestamp is hashed.
    const data = { strategy: 'local trade', pages: [{ route: '/' }] };
    const ref = await registry.put(PROJECT, 'site-plan', data);

    expect(ref.contentHash).toBe(contentHash(data));

    const doc = await store.artifacts.findOne({ _id: artifactId(PROJECT, 'site-plan', 1) });
    expect(doc?.contentHash).toBe(contentHash(data));
    expect(doc?.data).toEqual(data);
    expect((doc?.data as Record<string, unknown>)['lineageSeq']).toBeUndefined();
  });

  it('does not advance when a version is accepted', async () => {
    // Creating an artifact is one event in the history. Accepting the version
    // that already exists is not a second one.
    const ref = await registry.put(PROJECT, 'site-plan', { a: 1 });
    await registry.accept(PROJECT, ref);
    await registry.accept(PROJECT, ref);

    const doc = await store.artifacts.findOne({ _id: artifactId(PROJECT, 'site-plan', 1) });
    expect(doc?.lineageSeq).toBe(1);
    expect(doc?.acceptedAt).not.toBeNull();

    const counter = await store.artifactSequences.findOne({ _id: PROJECT });
    expect(counter?.lastAllocated).toBe(1);
  });

  it('keeps counting where the last run left off', async () => {
    // A run deletes and recreates the project record at startup. If the counter
    // lived there, a second run's artifacts would claim to precede the first
    // run's — so it lives in its own collection, and this is what says so.
    await registry.put(PROJECT, 'site-plan', { a: 1 });
    await store.projects.deleteOne({ _id: PROJECT });
    await store.budgets.deleteOne({ _id: PROJECT });
    await store.defectBudgets.deleteMany({ projectId: PROJECT });

    await registry.put(PROJECT, 'route-decision', { b: 2 });

    expect(await seqs(PROJECT)).toEqual([1, 2]);
  });
});

describe('deploying the lineage index onto a database that predates it', () => {
  /**
   * The migration, in the order it actually happens in production: a database
   * full of artifacts that have no lineage number, and then the index arrives.
   *
   * This started out as a test that inserted legacy documents and called
   * `ensureIndexes()` — but the shared suite already indexes in `beforeAll`, so
   * the index existed before the legacy rows did. That proves an existing
   * partial index tolerates missing values, which is not the question. The
   * question is whether the index can be *built* over rows that are already
   * there, and a plain unique index cannot: it reads every missing `lineageSeq`
   * as the same duplicate `null` and refuses.
   *
   * So this uses its own database, and deliberately does not index it until the
   * legacy rows are in place.
   */
  const MIGRATION_DB = 'statxai_test_lineage_migration';
  const PROJECT_ID = 'proj_migration';
  const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0';

  let migrated: StateStore;

  const legacyRow = (name: string, version: number) => ({
    _id: artifactId(PROJECT_ID, name, version),
    projectId: PROJECT_ID,
    name,
    version,
    contentHash: 'legacy',
    data: { written: 'before lineage numbers existed' },
    acceptedAt: null,
    // Same instant for all three, which is the case that made timestamps
    // unusable as an ordering authority in the first place.
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  beforeAll(async () => {
    migrated = await StateStore.connect({ uri: URI, dbName: MIGRATION_DB });
    // A previous run of this file must not be what makes it pass.
    await migrated.db.dropDatabase();

    // Legacy rows first. `ensureIndexes` has deliberately not been called.
    await migrated.artifacts.insertMany([
      legacyRow('site-plan', 1),
      legacyRow('route-decision', 1),
      legacyRow('test-report', 1),
    ]);
  });

  afterAll(async () => {
    await migrated?.db.dropDatabase();
    await migrated?.close();
  });

  const lineageIndex = async () => {
    const indexes = await migrated.artifacts.indexes();
    return indexes.find(
      (i) => (i.key as Record<string, number>)['projectId'] === 1 && 'lineageSeq' in i.key,
    );
  };

  it('has no lineage index to begin with, which is the whole point', async () => {
    // If this ever passes trivially the test below proves nothing, so the
    // premise is asserted rather than assumed.
    expect(await lineageIndex()).toBeUndefined();
    expect(await migrated.artifacts.countDocuments({ projectId: PROJECT_ID })).toBe(3);
  });

  it('builds the index over the rows that were already there', async () => {
    await expect(migrated.ensureIndexes()).resolves.toBeUndefined();

    const index = await lineageIndex();
    expect(index).toBeDefined();
    expect(index?.key).toEqual({ projectId: 1, lineageSeq: 1 });
    expect(index?.unique).toBe(true);
    // The filter is what lets three missing values coexist. Asserted by its
    // shape rather than its generated name, which is incidental.
    expect(index?.partialFilterExpression).toEqual({ lineageSeq: { $exists: true } });
  });

  it('leaves the legacy rows exactly as they were', async () => {
    // Creating an index is not a migration of the data. Nothing is backfilled,
    // because a backfilled number would be an invention presented as history.
    const rows = await migrated.artifacts.find({ projectId: PROJECT_ID }).toArray();

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.lineageSeq === undefined)).toBe(true);
    expect(rows.every((r) => r.contentHash === 'legacy')).toBe(true);
    expect(rows.every((r) => r.createdAt.toISOString() === '2026-08-01T00:00:00.000Z')).toBe(true);
  });

  it('numbers everything written from here on', async () => {
    const registryAfter = new ArtifactRegistry(migrated);
    const ref = await registryAfter.put(PROJECT_ID, 'approval-recommendation', { a: 1 });

    const doc = await migrated.artifacts.findOne({
      _id: artifactId(PROJECT_ID, ref.name, ref.version),
    });
    expect(doc?.lineageSeq).toBe(1);

    // And the compatibility ordering still holds: the three unnumbered rows
    // first, then the one that has a number.
    const lineage = await registryAfter.listLineage(PROJECT_ID);
    expect(lineage.map((a) => a.lineageSeq)).toEqual([undefined, undefined, undefined, 1]);
    expect(lineage.at(-1)?.name).toBe('approval-recommendation');
  });

  it('still refuses two artifacts claiming the same position', async () => {
    // The migration must not have bought compatibility by weakening the
    // constraint: many missing values are fine, two equal ones are not.
    const taken = await migrated.artifacts.findOne({ projectId: PROJECT_ID, lineageSeq: 1 });
    expect(taken).not.toBeNull();

    await expect(
      migrated.artifacts.insertOne({
        ...taken!,
        _id: artifactId(PROJECT_ID, 'forced-duplicate', 1),
        name: 'forced-duplicate',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});
