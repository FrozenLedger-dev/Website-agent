/**
 * Artifact registry (v1.2 §4 + Appendix B).
 *
 * MongoDB is authoritative for artifacts; the per-project Git repository holds
 * a *materialisation* of them alongside the generated site source. That keeps
 * Appendix A's on-disk layout available to a worker without creating a second
 * master copy that can drift.
 *
 * Versions are immutable. `put` always allocates the next version rather than
 * overwriting, because Appendix B requires accepted artifacts to be immutable
 * inputs to downstream work — a job re-run must see exactly what it saw before.
 */
import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { ArtifactRef } from '@statxai/contracts';
import {
  allocateArtifactLineageSeq,
  artifactId,
  type ArtifactDocument,
  type StateStore,
} from '@statxai/state';

/** Stable hash of an artifact's content, independent of key order. */
export function contentHash(data: unknown): string {
  return createHash('sha256').update(canonicalJson(data)).digest('hex');
}

/** Deterministic JSON: object keys sorted, so hashing is order-independent. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}

export class ArtifactNotFound extends Error {
  constructor(projectId: string, name: string, version?: number) {
    super(`Artifact ${name}${version ? `@${version}` : ''} not found for ${projectId}`);
    this.name = 'ArtifactNotFound';
  }
}

export class ArtifactRegistry {
  constructor(private readonly store: StateStore) {}

  /**
   * Write a new immutable version and return a pinned reference to it.
   *
   * Two independent numbers are assigned here and they answer different
   * questions. `version` is the next version of *this name*, and identifies the
   * artifact. `lineageSeq` is the next position in the *project's* history, and
   * is what orders this artifact against every other one — the registry
   * allocates it, so no caller can choose or skip it, and no model can suggest
   * it. Neither appears in the returned reference or in the hashed content.
   */
  async put(
    projectId: string,
    name: string,
    data: unknown,
    session?: ClientSession,
  ): Promise<ArtifactRef> {
    const latest = await this.store.artifacts.findOne(
      { projectId, name },
      { sort: { version: -1 }, ...(session ? { session } : {}) },
    );
    const version = (latest?.version ?? 0) + 1;
    const hash = contentHash(data);
    const lineageSeq = await allocateArtifactLineageSeq(this.store, projectId, session);

    const doc: ArtifactDocument = {
      _id: artifactId(projectId, name, version),
      projectId,
      name,
      version,
      contentHash: hash,
      data,
      acceptedAt: null,
      lineageSeq,
      createdAt: new Date(),
    };

    // The unique (projectId, name, version) index is what makes this safe under
    // concurrency: two writers racing for the same version number collide here
    // instead of silently producing two different "version 3"s.
    await this.store.artifacts.insertOne(doc, session ? { session } : {});
    return { name, version, contentHash: hash };
  }

  async get<T = unknown>(projectId: string, name: string, version?: number): Promise<T> {
    const doc =
      version === undefined
        ? await this.store.artifacts.findOne({ projectId, name }, { sort: { version: -1 } })
        : await this.store.artifacts.findOne({ _id: artifactId(projectId, name, version) });
    if (!doc) throw new ArtifactNotFound(projectId, name, version);
    return doc.data as T;
  }

  async resolve<T = unknown>(projectId: string, ref: ArtifactRef): Promise<T> {
    return this.get<T>(projectId, ref.name, ref.version);
  }

  /** Mark a version accepted; only accepted versions are valid job inputs. */
  async accept(projectId: string, ref: ArtifactRef, session?: ClientSession): Promise<void> {
    await this.store.artifacts.updateOne(
      { _id: artifactId(projectId, ref.name, ref.version) },
      { $set: { acceptedAt: new Date() } },
      session ? { session } : {},
    );
  }

  /** Everything the project has, grouped by name. Not a history. */
  async list(projectId: string): Promise<ArtifactDocument[]> {
    return this.store.artifacts.find({ projectId }).sort({ name: 1, version: 1 }).toArray();
  }

  /**
   * Everything the project has, in the order it was recorded.
   *
   * A separate method from {@link list} rather than a change to it: `list`
   * groups by name and callers rely on that. This answers a different question
   * and says so in its name.
   *
   * Sequenced artifacts order by `lineageSeq`, which the store allocated
   * atomically and is authoritative. Artifacts written before lineage numbers
   * existed have none; they sort first, by `createdAt` and then `_id`.
   *
   * That fallback is for *stable presentation*, and it is worth being blunt
   * about what it is not: when two legacy artifacts share a millisecond, their
   * true write order was never recorded and cannot be recovered. The ordering
   * is deterministic so the same history always renders the same way. It is not
   * a reconstruction of what actually happened.
   */
  async listLineage(projectId: string): Promise<ArtifactDocument[]> {
    const all = await this.store.artifacts.find({ projectId }).toArray();

    const legacy = all.filter((a) => a.lineageSeq === undefined);
    const sequenced = all.filter((a) => a.lineageSeq !== undefined);

    legacy.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a._id.localeCompare(b._id),
    );
    sequenced.sort((a, b) => a.lineageSeq! - b.lineageSeq!);

    return [...legacy, ...sequenced];
  }
}
