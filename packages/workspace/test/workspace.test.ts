import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('commit marker lookup', () => {
  it('matches only an exact marker line, never a marker embedded as a substring within a longer line', async () => {
    // Phase 5h's promotion marker search depends on this being exact: a
    // commit message that merely mentions the marker text in passing must
    // never be mistaken for the real promotion commit it names.
    const ws = await ProjectWorkspace.open(`${PROJECT}_marker_exact`, root);
    const marker = 'Statx-Promotion-Id: abc123';

    await ws.writeSiteFiles([{ path: 'index.html', contents: '<h1>decoy</h1>' }]);
    const decoySha = await ws.commit(`unrelated work\n\nsee also ${marker} for context`);
    expect(decoySha).not.toBeNull();
    expect(await ws.findCommitByMarker(marker)).toBeNull();

    await ws.writeSiteFiles([{ path: 'other.html', contents: '<h1>real</h1>' }]);
    const realSha = await ws.commit(`Promote accepted frontend/backend candidate\n\n${marker}`);
    expect(await ws.findCommitByMarker(marker)).toBe(realSha);
  });
});

/**
 * The two APIs canonical promotion uses to decide what it may delete.
 *
 * Both exist because a path alone cannot answer the question promotion has to
 * ask. "This file is absent from what I am about to promote" is true of a
 * route the plan dropped, of somebody's half-finished edit, and of a scratch
 * file nobody tracks — and only one of those may be removed.
 */
describe('managed site membership and dirty status', () => {
  /** A committed site with a file outside the managed root, plus local changes. */
  async function workspaceWithChanges(suffix: string): Promise<ProjectWorkspace> {
    const ws = await ProjectWorkspace.open(`${PROJECT}_${suffix}`, root);
    await ws.writeSiteFiles([
      { path: 'app/page.tsx', contents: 'home' },
      { path: 'app/services/page.tsx', contents: 'services' },
      { path: 'components/site/mark.tsx', contents: 'mark' },
    ]);
    // Outside the site root: an artifact materialisation, never site content.
    await ws.materialiseArtifact('specs/sitemap.json', { pages: [] });
    await ws.commit('baseline');
    return ws;
  }

  it('distinguishes a modified file from a deleted one and from an untracked one', async () => {
    const ws = await workspaceWithChanges('dirty_status');
    const siteRoot = join(root, `${PROJECT}_dirty_status`, 'app');

    await writeFile(join(siteRoot, 'app/page.tsx'), 'EDITED', 'utf8');
    await rm(join(siteRoot, 'app/services/page.tsx'));
    await writeFile(join(siteRoot, 'scratch.txt'), 'x', 'utf8');

    const byPath = new Map((await ws.dirtyEntries()).map((e) => [e.path, e.status]));

    // Git's own codes, kept verbatim: the caller asks the question, not this API.
    expect(byPath.get('app/app/page.tsx')).toBe(' M');
    expect(byPath.get('app/app/services/page.tsx')).toBe(' D');
    expect(byPath.get('app/scratch.txt')).toBe('??');
  });

  it('reports the same paths through dirtyPaths as before', async () => {
    const ws = await workspaceWithChanges('dirty_compat');
    const siteRoot = join(root, `${PROJECT}_dirty_compat`, 'app');

    await writeFile(join(siteRoot, 'app/page.tsx'), 'EDITED', 'utf8');
    await rm(join(siteRoot, 'app/services/page.tsx'));
    await writeFile(join(siteRoot, 'scratch.txt'), 'x', 'utf8');

    // The path-level view is exactly the entries' paths — existing callers
    // (the specification and promotion guards) see no change.
    expect(await ws.dirtyPaths()).toEqual((await ws.dirtyEntries()).map((e) => e.path));
    expect(await ws.dirtyPaths()).toEqual(
      expect.arrayContaining(['app/app/page.tsx', 'app/app/services/page.tsx', 'app/scratch.txt']),
    );
  });

  it('tracks only managed site files, never artifacts outside the site root', async () => {
    const ws = await workspaceWithChanges('tracked_scope');
    const tracked = await ws.trackedSiteFiles();

    expect(tracked).toEqual(
      expect.arrayContaining(['app/app/page.tsx', 'app/app/services/page.tsx', 'app/components/site/mark.tsx']),
    );
    // `specs/sitemap.json` is tracked, and deliberately not site membership.
    expect(tracked.every((path) => path.startsWith('app/'))).toBe(true);
    expect(tracked).not.toContain('specs/sitemap.json');
  });

  it('still lists a tracked file deleted in the working tree but not staged', async () => {
    // This is what lets an interrupted promotion recompute the identical
    // stale set on its retry instead of losing track of its own unfinished
    // deletion: the file is gone from disk but still in the index.
    const ws = await workspaceWithChanges('tracked_deleted');
    await rm(join(root, `${PROJECT}_tracked_deleted`, 'app', 'app/services/page.tsx'));

    expect(await ws.trackedSiteFiles()).toContain('app/app/services/page.tsx');
  });

  it('never lists an untracked site file', async () => {
    const ws = await workspaceWithChanges('tracked_untracked');
    await writeFile(join(root, `${PROJECT}_tracked_untracked`, 'app', 'scratch.txt'), 'x', 'utf8');

    // Absent from the index, so it can never become a deletion candidate.
    expect(await ws.trackedSiteFiles()).not.toContain('app/scratch.txt');
  });
});
