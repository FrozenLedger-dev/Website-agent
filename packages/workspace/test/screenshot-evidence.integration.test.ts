/**
 * Durable screenshot evidence against a real Mongo replica set: the blob store,
 * and the screenshot set that points at its blobs.
 *
 * The capture outcome here is constructed (real PNG bytes, a real report shape)
 * so every storage path — success, deduplication, corruption, a failed blob
 * write, a failed artifact write, repeated evaluation — can be driven exactly.
 * `screenshot-capture.integration.test.ts` produces the same outcome from real
 * Chromium.
 *
 * Integration: needs the Mongo replica set.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Binary } from 'mongodb';
import { SCREENSHOT_POLICY_VERSION, type BrowserRenderReport } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import {
  ArtifactRegistry,
  BROWSER_IMAGE,
  BROWSER_VIEWPORTS,
  BlobCorrupt,
  BlobNotFound,
  BlobStore,
  BlobTooLarge,
  MAX_BLOB_BYTES,
  PLAYWRIGHT_VERSION,
  SCREENSHOT_POLICY,
  SCREENSHOT_SET_ARTIFACT,
  persistScreenshotSet,
  pngDimensions,
  type BrowserCapture,
  type BrowserCaptureOutcome,
} from '../src/index.js';

let store: StateStore;
let registry: ArtifactRegistry;
let blobs: BlobStore;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  blobs = new BlobStore(store);
});

afterAll(async () => {
  await store?.close();
});

beforeEach(async () => {
  await store.artifacts.deleteMany({});
  await store.artifactSequences.deleteMany({});
  await store.blobs.deleteMany({});
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** A real, valid PNG of the given size, whose pixels depend on `seed`. */
function png(width: number, height: number, seed = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const row = Buffer.alloc(1 + width * 3, seed % 256);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const SUBJECT = {
  projectId: 'proj_screens',
  sitePlan: { name: 'site-plan', version: 3, contentHash: 'a'.repeat(64) },
  sourceCommit: 'f00dfeed00000000000000000000000000000000',
  exportDigest: 'b'.repeat(64),
  authority: { mode: 'job_lifecycle' as const, buildBindingId: 'binding_1', promotionId: 'promotion_1', promotionCommitSha: 'c'.repeat(40) },
};

function outcome(captures: BrowserCapture[], status: BrowserRenderReport['status'] = 'completed'): BrowserCaptureOutcome {
  return {
    report: {
      subject: SUBJECT,
      runtime: { playwright: PLAYWRIGHT_VERSION, image: BROWSER_IMAGE },
      viewports: [...BROWSER_VIEWPORTS],
      status,
      renders: captures.map((c) => ({
        route: c.route,
        viewport: c.viewport.name,
        status: c.reason === 'render_not_ready' ? 'failed' : 'rendered',
        httpStatus: c.reason === 'render_not_ready' ? 404 : 200,
        navigationMs: 1,
        readyMs: 1,
        findings: c.reason === 'render_not_ready' ? [{ category: 'http_error', route: c.route, viewport: c.viewport.name, detail: 'HTTP 404' }] : [],
      })),
      omittedRoutes: [],
      passed: status === 'completed',
      truncated: false,
      durationMs: 1,
      reason: null,
    },
    captures,
    policy: SCREENSHOT_POLICY,
  };
}

const captured = (route: string, viewportIndex: number, bytes: Buffer, page = { width: 0, height: 0 }): BrowserCapture => {
  const size = pngDimensions(bytes)!;
  return { route, viewport: BROWSER_VIEWPORTS[viewportIndex]!, reason: 'captured', page: { ...page, width: size.width, height: page.height || size.height }, truncated: false, png: bytes, width: size.width, height: size.height, detail: null };
};
const missing = (route: string, viewportIndex: number): BrowserCapture => ({
  route, viewport: BROWSER_VIEWPORTS[viewportIndex]!, reason: 'render_not_ready', page: null, truncated: false, png: null, width: null, height: null, detail: null,
});

describe('the blob store', () => {
  it('stores bytes durably under their sha256 and returns exactly them', async () => {
    const bytes = png(16, 9, 1);
    const ref = await blobs.put(bytes, 'image/png');

    expect(ref).toEqual({ blob: `sha256:${sha(bytes)}`, sha256: sha(bytes), bytes: bytes.length, contentType: 'image/png' });
    expect((await blobs.get(ref.blob)).equals(bytes)).toBe(true);
    const doc = await store.blobs.findOne({ _id: ref.blob });
    expect(doc?.data).toBeInstanceOf(Binary);
  });

  it('deduplicates identical bytes safely: one document, the same reference', async () => {
    const bytes = png(16, 9, 2);
    const first = await blobs.put(bytes, 'image/png');
    const second = await blobs.put(Buffer.from(bytes), 'image/png');
    expect(second).toEqual(first);
    expect(await store.blobs.countDocuments({})).toBe(1);
  });

  it('refuses stored bytes that no longer match their key', async () => {
    const ref = await blobs.put(png(16, 9, 3), 'image/png');
    await store.blobs.updateOne({ _id: ref.blob }, { $set: { data: new Binary(png(16, 9, 4)) } });
    await expect(blobs.get(ref.blob)).rejects.toBeInstanceOf(BlobCorrupt);
    await expect(blobs.put(png(16, 9, 3), 'text/plain')).rejects.toBeInstanceOf(BlobCorrupt);
  });

  it('refuses a blob over the size bound, and reports a missing one', async () => {
    await expect(blobs.put(Buffer.alloc(MAX_BLOB_BYTES + 1), 'image/png')).rejects.toBeInstanceOf(BlobTooLarge);
    await expect(blobs.get(`sha256:${'0'.repeat(64)}`)).rejects.toBeInstanceOf(BlobNotFound);
  });
});

describe('the screenshot set', () => {
  it('names the exact subject, policy, target, dimensions, byte hash and size of every durable image', async () => {
    const desktop = png(1440, 900, 10);
    const mobile = png(390, 1200, 11);
    const { ref, set } = await persistScreenshotSet({
      registry,
      blobs,
      projectId: SUBJECT.projectId,
      outcome: outcome([captured('/', 0, desktop), captured('/', 2, mobile)]),
    });

    expect(ref).toMatchObject({ name: SCREENSHOT_SET_ARTIFACT, version: 1 });
    expect(await registry.resolve(SUBJECT.projectId, ref)).toEqual(set);
    expect(set.subject).toEqual(SUBJECT);
    expect(set.policy.version).toBe(SCREENSHOT_POLICY_VERSION);
    expect(set).toMatchObject({ expectedCaptures: 2, capturedCount: 2, missingCount: 0, complete: true, totalBytes: desktop.length + mobile.length });

    for (const [capture, bytes] of [[set.captures[0]!, desktop], [set.captures[1]!, mobile]] as const) {
      expect(capture.reason).toBe('captured');
      expect(capture.image).toEqual({
        blob: `sha256:${sha(bytes)}`,
        sha256: sha(bytes),
        bytes: bytes.length,
        width: pngDimensions(bytes)!.width,
        height: pngDimensions(bytes)!.height,
        contentType: 'image/png',
      });
      const stored = await blobs.get(capture.image!.blob);
      expect(sha(stored)).toBe(capture.image!.sha256);
      expect(stored.length).toBe(capture.image!.bytes);
    }
    expect(set.captures.map((c) => [c.route, c.viewport.name, c.viewport.width, c.viewport.height])).toEqual([
      ['/', 'desktop', 1440, 900],
      ['/', 'mobile', 390, 844],
    ]);
  });

  it('a legacy subject carries no binding or promotion it does not have', async () => {
    const legacy = { ...SUBJECT, authority: { mode: 'legacy_direct' as const } };
    const base = outcome([captured('/', 0, png(1440, 900, 12))]);
    const { set } = await persistScreenshotSet({ registry, blobs, projectId: SUBJECT.projectId, outcome: { ...base, report: { ...base.report, subject: legacy } } });
    expect(set.subject.authority).toEqual({ mode: 'legacy_direct' });
    expect(JSON.stringify(set)).not.toMatch(/buildBindingId|promotionId|promotionCommitSha/);
  });

  it('a target that did not render has no image, and the set says it is incomplete', async () => {
    const { set } = await persistScreenshotSet({
      registry,
      blobs,
      projectId: SUBJECT.projectId,
      outcome: outcome([captured('/', 0, png(1440, 900, 13)), missing('/missing', 0)]),
    });
    expect(set).toMatchObject({ expectedCaptures: 2, capturedCount: 1, missingCount: 1, complete: false });
    expect(set.captures[1]).toMatchObject({ route: '/missing', reason: 'render_not_ready', image: null, renderStatus: 'failed', findingCategories: ['http_error'] });
    expect(await store.blobs.countDocuments({})).toBe(1);
  });

  it('a set from a run that did not complete is never complete', async () => {
    const { set } = await persistScreenshotSet({ registry, blobs, projectId: SUBJECT.projectId, outcome: outcome([captured('/', 0, png(1440, 900, 14))], 'timed_out') });
    expect(set.capturedCount).toBe(1);
    expect(set.complete).toBe(false);
  });

  it('writes every image before the set, so the set never points at a missing image', async () => {
    const order: string[] = [];
    const spyBlobs = { put: vi.fn(async (bytes: Buffer, type: string) => { order.push('blob'); return blobs.put(bytes, type); }) } as unknown as BlobStore;
    const spyRegistry = { put: vi.fn(async (...args: Parameters<ArtifactRegistry['put']>) => { order.push('set'); return registry.put(...args); }) } as unknown as ArtifactRegistry;

    const { set } = await persistScreenshotSet({
      registry: spyRegistry,
      blobs: spyBlobs,
      projectId: SUBJECT.projectId,
      outcome: outcome([captured('/', 0, png(1440, 900, 15)), captured('/', 1, png(768, 1024, 16))]),
    });

    expect(order).toEqual(['blob', 'blob', 'set']);
    for (const capture of set.captures) expect(await store.blobs.countDocuments({ _id: capture.image!.blob })).toBe(1);
  });

  it('a failed image write is recorded as storage_failed, never as captured', async () => {
    let calls = 0;
    const failing = {
      put: vi.fn(async (bytes: Buffer, type: string) => {
        calls += 1;
        if (calls === 2) throw new Error('disk full');
        return blobs.put(bytes, type);
      }),
    } as unknown as BlobStore;

    const { set } = await persistScreenshotSet({
      registry,
      blobs: failing,
      projectId: SUBJECT.projectId,
      outcome: outcome([captured('/', 0, png(1440, 900, 17)), captured('/', 1, png(768, 1024, 18))]),
    });

    expect(set.captures.map((c) => c.reason)).toEqual(['captured', 'storage_failed']);
    expect(set.captures[1]!.image).toBeNull();
    expect(set).toMatchObject({ capturedCount: 1, missingCount: 1, complete: false });
  });

  it('an image whose stored hash does not match the captured bytes is not claimed as captured', async () => {
    const lying = { put: vi.fn(async (bytes: Buffer, type: string) => ({ ...(await blobs.put(bytes, type)), sha256: '0'.repeat(64) })) } as unknown as BlobStore;
    const { set } = await persistScreenshotSet({ registry, blobs: lying, projectId: SUBJECT.projectId, outcome: outcome([captured('/', 0, png(1440, 900, 21))]) });
    expect(set.captures[0]).toMatchObject({ reason: 'storage_failed', image: null });
    expect(set.complete).toBe(false);
  });

  it('a failed artifact write leaves no screenshot-set claiming anything', async () => {
    const failingRegistry = { put: vi.fn(async () => { throw new Error('registry unavailable'); }) } as unknown as ArtifactRegistry;

    await expect(
      persistScreenshotSet({ registry: failingRegistry, blobs, projectId: SUBJECT.projectId, outcome: outcome([captured('/', 0, png(1440, 900, 19))]) }),
    ).rejects.toThrow('registry unavailable');
    expect(await store.artifacts.countDocuments({ name: SCREENSHOT_SET_ARTIFACT })).toBe(0);
  });

  it('a repeated evaluation adds a new set and preserves the old one; identical images stay one blob', async () => {
    const bytes = png(1440, 900, 20);
    const first = await persistScreenshotSet({ registry, blobs, projectId: SUBJECT.projectId, outcome: outcome([captured('/', 0, bytes)]) });
    const firstStored = await store.artifacts.findOne({ projectId: SUBJECT.projectId, name: SCREENSHOT_SET_ARTIFACT, version: 1 });

    const second = await persistScreenshotSet({ registry, blobs, projectId: SUBJECT.projectId, outcome: outcome([captured('/', 0, Buffer.from(bytes))]) });

    expect(first.ref.version).toBe(1);
    expect(second.ref.version).toBe(2);
    expect(await store.artifacts.findOne({ projectId: SUBJECT.projectId, name: SCREENSHOT_SET_ARTIFACT, version: 1 })).toEqual(firstStored);
    expect(second.set.captures[0]!.image!.blob).toBe(first.set.captures[0]!.image!.blob);
    expect(await store.blobs.countDocuments({})).toBe(1);
  });
});
