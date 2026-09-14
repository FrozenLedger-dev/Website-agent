/**
 * Site export snapshots, offline: the manifest contract, the one export digest,
 * reading an export tree exactly and within bounds, request resolution and media
 * types. Storage and exact reading against real Mongo live in the integration
 * suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SITE_EXPORT_SNAPSHOT_POLICY, SiteExportSnapshot, isSiteExportPath } from '@statxai/contracts';
import {
  MAX_BLOB_BYTES,
  SiteExportPathRejected,
  SiteExportSnapshotRefused,
  exportDigestOf,
  normalizeSiteExportRequest,
  readExportTree,
  resolveSiteExportRequest,
  siteExportContentType,
} from '../src/index.js';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const file = (path: string, contents: string) => ({ path, blob: `sha256:${sha(contents)}`, sha256: sha(contents), bytes: Buffer.byteLength(contents) });
const subject = {
  projectId: 'proj_x',
  sitePlan: { name: 'site-plan', version: 1 },
  sourceCommit: 'a'.repeat(40),
  authority: { mode: 'job_lifecycle' as const, buildBindingId: 'frontend-backend-build-b0', promotionId: 'promotion-1', promotionCommitSha: 'a'.repeat(40) },
  editableSiteModel: { name: 'editable-site-model', version: 1, contentHash: 'c'.repeat(64) },
};
const manifest = (files: ReturnType<typeof file>[]) => ({
  policyVersion: SITE_EXPORT_SNAPSHOT_POLICY.version,
  subject,
  exportDigest: exportDigestOf(files),
  files,
  totalFiles: files.length,
  totalBytes: files.reduce((n, f) => n + f.bytes, 0),
});

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'statxai-site-export-unit-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const dir = async (name: string) => {
  const d = join(root, name);
  await mkdir(d, { recursive: true });
  return d;
};

describe('the site-export-snapshot manifest', () => {
  const valid = manifest([file('_next/static/app.css', 'body{}'), file('index.html', '<h1>x</h1>'), file('services.html', 's')]);

  it('parses a valid manifest, bound to an exact subject, digest and files', () => {
    expect(SiteExportSnapshot.parse(valid)).toEqual(valid);
    for (const key of ['subject', 'exportDigest', 'files', 'policyVersion'] as const) {
      const missing: Record<string, unknown> = { ...valid };
      delete missing[key];
      expect(SiteExportSnapshot.safeParse(missing).success, key).toBe(false);
    }
    const noAuthority: Record<string, unknown> = { ...subject };
    delete noAuthority.authority;
    expect(SiteExportSnapshot.safeParse({ ...valid, subject: noAuthority }).success).toBe(false);
    expect(SiteExportSnapshot.safeParse({ ...valid, subject: { ...subject, editableSiteModel: undefined } }).success).toBe(false);
    expect(SiteExportSnapshot.safeParse({ ...valid, files: [] }).success).toBe(false);
    expect(SiteExportSnapshot.safeParse({ ...valid, exportDigest: 'nope' }).success).toBe(false);
  });

  it('requires unique paths in ascending order, counted and summed exactly', () => {
    const [a, b] = valid.files;
    expect(SiteExportSnapshot.safeParse({ ...valid, files: [b, a, valid.files[2]] }).success).toBe(false);
    expect(SiteExportSnapshot.safeParse({ ...manifest([a!, a!]) }).success).toBe(false);
    expect(SiteExportSnapshot.safeParse({ ...valid, totalFiles: 2 }).success).toBe(false);
    expect(SiteExportSnapshot.safeParse({ ...valid, totalBytes: valid.totalBytes + 1 }).success).toBe(false);
  });

  it.each([
    ['a traversal path', '../secret'],
    ['a nested traversal', 'a/../../b'],
    ['an absolute path', '/index.html'],
    ['a backslash', 'a\\b.html'],
    ['a dot segment', './index.html'],
    ['an empty segment', 'a//b'],
    ['a trailing slash', 'a/'],
    ['a NUL', `a${String.fromCharCode(0)}b`],
  ])('rejects %s', (_label, path) => {
    expect(isSiteExportPath(path)).toBe(false);
    const bad = manifest([{ ...file('index.html', 'x'), path }]);
    expect(SiteExportSnapshot.safeParse(bad).success).toBe(false);
  });

  it('rejects a malformed blob key or hash, and a key that does not name the hash', () => {
    const f = file('index.html', 'x');
    expect(SiteExportSnapshot.safeParse(manifest([{ ...f, blob: 'index.html' }])).success).toBe(false);
    expect(SiteExportSnapshot.safeParse(manifest([{ ...f, sha256: 'xyz' }])).success).toBe(false);
    expect(SiteExportSnapshot.safeParse(manifest([{ ...f, blob: `sha256:${'0'.repeat(64)}` }])).success).toBe(false);
    expect(SiteExportSnapshot.safeParse(manifest([{ ...f, bytes: SITE_EXPORT_SNAPSHOT_POLICY.maxFileBytes + 1 }])).success).toBe(false);
  });

  it('bounds each file by exactly the blob store limit', () => {
    expect(SITE_EXPORT_SNAPSHOT_POLICY.maxFileBytes).toBe(MAX_BLOB_BYTES);
  });
});

describe('the one export digest', () => {
  const entries = [{ path: 'index.html', sha256: sha('a') }, { path: 'b/c.css', sha256: sha('b') }];

  it('is deterministic and independent of input order', () => {
    expect(exportDigestOf(entries)).toBe(exportDigestOf([...entries].reverse()));
    expect(exportDigestOf(entries)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes with any byte, any path, and any omitted file', () => {
    const base = exportDigestOf(entries);
    expect(exportDigestOf([{ ...entries[0]!, sha256: sha('A') }, entries[1]!])).not.toBe(base);
    expect(exportDigestOf([{ ...entries[0]!, path: 'home.html' }, entries[1]!])).not.toBe(base);
    expect(exportDigestOf([entries[0]!])).not.toBe(base);
  });

  it('is exactly the historical render digest: sha256 over "path \\0 hash \\n" in path order', () => {
    const expected = createHash('sha256').update(`b/c.css\0${sha('b')}\nindex.html\0${sha('a')}\n`).digest('hex');
    expect(exportDigestOf(entries)).toBe(expected);
  });
});

describe('reading an export tree', () => {
  it('captures regular, nested, empty and binary files byte for byte, in path order', async () => {
    const d = await dir('tree-ok');
    const binary = Buffer.from([0, 255, 1, 254, 137, 80, 78, 71]);
    await mkdir(join(d, '_next', 'static', 'media'), { recursive: true });
    await writeFile(join(d, 'index.html'), '<h1>home</h1>');
    await writeFile(join(d, 'services.html'), '<h1>services</h1>');
    await writeFile(join(d, '_next', 'static', 'app.css'), 'body{color:red}');
    await writeFile(join(d, '_next', 'static', 'media', 'logo.png'), binary);
    await writeFile(join(d, '.nojekyll'), '');

    const tree = await readExportTree(d);
    expect(tree.files.map((f) => f.path)).toEqual(['.nojekyll', '_next/static/app.css', '_next/static/media/logo.png', 'index.html', 'services.html']);
    expect(tree.files.find((f) => f.path === '_next/static/media/logo.png')!.bytes.equals(binary)).toBe(true);
    expect(tree.files.find((f) => f.path === '.nojekyll')!.bytes.length).toBe(0);
    expect(tree.totalBytes).toBe(tree.files.reduce((n, f) => n + f.bytes.length, 0));
    expect(tree.exportDigest).toBe(exportDigestOf(tree.files.map((f) => ({ path: f.path, sha256: sha(f.bytes) }))));
    expect(tree.files.every((f) => f.sha256 === sha(f.bytes))).toBe(true);
  });

  it('refuses a symlink — never followed, never skipped', async () => {
    const d = await dir('tree-link');
    await writeFile(join(d, 'index.html'), 'x');
    await symlink('/etc/hostname', join(d, 'leak.txt'));
    await expect(readExportTree(d)).rejects.toMatchObject({ reason: 'invalid_entry' });
  });

  it('refuses a FIFO', async () => {
    const d = await dir('tree-fifo');
    await writeFile(join(d, 'index.html'), 'x');
    execFileSync('mkfifo', [join(d, 'pipe')]);
    await expect(readExportTree(d)).rejects.toMatchObject({ reason: 'invalid_entry' });
  });

  it('refuses too many files, an oversized file, and an oversized export — never truncating', async () => {
    const many = await dir('tree-many');
    for (let i = 0; i < 6; i += 1) await writeFile(join(many, `p${i}.html`), 'x');
    await expect(readExportTree(many, { maxFiles: 5 })).rejects.toMatchObject({ reason: 'too_many_files' });
    expect((await readExportTree(many, { maxFiles: 6 })).files).toHaveLength(6);

    const big = await dir('tree-big');
    await writeFile(join(big, 'index.html'), 'x'.repeat(101));
    await expect(readExportTree(big, { maxFileBytes: 100 })).rejects.toMatchObject({ reason: 'file_too_large' });

    const heavy = await dir('tree-heavy');
    for (let i = 0; i < 4; i += 1) await writeFile(join(heavy, `p${i}.html`), 'x'.repeat(30));
    await expect(readExportTree(heavy, { maxTotalBytes: 100 })).rejects.toMatchObject({ reason: 'snapshot_too_large' });

    // A real per-file overflow at the policy's own limit.
    const huge = await dir('tree-huge');
    await writeFile(join(huge, 'video.bin'), Buffer.alloc(SITE_EXPORT_SNAPSHOT_POLICY.maxFileBytes + 1));
    await expect(readExportTree(huge)).rejects.toBeInstanceOf(SiteExportSnapshotRefused);

    // Bounds tighten only.
    expect((await readExportTree(many, { maxFiles: 1_000_000 })).files).toHaveLength(6);
  });

  it('refuses a missing or empty export', async () => {
    await expect(readExportTree(join(root, 'nowhere'))).rejects.toMatchObject({ reason: 'empty_export' });
    await expect(readExportTree(await dir('tree-empty'))).rejects.toMatchObject({ reason: 'empty_export' });
  });
});

describe('resolving a request against a snapshot manifest', () => {
  const snapshot = SiteExportSnapshot.parse(
    manifest([
      file('_next/static/chunks/app.js', 'js'),
      file('_next/static/css/app.css', 'css'),
      file('about/index.html', 'about'),
      file('images/hero.png', 'png'),
      file('index.html', 'home'),
      file('services.html', 'services'),
      file('services/index.html', 'shadowed'),
    ]),
  );

  it('resolves the root, clean routes, directory indexes and static assets from the manifest alone', async () => {
    expect(await resolveSiteExportRequest(snapshot, '')).toBe('index.html');
    expect(await resolveSiteExportRequest(snapshot, '/')).toBe('index.html');
    expect(await resolveSiteExportRequest(snapshot, [])).toBe('index.html');
    expect(await resolveSiteExportRequest(snapshot, ['services'])).toBe('services.html');
    expect(await resolveSiteExportRequest(snapshot, '/about')).toBe('about/index.html');
    expect(await resolveSiteExportRequest(snapshot, ['_next', 'static', 'css', 'app.css'])).toBe('_next/static/css/app.css');
    expect(await resolveSiteExportRequest(snapshot, ['_next', 'static', 'chunks', 'app.js'])).toBe('_next/static/chunks/app.js');
    expect(await resolveSiteExportRequest(snapshot, 'images/hero.png')).toBe('images/hero.png');
  });

  it('an unknown path is not found — there is no filesystem to fall back to', async () => {
    expect(await resolveSiteExportRequest(snapshot, 'missing')).toBeNull();
    expect(await resolveSiteExportRequest(snapshot, 'package.json')).toBeNull();
    expect(await resolveSiteExportRequest(snapshot, 'images')).toBeNull();
  });

  it.each([
    ['a traversal', ['..', 'package.json']],
    ['a nested traversal', 'a/../../etc/passwd'],
    ['an encoded traversal', '%2e%2e/%2e%2e/etc/passwd'],
    ['an encoded slash traversal', '..%2f..%2fsecret'],
    ['a backslash', '..\\secret'],
    ['an encoded backslash', '%5c..%5csecret'],
    ['an absolute segment list', ['/etc', 'passwd']],
    ['malformed percent-encoding', '%E0%A4%A'],
    ['a NUL', 'index.html%00.png'],
    ['a dot segment', './index.html'],
  ])('rejects %s', async (_label, raw) => {
    expect(() => normalizeSiteExportRequest(raw as string | string[])).toThrow(SiteExportPathRejected);
    await expect(resolveSiteExportRequest(snapshot, raw as string | string[])).rejects.toBeInstanceOf(SiteExportPathRejected);
  });

  it('derives media types from the trusted path alone', () => {
    expect(siteExportContentType('index.html')).toBe('text/html; charset=utf-8');
    expect(siteExportContentType('_next/static/css/app.css')).toBe('text/css; charset=utf-8');
    expect(siteExportContentType('_next/static/chunks/app.js')).toBe('text/javascript; charset=utf-8');
    expect(siteExportContentType('images/hero.PNG')).toBe('image/png');
    expect(siteExportContentType('_next/static/media/font.woff2')).toBe('font/woff2');
    expect(siteExportContentType('weird.bin')).toBe('application/octet-stream');
    expect(siteExportContentType('noextension')).toBe('application/octet-stream');
  });
});
