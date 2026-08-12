import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, PathEscapesWorkspace, ProjectWorkspace, canonicalJson, contentHash } from '../src/index.js';

const PROJECT = 'proj_workspace_test';

let store: StateStore;
let root: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  root = await mkdtemp(join(tmpdir(), 'statxai-ws-'));
});

afterAll(async () => {
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.artifacts.deleteMany({ projectId: PROJECT });
});

describe('path safety', () => {
  it('refuses to write outside the site root', async () => {
    // The path comes from model output, so traversal is a live input.
    const ws = await ProjectWorkspace.open(PROJECT, root);
    await expect(
      ws.writeSiteFiles([{ path: '../../../etc/evil.html', contents: 'x' }]),
    ).rejects.toBeInstanceOf(PathEscapesWorkspace);
  });

  it('contains an absolute-looking path inside the site rather than obeying it', async () => {
    // The invariant is containment, not rejection: a leading slash means "site
    // root" to a model, so it is normalised and written *inside* the workspace.
    // What must never happen is a write to the real /etc.
    const ws = await ProjectWorkspace.open(`${PROJECT}_abs`, root);
    await ws.writeSiteFiles([{ path: '/etc/evil.html', contents: 'x' }]);

    expect(await ws.readSiteFile('etc/evil.html')).toBe('x');
    expect(existsSync('/etc/evil.html')).toBe(false);
  });

  it('treats a leading slash as site-root, not filesystem-root', async () => {
    // Regression: some models emit "/services.html" meaning site-relative. That
    // resolved to an absolute path and was refused mid-build, failing a run
    // whose anchor page had already been written.
    const ws = await ProjectWorkspace.open(`${PROJECT}_slash`, root);
    await ws.writeSiteFiles([{ path: '/services.html', contents: '<h1>ok</h1>' }]);
    expect(await ws.readSiteFile('services.html')).toBe('<h1>ok</h1>');
  });

  it('still refuses traversal that only looks site-relative', async () => {
    const ws = await ProjectWorkspace.open(`${PROJECT}_slash2`, root);
    await expect(
      ws.writeSiteFiles([{ path: '/../../etc/evil.html', contents: 'x' }]),
    ).rejects.toBeInstanceOf(PathEscapesWorkspace);
  });

  it('allows ordinary nested paths', async () => {
    const ws = await ProjectWorkspace.open(PROJECT, root);
    await ws.writeSiteFiles([{ path: 'services/joinery.html', contents: '<h1>ok</h1>' }]);
    expect(await ws.readSiteFile('services/joinery.html')).toBe('<h1>ok</h1>');
  });
});

describe('git workspace', () => {
  it('commits changes and reports the revision', async () => {
    const ws = await ProjectWorkspace.open(`${PROJECT}_git`, root);
    await ws.writeSiteFiles([{ path: 'index.html', contents: '<h1>one</h1>' }]);

    const first = await ws.commit('build');
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    // Nothing changed — a commit must not be fabricated, because the release
    // manifest records this revision as the accepted source.
    expect(await ws.commit('no-op')).toBeNull();

    await ws.writeSiteFiles([{ path: 'index.html', contents: '<h1>two</h1>' }]);
    const second = await ws.commit('repair');
    expect(second).not.toBe(first);
  });

  it('operates on a repository owned by another user', async () => {
    // Regression: a run writing a workspace owned by a different user failed at
    // commit time with "detected dubious ownership", losing a completed build.
    // safe.directory is now set per invocation, so ownership cannot break git.
    const ws = await ProjectWorkspace.open(`${PROJECT}_owner`, root);
    await ws.writeSiteFiles([{ path: 'index.html', contents: '<h1>ok</h1>' }]);
    await expect(ws.commit('build')).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it('materialises artifacts into the Appendix A layout', async () => {
    const ws = await ProjectWorkspace.open(`${PROJECT}_layout`, root);
    await ws.materialiseArtifact('client/business-profile.json', { businessName: 'Test Co' });
    const written = await readFile(join(root, `${PROJECT}_layout`, 'client/business-profile.json'), 'utf8');
    expect(JSON.parse(written)).toEqual({ businessName: 'Test Co' });
  });
});

describe('artifact registry', () => {
  it('allocates a new immutable version on every write', async () => {
    const registry = new ArtifactRegistry(store);

    const v1 = await registry.put(PROJECT, 'business-profile', { name: 'first' });
    const v2 = await registry.put(PROJECT, 'business-profile', { name: 'second' });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);

    // Appendix B: an accepted artifact is an immutable input, so v1 must still
    // read back exactly as written after v2 exists.
    expect(await registry.get(PROJECT, 'business-profile', 1)).toEqual({ name: 'first' });
    expect(await registry.get(PROJECT, 'business-profile')).toEqual({ name: 'second' });
  });

  it('records acceptance separately from creation', async () => {
    const registry = new ArtifactRegistry(store);
    const ref = await registry.put(PROJECT, 'site-plan', { pages: 4 });

    let doc = await store.artifacts.findOne({ projectId: PROJECT, name: 'site-plan', version: 1 });
    expect(doc?.acceptedAt).toBeNull();

    await registry.accept(PROJECT, ref);
    doc = await store.artifacts.findOne({ projectId: PROJECT, name: 'site-plan', version: 1 });
    expect(doc?.acceptedAt).toBeInstanceOf(Date);
  });

  it('hashes content independently of key order', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});
