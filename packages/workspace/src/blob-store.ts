/**
 * Durable, content-addressed binary storage.
 *
 * Artifacts are JSON; some evidence is not. A blob is its bytes, stored once
 * under `sha256:<hex>` of those bytes, in its own collection — never inlined as
 * base64 into an artifact — and referenced from an artifact by that key.
 *
 * - **Atomic:** one insert of one document; a blob either exists whole or not at all.
 * - **Deduplicated:** the key is the content hash, so identical bytes are one
 *   blob, and a second write of them is a verified no-op.
 * - **Verified:** a write re-reads nothing it did not hash, and a read re-hashes
 *   what it returns, so a key always describes exactly its bytes.
 * - **Immutable:** no update and no delete (and so no garbage collection yet).
 */
import { createHash } from 'node:crypto';
import { Binary } from 'mongodb';
import type { StateStore } from '@statxai/state';

export interface BlobRef {
  /** `sha256:<hex>` — the storage key. */
  readonly blob: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly contentType: string;
}

/** Well below MongoDB's 16 MB document limit, with room for the envelope. */
export const MAX_BLOB_BYTES = 12 * 1024 * 1024;

export class BlobTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`Blob of ${bytes} bytes exceeds the ${MAX_BLOB_BYTES}-byte limit`);
    this.name = 'BlobTooLarge';
  }
}

export class BlobNotFound extends Error {
  constructor(readonly blob: string) {
    super(`Blob ${blob} not found`);
    this.name = 'BlobNotFound';
  }
}

/** Stored bytes no longer match their key. */
export class BlobCorrupt extends Error {
  constructor(readonly blob: string) {
    super(`Blob ${blob} does not match its content hash`);
    this.name = 'BlobCorrupt';
  }
}

export function blobKey(sha256: string): string {
  return `sha256:${sha256}`;
}

export class BlobStore {
  constructor(private readonly store: StateStore) {}

  async put(bytes: Uint8Array, contentType: string): Promise<BlobRef> {
    if (bytes.length > MAX_BLOB_BYTES) throw new BlobTooLarge(bytes.length);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ref: BlobRef = { blob: blobKey(sha256), sha256, bytes: bytes.length, contentType };
    try {
      await this.store.blobs.insertOne({
        _id: ref.blob,
        sha256,
        bytes: bytes.length,
        contentType,
        data: new Binary(Buffer.from(bytes)),
        createdAt: new Date(),
      });
    } catch (error) {
      // Already stored: the same key is the same bytes — confirmed, not assumed.
      if ((error as { code?: number }).code !== 11000) throw error;
      const existing = await this.store.blobs.findOne({ _id: ref.blob }, { projection: { sha256: 1, bytes: 1, contentType: 1 } });
      if (!existing || existing.sha256 !== sha256 || existing.bytes !== bytes.length || existing.contentType !== contentType) {
        throw new BlobCorrupt(ref.blob);
      }
    }
    return ref;
  }

  async get(blob: string): Promise<Buffer> {
    const doc = await this.store.blobs.findOne({ _id: blob });
    if (!doc) throw new BlobNotFound(blob);
    const bytes = Buffer.from(doc.data.buffer);
    if (blobKey(createHash('sha256').update(bytes).digest('hex')) !== blob || bytes.length !== doc.bytes) throw new BlobCorrupt(blob);
    return bytes;
  }
}
