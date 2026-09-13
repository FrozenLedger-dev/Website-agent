/**
 * Structural enforcement of the model-candidate write boundary.
 *
 * Every production path that lands model output — validation, the direct
 * build (and so a legacy replan rebuild), repair, and promotion — must reach
 * the file system only through `ProjectWorkspace.writeSiteFiles`, and that
 * method must check the whole candidate against the one shared ownership rule
 * before it writes anything.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('the model-candidate write boundary', () => {
  it('writeSiteFiles checks the whole candidate before its first write', async () => {
    const code = await src('packages/workspace/src/project-workspace.ts');
    const body = code.slice(code.indexOf('async writeSiteFiles('), code.indexOf('async readSiteFile('));
    expect(body.indexOf('assertModelWritableFiles(files);')).toBeGreaterThan(-1);
    expect(body.indexOf('assertModelWritableFiles(files);')).toBeLessThan(body.indexOf('writeFile('));
  });

  it('there is one ownership rule, and nothing normalises a path before it is decided', async () => {
    const code = await src('packages/workspace/src/site-build.ts');
    const rule = code.slice(code.indexOf('export function isModelWritable('), code.indexOf('export function assertModelWritable('));
    expect(rule).not.toMatch(/\.replace\(|normalize|resolve\(/);
    for (const file of await productionFiles('packages')) {
      if (file.endsWith('site-build.ts')) continue;
      expect(await src(file), file).not.toMatch(/WRITABLE_PREFIXES|function isModelWritable|function assertModelWritableFiles/);
    }
  });

  it('every production materialiser of model output goes through writeSiteFiles, and nothing else writes candidate files', async () => {
    const callers: string[] = [];
    for (const file of [...(await productionFiles('packages')), ...(await productionFiles('apps')), ...(await productionFiles('scripts'))]) {
      const code = await src(file);
      if (/\.writeSiteFiles\(/.test(code)) callers.push(relative(REPO, join(REPO, file)));
      if (!file.includes('packages/workspace/src/')) {
        // No other module turns generated file contents into files on disk.
        expect(code, file).not.toMatch(/writeFile\([^)]*\.contents/);
      }
    }
    expect(callers.sort()).toEqual([
      'packages/orchestrator/src/job-promotion/frontend-backend.ts',
      'packages/orchestrator/src/job-validation/frontend-backend.ts',
      'packages/orchestrator/src/phases/build.ts',
      'packages/orchestrator/src/phases/repair.ts',
      // Advisory measurement of a proposed build: a disposable workspace, the same boundary.
      'packages/orchestrator/src/tool-gateway/test-runner.ts',
    ]);
  });

  it('both replan rebuild paths end at the same boundary', async () => {
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    // job_lifecycle replan: the ordinary lifecycle, whose validator and promotion enforce the rule.
    expect(orchestrator).toMatch(/lifecycleCoordinator\.run\(successorSpec/);
    const lifecycle = await src('packages/orchestrator/src/job-lifecycle/frontend-backend.ts');
    expect(lifecycle).toMatch(/createFrontendBackendCandidateValidator\(/);
    expect(lifecycle).toMatch(/promoteAcceptedFrontendBackendCandidate\(/);
    // legacy_direct replan: buildFromPlan, which publishes through writeSiteFiles.
    expect(orchestrator).toMatch(/await buildFromPlan\(ctx\(\), revised\.plan\)/);
    const build = await src('packages/orchestrator/src/phases/build.ts');
    const buildFromPlan = build.slice(build.indexOf('export async function buildFromPlan('));
    expect(buildFromPlan).toMatch(/publishBuildDirectly\(/);
    expect(build).toMatch(/await deps\.workspace\.writeSiteFiles\(candidate\.files\)/);
  });

  it('validation and promotion refuse a forbidden candidate before any side effect', async () => {
    const validator = await src('packages/orchestrator/src/job-validation/frontend-backend.ts');
    expect(validator.indexOf('assertModelWritableFiles(candidate.files);')).toBeGreaterThan(-1);
    expect(validator.indexOf('assertModelWritableFiles(candidate.files);')).toBeLessThan(validator.indexOf('await mkdtemp('));

    const promotion = await src('packages/orchestrator/src/job-promotion/frontend-backend.ts');
    const check = promotion.indexOf('assertModelWritableFiles(candidate.files);');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(promotion.indexOf('acquirePromotionFence('));
    expect(check).toBeLessThan(promotion.indexOf('promotions.insertOne('));
  });
});
