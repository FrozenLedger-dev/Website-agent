/**
 * Deployment behaviour that does not need a network.
 *
 * The API call itself is not mocked — a fake Vercel proves only that the fake
 * was called. What is worth pinning here is everything that decides *what* gets
 * sent: the project name, whether a deploy is attempted at all, and the
 * text/binary split that would silently corrupt assets if it were wrong.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deploymentConfigured, deploySite, toProjectName } from '../src/deploy.js';
import { readExportFiles } from '../src/site-build.js';

describe('toProjectName', () => {
  it('lowercases and hyphenates a project id', () => {
    expect(toProjectName('proj_Harrowgate_Joinery_1fexy0')).toBe('proj-harrowgate-joinery-1fexy0');
  });

  it('does not leave leading or trailing hyphens', () => {
    // Vercel rejects these outright, which would fail the release rather than
    // the deploy — and long after the tokens were spent.
    expect(toProjectName('__weird__')).toBe('weird');
  });

  it('stays within Vercel’s 100-character limit', () => {
    expect(toProjectName('p'.repeat(200))).toHaveLength(100);
  });
});

describe('deploymentConfigured', () => {
  const original = process.env.VERCEL_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = original;
  });

  it('is false without a token, so a run releases to local preview', () => {
    delete process.env.VERCEL_TOKEN;
    expect(deploymentConfigured()).toBe(false);
  });

  it('is true once a token is present', () => {
    process.env.VERCEL_TOKEN = 'test-token';
    expect(deploymentConfigured()).toBe(true);
  });
});

describe('deploySite', () => {
  let siteRoot: string;

  beforeEach(async () => {
    siteRoot = await mkdtemp(join(tmpdir(), 'deploy-test-'));
  });
  afterEach(async () => {
    await rm(siteRoot, { recursive: true, force: true });
  });

  it('refuses to deploy an empty export rather than publishing nothing', async () => {
    process.env.VERCEL_TOKEN = 'test-token';
    await mkdir(join(siteRoot, 'out'), { recursive: true });

    // A build that failed after clearing out/ would otherwise publish a site
    // with no pages over one that worked.
    await expect(deploySite(siteRoot, 'proj_test')).rejects.toThrow(/export is empty/);
  });

  it('refuses without a token instead of failing inside the SDK', async () => {
    delete process.env.VERCEL_TOKEN;
    await expect(deploySite(siteRoot, 'proj_test')).rejects.toThrow(/VERCEL_TOKEN/);
  });
});

describe('readExportFiles', () => {
  let siteRoot: string;

  beforeEach(async () => {
    siteRoot = await mkdtemp(join(tmpdir(), 'export-test-'));
    await mkdir(join(siteRoot, 'out', '_next', 'static'), { recursive: true });
  });
  afterEach(async () => {
    await rm(siteRoot, { recursive: true, force: true });
  });

  it('marks source text as text and everything else as binary', async () => {
    await writeFile(join(siteRoot, 'out', 'index.html'), '<!doctype html>');
    await writeFile(join(siteRoot, 'out', '_next', 'static', 'app.css'), 'body{}');
    // A woff2 read as UTF-8 loses bytes to replacement characters and the font
    // arrives corrupt, which looks like a styling bug rather than a transport one.
    await writeFile(join(siteRoot, 'out', '_next', 'static', 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));

    const files = await readExportFiles(siteRoot);
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.get('index.html')?.binary).toBe(false);
    expect(byPath.get('_next/static/app.css')?.binary).toBe(false);
    expect(byPath.get('_next/static/font.woff2')?.binary).toBe(true);
  });

  it('returns paths relative to the export root with forward slashes', async () => {
    await writeFile(join(siteRoot, 'out', '_next', 'static', 'app.js'), 'void 0;');
    const files = await readExportFiles(siteRoot);
    expect(files.map((f) => f.path)).toContain('_next/static/app.js');
  });

  it('includes assets the gates ignore', async () => {
    // readBuiltFiles deliberately returns only html/css; a deployment that
    // reused it would publish a site with no JavaScript.
    await writeFile(join(siteRoot, 'out', 'index.html'), '<!doctype html>');
    await writeFile(join(siteRoot, 'out', '_next', 'static', 'app.js'), 'void 0;');

    const files = await readExportFiles(siteRoot);
    expect(files).toHaveLength(2);
  });
});
