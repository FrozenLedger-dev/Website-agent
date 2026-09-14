/**
 * Structural enforcement of immutable site export snapshots.
 *
 * One export digest, computed in one place. Snapshots are captured only by the
 * authoritative evaluation, bound to the exact build, stored as blobs named by a
 * manifest, read by exact ref only, and resolved against the manifest — never a
 * filesystem. A draft records the exact snapshot its caller hands it. No customer
 * preview route or edit worker exists yet.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));
const SNAPSHOT = 'packages/workspace/src/site-export.ts';
const DIGEST = 'packages/workspace/src/export-digest.ts';

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', 'test', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}
async function allProductionFiles(): Promise<string[]> {
  const packages = await readdir(join(REPO, 'packages'));
  return (await Promise.all([...packages.map((p) => `packages/${p}/src`), 'apps/console/app', 'apps/console/lib', 'apps/customer/app', 'apps/customer/lib', 'scripts'].map(productionFiles))).flat();
}
function body(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return code.slice(from, to);
}

describe('one export digest', () => {
  it('is computed in exactly one pure module, and every export digest goes through it', async () => {
    const digest = await src(DIGEST);
    expect([...digest.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['node:crypto']);
    for (const file of await allProductionFiles()) {
      if (file === DIGEST) continue;
      // No second digest: nothing else hashes export entries as `path \0 hash`.
      expect(await src(file), file).not.toMatch(/digest\.update\(`\$\{[^}]*\}\\0\$\{[^}]*\}\\n`\)/);
    }
    for (const file of ['packages/workspace/src/site-build.ts', 'packages/workspace/src/browser-renderer.ts', SNAPSHOT]) {
      expect(await src(file), file).toMatch(/exportDigestOf\(/);
    }
    const build = await src('packages/workspace/src/site-build.ts');
    expect(body(build, 'async function collectExport(', '\n}\n')).toMatch(/return \{ files, digest: exportDigestOf\(written\) \};/);
  });

  it('evaluation renders the captured bytes, and refuses a render whose digest is not the snapshot digest', async () => {
    const evaluate = await src('packages/orchestrator/src/phases/evaluate.ts');
    const site = body(evaluate, 'export async function evaluateSite(', '\nfunction firstErrors(');
    const captureAt = site.indexOf('exportSnapshot = await captureSiteExportSnapshot({');
    const expected = site.indexOf('expectedExportDigest: compiled.exportDigest,');
    const materialised = site.indexOf('await materializeSiteExport(exportSnapshot.files, privateExport);');
    const render = site.indexOf('await captureInBrowser({');
    const fence = site.indexOf('captured.report.subject.exportDigest !== exportSnapshot.snapshot.exportDigest');
    const screenshots = site.indexOf('await persistScreenshotSet({');
    for (const at of [captureAt, expected, materialised, render, fence, screenshots]) expect(at).toBeGreaterThan(-1);
    expect(captureAt).toBeLessThan(materialised);
    expect(materialised).toBeLessThan(render);
    expect(render).toBeLessThan(fence);
    expect(fence).toBeLessThan(screenshots);
    expect(site).toMatch(/throw new EvaluationSiteExportMismatch/);
  });
});

describe('snapshots are build-bound, blob-backed and exact', () => {
  it('only the authoritative evaluation captures one, bound to the exact build authority and model', async () => {
    const callers: string[] = [];
    for (const file of await allProductionFiles()) {
      if (/captureSiteExportSnapshot\(/.test(await src(file)) && file !== SNAPSHOT) callers.push(file);
    }
    expect(callers).toEqual(['packages/orchestrator/src/phases/evaluate.ts']);
    const evaluate = await src('packages/orchestrator/src/phases/evaluate.ts');
    expect(evaluate).toContain('subject: { projectId: facts.projectId, sitePlan: subject.sitePlan, sourceCommit, authority: subject.authority, editableSiteModel: subject.editableSiteModel },');
    for (const file of ['packages/orchestrator/src/job-validation/frontend-backend.ts', 'packages/orchestrator/src/tool-gateway/test-runner.ts', 'packages/orchestrator/src/job-handlers/frontend-backend.ts']) {
      expect(await src(file), file).not.toMatch(/captureSiteExportSnapshot|site-export-snapshot/);
    }
  });

  it('the manifest names blobs and never carries bytes; the blob store is the only binary authority', async () => {
    const contract = await src('packages/contracts/src/site-export.ts');
    const file = body(contract, 'export const SiteExportFile = z.strictObject({', '});');
    expect(file.match(/^\s{2}(\w+):/gm)?.map((m) => m.trim())).toEqual(['path:', 'blob:', 'sha256:', 'bytes:']);
    expect(contract).not.toMatch(/contents|base64|data:/);
    const snapshot = await src(SNAPSHOT);
    expect(body(snapshot, 'export async function captureSiteExportSnapshot(', '\n}\n')).toMatch(/input\.blobs\.put\(file\.bytes, SITE_EXPORT_BLOB_CONTENT_TYPE\)[\s\S]*input\.registry\.put\(input\.projectId, SITE_EXPORT_SNAPSHOT_ARTIFACT, snapshot\)/);
    expect(snapshot).not.toMatch(/toString\('base64'\)|Buffer\.from\([^)]*'base64'/);
  });

  it('reading takes an exact ref only, re-proves the manifest and every blob, and never looks anything up by recency or path on disk', async () => {
    const snapshot = await src(SNAPSHOT);
    const read = body(snapshot, 'export async function readSiteExportSnapshot(', '\n}\n');
    expect(read).toMatch(/if \(!ref\.contentHash\) throw new SiteExportSnapshotInvalid/);
    expect(read).toMatch(/registry\.getDocument\(projectId, ref\)/);
    expect(read).toMatch(/if \(doc\.contentHash !== ref\.contentHash\)/);
    expect(read).toMatch(/if \(exportDigestOf\(parsed\.data\.files\) !== parsed\.data\.exportDigest\)/);
    const file = body(snapshot, 'export async function readSiteExportFile(', '\n}\n');
    expect(file).toMatch(/blobs\.get\(file\.blob\)/);
    expect(file).toMatch(/sha256Of\(bytes\) !== file\.sha256/);
    for (const fn of [read, file, body(snapshot, 'export async function resolveSiteExportRequest(', '\n}\n'), body(snapshot, 'export function normalizeSiteExportRequest(', '\n}\n')]) {
      expect(fn).not.toMatch(/readFile|readdir|lstat|stat\(|workspacesRoot|siteRoot|app\/out|\.sort\(|registry\.get\(|latest/);
    }
  });
});

describe('drafts name exact snapshots', () => {
  it('conclusion records exactly the ref its caller supplies, after proving it is of the build, and never finds one itself', async () => {
    const authority = await src('packages/orchestrator/src/canonical-draft/authority.ts');
    const conclude = body(authority, 'export async function concludeCanonicalDraft', '\n}\n');
    expect(conclude).toMatch(/readSiteExportSnapshot\(input\.registry, projectId, input\.siteExportSnapshot\)/);
    expect(conclude).toMatch(/subject\.authority\.buildBindingId !== canonicalBindingId/);
    expect(conclude).toMatch(/subject\.authority\.promotionId !== promotionId/);
    expect(conclude).toMatch(/siteExportSnapshot: snapshotRef, status: 'available'/);
    expect(authority).not.toMatch(/'site-export-snapshot'|SITE_EXPORT_SNAPSHOT_ARTIFACT|artifacts\.find|\.sort\(/);
  });

  it('the draft run and the semantic edit hand over exactly the snapshot their evaluation captured or recorded', async () => {
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator).toContain('return concludeDraftRun(evaluation.siteExportSnapshot, evaluation.siteExportSnapshotRefusal);');
    const apply = await src('packages/orchestrator/src/semantic-edit/apply.ts');
    expect(apply).toContain('siteExportSnapshot: evaluation.siteExportSnapshot,');
    expect(apply).toContain('siteExportSnapshot: intent.evaluation.siteExportSnapshot,');
    for (const file of ['packages/orchestrator/src/orchestrator.ts', 'packages/orchestrator/src/semantic-edit/apply.ts']) {
      expect(await src(file), file).not.toMatch(/'site-export-snapshot'|SITE_EXPORT_SNAPSHOT_ARTIFACT/);
    }
  });
});

describe('scope', () => {
  it('the customer preview serves only exact snapshots through the customer editor; the mutable export is served only by the operator console', async () => {
    const customer = (await productionFiles('apps/customer/app')).filter((f) => /route\.ts$|page\.tsx$/.test(f)).sort();
    expect(customer).toEqual([
      'apps/customer/app/api/auth/callback/route.ts',
      'apps/customer/app/api/auth/login/route.ts',
      'apps/customer/app/api/auth/logout/route.ts',
      'apps/customer/app/api/auth/me/route.ts',
      'apps/customer/app/api/projects/[projectId]/editor/route.ts',
      'apps/customer/app/api/projects/[projectId]/edits/[intentId]/route.ts',
      'apps/customer/app/api/projects/[projectId]/edits/route.ts',
      'apps/customer/app/api/projects/[projectId]/preview/[draftId]/[[...route]]/route.ts',
      'apps/customer/app/api/projects/route.ts',
      'apps/customer/app/page.tsx',
      'apps/customer/app/projects/[projectId]/editor/page.tsx',
      'apps/customer/app/projects/page.tsx',
    ]);
    for (const file of [...(await productionFiles('apps/customer/app')), ...(await productionFiles('apps/customer/lib')), ...(await productionFiles('packages/customer-auth/src'))]) {
      expect(await src(file), file).not.toMatch(/readSiteExport|resolveSiteExportRequest|app\/out|resumeSemanticEdit|applySemanticEdit/);
    }
    const servers: string[] = [];
    for (const file of await allProductionFiles()) if (/'app', 'out'|app\/out/.test(await src(file))) servers.push(file);
    // The operator console's preview route and the operator preview script — never a customer surface.
    expect(servers.sort()).toEqual(['apps/console/app/api/preview/[projectId]/[[...path]]/route.ts', 'scripts/preview.ts']);
    // The customer preview reads the exact snapshot a draft names, and only there.
    const snapshotReaders: string[] = [];
    for (const file of await productionFiles('packages/customer-editor/src')) if (/readSiteExportSnapshot\(|readSiteExportFile\(|resolveSiteExportRequest\(/.test(await src(file))) snapshotReaders.push(file);
    expect(snapshotReaders.sort()).toEqual(['packages/customer-editor/src/editor-state.ts', 'packages/customer-editor/src/http.ts']);
    for (const file of await allProductionFiles()) {
      if (file === 'packages/orchestrator/src/semantic-edit/apply.ts') continue;
      expect(await src(file), file).not.toMatch(/resumeSemanticEdit\(/);
    }
  });
});
