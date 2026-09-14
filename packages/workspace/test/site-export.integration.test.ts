/**
 * Site export snapshots against real storage: capture into the blob store and
 * artifact registry, content addressing and deduplication, exact reading with
 * every hash re-proven, a directory that changed after its build refused, and
 * the renderer digesting exactly what the snapshot recorded.
 *
 * Integration: needs the Mongo replica set, a real (temp) filesystem, and — for
 * the renderer case — the browser sandbox.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Binary } from 'mongodb';
import { StateStore } from '@statxai/state';
import {
  ArtifactRegistry,
  BlobCorrupt,
  BlobStore,
  SiteExportSnapshotInvalid,
  captureSiteExportSnapshot,
  exportDigestOf,
  materializeSiteExport,
  readExportTree,
  readSiteExportFile,
  readSiteExportSnapshot,
  renderInBrowser,
  resolveSiteExportRequest,
} from '../src/index.js';

let store: StateStore;
let registry: ArtifactRegistry;
let blobs: BlobStore;
let root: string;
let counter = 0;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  blobs = new BlobStore(store);
  root = await mkdtemp(join(tmpdir(), 'statxai-site-export-'));
});

afterAll(async () => {
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.artifacts.deleteMany({ projectId: /^proj_export_/ });
});

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0, 255]);

async function exportDir(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(root, 'out-'));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), contents);
  }
  return dir;
}

const SITE = {
  'index.html': '<!doctype html><html><head><link rel="stylesheet" href="/_next/static/css/app.css"></head><body><h1>Home</h1><img src="/images/hero.png"></body></html>',
  'services.html': '<!doctype html><html><body><h1>Services</h1></body></html>',
  '_next/static/css/app.css': 'body{font-family:serif}',
  '_next/static/chunks/app.js': 'console.log(1)',
  'images/hero.png': PNG,
};

function subjectFor(projectId: string, buildBindingId = 'frontend-backend-build-b0') {
  return {
    projectId,
    sitePlan: { name: 'site-plan', version: 1, contentHash: 'a'.repeat(64) },
    sourceCommit: 'b'.repeat(40),
    authority: { mode: 'job_lifecycle' as const, buildBindingId, promotionId: 'promotion-b0', promotionCommitSha: 'b'.repeat(40) },
    editableSiteModel: { name: 'editable-site-model', version: 1, contentHash: 'c'.repeat(64) },
  };
}

async function capture(files: Record<string, string | Buffer> = SITE, projectId = `proj_export_${(counter += 1)}`) {
  const dir = await exportDir(files);
  const tree = await readExportTree(dir);
  const captured = await captureSiteExportSnapshot({ registry, blobs, projectId, exportDir: dir, subject: subjectFor(projectId), expectedExportDigest: tree.exportDigest });
  return { dir, tree, captured, projectId };
}

describe('capturing an export', () => {
  it('stores every file as a content-addressed blob and a strict manifest artifact naming them — never raw bytes', async () => {
    const { captured, projectId } = await capture();

    expect(captured.ref).toMatchObject({ name: 'site-export-snapshot', version: 1 });
    expect(captured.ref.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const snapshot = await readSiteExportSnapshot(registry, projectId, captured.ref);
    expect(snapshot.files.map((f) => f.path)).toEqual(['_next/static/chunks/app.js', '_next/static/css/app.css', 'images/hero.png', 'index.html', 'services.html']);
    expect(snapshot.subject).toEqual(subjectFor(projectId));
    expect(snapshot.exportDigest).toBe(exportDigestOf(snapshot.files));

    const doc = await store.artifacts.findOne({ projectId, name: 'site-export-snapshot' });
    expect(JSON.stringify(doc!.data)).not.toContain('<h1>Home</h1>');
    for (const file of snapshot.files) {
      const blob = await store.blobs.findOne({ _id: file.blob });
      expect(blob?.sha256).toBe(file.sha256);
      expect(blob?.bytes).toBe(file.bytes);
    }
  });

  it('reads every file back byte for byte, binary included, with its media type', async () => {
    const { captured, projectId } = await capture();
    const snapshot = await readSiteExportSnapshot(registry, projectId, captured.ref);
    for (const [path, contents] of Object.entries(SITE)) {
      const file = await readSiteExportFile(blobs, snapshot, path);
      expect(file!.bytes.equals(Buffer.from(contents))).toBe(true);
    }
    expect((await readSiteExportFile(blobs, snapshot, 'images/hero.png'))!.contentType).toBe('image/png');
    expect(await readSiteExportFile(blobs, snapshot, 'package.json')).toBeNull();
    expect(await resolveSiteExportRequest(snapshot, '/services')).toBe('services.html');
    expect(await resolveSiteExportRequest(snapshot, ['_next', 'static', 'css', 'app.css'])).toBe('_next/static/css/app.css');
  });

  it('identical bytes are one blob — across paths, builds and projects — and a repeat capture versions only the manifest', async () => {
    const first = await capture({ 'index.html': 'same', 'copy.html': 'same' });
    const snapshot = await readSiteExportSnapshot(registry, first.projectId, first.captured.ref);
    expect(new Set(snapshot.files.map((f) => f.blob)).size).toBe(1);

    const again = await captureSiteExportSnapshot({ registry, blobs, projectId: first.projectId, exportDir: first.dir, subject: subjectFor(first.projectId), expectedExportDigest: first.tree.exportDigest });
    expect(again.ref.version).toBe(first.captured.ref.version + 1);
    expect(again.snapshot.exportDigest).toBe(snapshot.exportDigest);
    expect(again.snapshot.files).toEqual(snapshot.files);

    const other = await capture({ 'index.html': 'same', 'copy.html': 'same' });
    expect((await readSiteExportSnapshot(registry, other.projectId, other.captured.ref)).files.map((f) => f.blob)).toEqual(snapshot.files.map((f) => f.blob));
    expect(await store.blobs.countDocuments({ _id: `sha256:${sha('same')}` })).toBe(1);
  });

  it('refuses an export that changed after the build digested it — nothing is recorded', async () => {
    const projectId = `proj_export_${(counter += 1)}`;
    const dir = await exportDir(SITE);
    const built = await readExportTree(dir);
    await writeFile(join(dir, 'index.html'), '<h1>another writer</h1>');
    await expect(captureSiteExportSnapshot({ registry, blobs, projectId, exportDir: dir, subject: subjectFor(projectId), expectedExportDigest: built.exportDigest })).rejects.toMatchObject({ reason: 'export_changed' });
    expect(await store.artifacts.countDocuments({ projectId })).toBe(0);
  });

  it('once captured, a snapshot is immune to later changes of the export directory', async () => {
    const { dir, captured, projectId } = await capture();
    await writeFile(join(dir, 'index.html'), '<h1>the next build</h1>');
    await rm(join(dir, 'services.html'));
    const snapshot = await readSiteExportSnapshot(registry, projectId, captured.ref);
    expect((await readSiteExportFile(blobs, snapshot, 'index.html'))!.bytes.toString()).toBe(SITE['index.html']);
    expect(await readSiteExportFile(blobs, snapshot, 'services.html')).not.toBeNull();
  });
});

describe('exact reading', () => {
  it('accepts only an exact ref: wrong name, missing hash, wrong hash, wrong version or wrong project fail closed', async () => {
    const { captured, projectId } = await capture();
    await expect(readSiteExportSnapshot(registry, projectId, { ...captured.ref, name: 'screenshot-set' })).rejects.toBeInstanceOf(SiteExportSnapshotInvalid);
    await expect(readSiteExportSnapshot(registry, projectId, { name: captured.ref.name, version: captured.ref.version })).rejects.toBeInstanceOf(SiteExportSnapshotInvalid);
    await expect(readSiteExportSnapshot(registry, projectId, { ...captured.ref, contentHash: 'f'.repeat(64) })).rejects.toBeInstanceOf(SiteExportSnapshotInvalid);
    await expect(readSiteExportSnapshot(registry, projectId, { ...captured.ref, version: captured.ref.version + 5 })).rejects.toBeInstanceOf(SiteExportSnapshotInvalid);
    await expect(readSiteExportSnapshot(registry, 'proj_export_other', captured.ref)).rejects.toBeInstanceOf(SiteExportSnapshotInvalid);
  });

  it('a tampered manifest fails closed even when its stored hash is rewritten to match', async () => {
    const { captured, projectId } = await capture();
    const doc = (await store.artifacts.findOne({ projectId, name: 'site-export-snapshot' }))!;
    const data = structuredClone(doc.data) as { files: { path: string; sha256: string; blob: string }[] };
    data.files[0]!.sha256 = 'e'.repeat(64);
    data.files[0]!.blob = `sha256:${'e'.repeat(64)}`;
    const forgedHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    await store.artifacts.updateOne({ _id: doc._id }, { $set: { data, contentHash: forgedHash } });
    await expect(readSiteExportSnapshot(registry, projectId, { ...captured.ref, contentHash: forgedHash })).rejects.toThrow(/digest/);
  });

  it('a corrupt blob fails closed on read', async () => {
    const { captured, projectId } = await capture({ 'index.html': `<h1>unique ${Date.now()}</h1>` });
    const snapshot = await readSiteExportSnapshot(registry, projectId, captured.ref);
    const file = snapshot.files[0]!;
    await store.blobs.updateOne({ _id: file.blob }, { $set: { data: new Binary(Buffer.from('tampered')) } });
    await expect(readSiteExportFile(blobs, snapshot, 'index.html')).rejects.toBeInstanceOf(BlobCorrupt);
  });
});

describe('one digest for the snapshot and the renderer', () => {
  it('the browser render of the materialised snapshot carries exactly the snapshot exportDigest', async () => {
    const { captured, projectId } = await capture();
    const materialised = await mkdtemp(join(root, 'render-'));
    await materializeSiteExport(captured.files, materialised);
    expect((await readFile(join(materialised, 'images', 'hero.png'))).equals(PNG)).toBe(true);
    expect((await readExportTree(materialised)).exportDigest).toBe(captured.snapshot.exportDigest);

    const report = await renderInBrowser({
      exportDir: materialised,
      plan: { sitemap: { pages: [{ route: '/' }, { route: '/services' }] } } as never,
      subject: { projectId, sitePlan: { name: 'site-plan', version: 1 }, sourceCommit: null, authority: { mode: 'legacy_direct' } },
    });
    expect(report.subject.exportDigest).toBe(captured.snapshot.exportDigest);
  }, 240_000);
});
