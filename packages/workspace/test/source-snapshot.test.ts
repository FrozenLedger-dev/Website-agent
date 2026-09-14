/**
 * The model-owned source at one exact commit, read from Git's object store.
 *
 * Offline, against a real temporary Git workspace: what is returned for a SHA
 * is exactly what that commit tracked in the model's namespace — never the
 * working tree, never a later commit, never a platform file — deterministic,
 * bounded, and refused rather than truncated.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommitIdentityInvalid, ProjectWorkspace, SourceSnapshotTooLarge, isModelSourceFile } from '../src/index.js';

let root: string;
let ws: ProjectWorkspace;
let first: string;
let second: string;

const LIMITS = { maxFiles: 80, maxBytes: 400_000 };

async function put(path: string, contents: string) {
  const full = join(ws.root, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'statxai-source-snapshot-'));
  ws = await ProjectWorkspace.open('proj_snapshot', root);
  await put('app/app/page.tsx', 'export default function Home(){return 1}');
  await put('app/app/services/page.tsx', 'export default function S(){return 1}');
  await put('app/components/site/hero.tsx', 'export const Hero = 1;');
  // Platform-owned, or not source: never part of what a model is given.
  await put('app/components/ui/button.tsx', 'export const Button = 1;');
  await put('app/package.json', '{"name":"site"}');
  await put('app/app/favicon.ico', 'binary');
  await put('decisions/route-decision.json', '{}');
  first = (await ws.commit('first'))!;
  await put('app/app/page.tsx', 'export default function Home(){return 2}');
  second = (await ws.commit('second'))!;
  // Uncommitted: must never be read as if canonical.
  await put('app/app/page.tsx', 'export default function Home(){return "DIRTY"}');
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('source at an exact commit', () => {
  it('returns exactly the model-owned source files that commit tracked, sorted, with their committed contents', async () => {
    const files = await ws.readModelSourceAtCommit(first, LIMITS);
    expect(files).toEqual([
      { path: 'app/page.tsx', contents: 'export default function Home(){return 1}' },
      { path: 'app/services/page.tsx', contents: 'export default function S(){return 1}' },
      { path: 'components/site/hero.tsx', contents: 'export const Hero = 1;' },
    ]);
    expect(files.every((f) => isModelSourceFile(f.path))).toBe(true);
  });

  it('is pinned to the SHA: a later commit and the dirty working tree change nothing about what an earlier SHA returns', async () => {
    expect((await ws.readModelSourceAtCommit(first, LIMITS))[0]!.contents).toContain('return 1');
    expect((await ws.readModelSourceAtCommit(second, LIMITS))[0]!.contents).toContain('return 2');
    expect(JSON.stringify(await ws.readModelSourceAtCommit(second, LIMITS))).not.toContain('DIRTY');
  });

  it('is deterministic: the same SHA always yields the identical snapshot', async () => {
    expect(await ws.readModelSourceAtCommit(first, LIMITS)).toEqual(await ws.readModelSourceAtCommit(first, LIMITS));
  });

  it('refuses a snapshot beyond its bounds whole, never truncated', async () => {
    await expect(ws.readModelSourceAtCommit(first, { maxFiles: 2, maxBytes: LIMITS.maxBytes })).rejects.toBeInstanceOf(SourceSnapshotTooLarge);
    await expect(ws.readModelSourceAtCommit(first, { maxFiles: 80, maxBytes: 20 })).rejects.toBeInstanceOf(SourceSnapshotTooLarge);
  });

  it('accepts only an exact 40-character SHA — never a branch, a ref expression or an abbreviation', async () => {
    for (const commit of ['HEAD', 'master', `${first.slice(0, 12)}`, `${first}^`, '--all']) {
      await expect(ws.readModelSourceAtCommit(commit, LIMITS)).rejects.toBeInstanceOf(CommitIdentityInvalid);
    }
  });
});

describe('commit ancestry', () => {
  it('proves a commit descends from another, or is it, and refuses anything else', async () => {
    expect(await ws.isAncestorCommit(first, second)).toBe(true);
    expect(await ws.isAncestorCommit(first, first)).toBe(true);
    expect(await ws.isAncestorCommit(second, first)).toBe(false);
    await expect(ws.isAncestorCommit('HEAD', second)).rejects.toBeInstanceOf(CommitIdentityInvalid);
  });
});
