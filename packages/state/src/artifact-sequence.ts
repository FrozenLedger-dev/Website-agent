/**
 * Allocating a project's next artifact lineage number.
 *
 * One atomic `$inc`, never read-then-write. The read-then-write version looks
 * equivalent and is not: two writers reading `7` both write `8`, and two
 * artifacts then claim the same position in the project's history. That is the
 * exact failure this replaces — `createdAt` at millisecond resolution could
 * not distinguish two writes in the same millisecond either.
 *
 * Gaps are fine and are not worth preventing. A number is allocated before the
 * artifact is inserted, so a writer that allocates 14 and then fails leaves
 * 13, 15, 16 — a valid ordering with a hole in it. The sequence is an ordering
 * token, not an accounting balance, and compensating logic to reclaim 14 would
 * add a second failure mode to remove a cosmetic one.
 */
import type { ClientSession } from 'mongodb';
import type { StateStore } from './store.js';

/**
 * Reserve and return the next lineage number for a project.
 *
 * The first allocation for a project returns 1. Projects are independent.
 *
 * When a session is supplied the allocation joins that transaction, so a
 * caller whose transaction aborts loses the allocation along with everything
 * else it did — which is the behaviour a caller passing a session expects.
 */
export async function allocateArtifactLineageSeq(
  store: StateStore,
  projectId: string,
  session?: ClientSession,
): Promise<number> {
  const updated = await store.artifactSequences.findOneAndUpdate(
    { _id: projectId },
    { $inc: { lastAllocated: 1 }, $set: { updatedAt: new Date() } },
    {
      upsert: true,
      returnDocument: 'after',
      ...(session ? { session } : {}),
    },
  );

  if (!updated) {
    // `returnDocument: 'after'` with `upsert` always returns a document; a null
    // here would mean the driver contract changed underneath us, and silently
    // continuing would hand out an undefined position in the history.
    throw new Error(`Could not allocate an artifact lineage number for ${projectId}.`);
  }
  return updated.lastAllocated;
}
