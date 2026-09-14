/**
 * Structural enforcement of the browser render boundary.
 *
 * Generated client JavaScript is untrusted: production opens a generated site in
 * a browser only through the isolated `BrowserRenderer`, only from canonical
 * evaluation, and only as observation. The renderer holds no job, promotion,
 * release or model authority, is not a model tool, and takes screenshots only
 * inside its isolated runner.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Comments removed, strings kept. */
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', 'test', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionFiles(path)));
    else if (/\.(tsx?|mjs|cjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

async function allProductionFiles(): Promise<string[]> {
  const packages = await readdir(join(REPO, 'packages'));
  const dirs = [...packages.map((p) => `packages/${p}/src`), 'apps/console/app', 'apps/console/lib', 'scripts'];
  return (await Promise.all(dirs.map(productionFiles))).flat();
}

const RENDERER = 'packages/workspace/src/browser-renderer.ts';

/**
 * The renderer, split: the trusted runner source exactly as written, and the
 * harness code around it with comments stripped. Stripping the whole file would
 * read the runner's \`'**\/*'\` route glob as a comment opener and hide code.
 */
async function rendererParts(): Promise<{ raw: string; runner: string; outside: string }> {
  const raw = await readFile(join(REPO, RENDERER), 'utf8');
  const start = raw.indexOf('export const BROWSER_RUNNER_SOURCE = String.raw`');
  const end = raw.indexOf('`;\n', start) + 3;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return { raw, runner: raw.slice(start, end), outside: strip(raw.slice(0, start) + raw.slice(end)) };
}
const EVALUATE = 'packages/orchestrator/src/phases/evaluate.ts';

function body(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return code.slice(from, to);
}

describe('a generated site reaches a browser only through the BrowserRenderer', () => {
  it('no production module but the renderer drives a browser or names a browser runtime', async () => {
    const offenders: string[] = [];
    for (const file of await allProductionFiles()) {
      if (file === RENDERER) continue;
      if (/playwright|puppeteer|chromium|webdriver|selenium|BROWSER_IMAGE|BROWSER_RUNNER_SOURCE|browserCreateArgs/i.test(await src(file))) {
        offenders.push(file);
      }
    }
    // The report contract names the runtime version it records; nothing more.
    expect(offenders).toEqual(['packages/contracts/src/browser.ts']);
    expect(await src('packages/contracts/src/browser.ts')).not.toMatch(/import .*playwright|chromium|launch\(/i);
  });

  it('no package depends on a browser driver; only the trusted runtime manifest pins one', async () => {
    const manifests: string[] = [];
    for (const dir of [...(await readdir(join(REPO, 'packages'))).map((p) => `packages/${p}`), 'apps/console', '.']) {
      const text = await readFile(join(REPO, dir, 'package.json'), 'utf8').catch(() => '');
      if (/playwright|puppeteer|chromium/i.test(text)) manifests.push(dir);
    }
    expect(manifests).toEqual([]);
    const runtime = JSON.parse(await readFile(join(REPO, 'templates/browser-runtime/package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(runtime.dependencies).toEqual({ 'playwright-core': '1.63.0' });
  });

  it('the browser launches only inside the container runner, from a digest-pinned image, with no network', async () => {
    const { raw, runner, outside: renderer } = await rendererParts();
    expect(raw.match(/chromium\.launch\(/g)).toHaveLength(1);
    expect(runner).toContain('chromium.launch(');
    expect(renderer).toMatch(/export const BROWSER_IMAGE =\s*'mcr\.microsoft\.com\/playwright:v1\.63\.0-noble@sha256:[0-9a-f]{64}';/);
    const create = body(renderer, 'export function browserCreateArgs(', '\nfunction readonlyMount(');
    expect(create).toContain("'--network', 'none',");
    expect(create).toContain("'--read-only',");
    expect(create).toContain("'--cap-drop', 'ALL',");
    expect(create).toContain("'--env', 'HOME=/tmp',");
    expect(create).not.toMatch(/process\.env|--privileged|--volume|docker\.sock/);
    expect(renderer).toMatch(/return `type=bind,source=\$\{source\},target=\$\{target\},readonly`;/);
  });

  it('the renderer starts no process itself and forwards no environment', async () => {
    const { outside } = await rendererParts();
    expect(outside).not.toMatch(/child_process|\bexec(File|Sync)?\(|\bspawn\(|process\.env/);
    expect(outside).toMatch(/const created = await docker\(browserCreateArgs\(/);
    expect(outside).toMatch(/const attached = await attach\(name, runLimits, options\.signal\);/);
    expect(outside).toMatch(/if \(name !== null\) await removeContainer\(name\);/);
  });

  it('routes come only from the plan, through the route grammar', async () => {
    const { outside: renderer } = await rendererParts();
    const run = body(renderer, 'async function runBrowser(', '\nfunction parseRenders(');
    expect(run).toContain('const { targets, omittedRoutes } = planRenderTargets(options.plan);');
    const plan = body(renderer, 'export function planRenderTargets(', '\nexport function defaultBrowserRuntimeRoot(');
    expect(plan).toContain('const routes = plan.sitemap.pages.map((page) => page.route);');
    expect(plan).toContain('if (typeof route !== \'string\' || !ROUTE.test(route)) throw new BrowserRouteRefused(String(route));');
  });
});

describe('authority separation', () => {
  it('the renderer imports only Node built-ins, the contracts and the sandbox primitives', async () => {
    const { outside } = await rendererParts();
    const imports = [...outside.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.filter((name) => !name.startsWith('node:')).sort()).toEqual(['./sandbox.js', '@statxai/contracts', 'zod/v4']);
    expect(outside).not.toMatch(/JobEngine|StateStore|ArtifactRegistry|ModelRuntime|\.invoke\(|accept\w*Candidate|promot|releas|budget|lineage|job-engine|@statxai\/(state|agents|orchestrator)/i);
  });

  it('browser_preview is not a registered tool, and no tool adapter reaches the renderer', async () => {
    for (const file of await productionFiles('packages/orchestrator/src/tool-gateway')) {
      expect(await src(file), file).not.toMatch(/browser_preview|renderInBrowser|browser-renderer/);
    }
    const handler = await src('packages/orchestrator/src/job-handlers/frontend-backend.ts');
    expect(handler).toMatch(/FRONTEND_BACKEND_SUPPORTED_TOOLS: readonly ToolId\[\] = Object\.freeze\(\['filesystem', 'test_runner'\]\);/);
    for (const file of await productionFiles('packages/agents/src')) {
      expect(await src(file), file).not.toMatch(/browser_preview|renderInBrowser/);
    }
  });

  it('a screenshot is taken only inside the isolated runner, and no production code makes a PDF or a video', async () => {
    const taking: string[] = [];
    for (const file of await allProductionFiles()) {
      // Raw source: the runner's own \`'**/*'\` route glob would read as a comment opener to the stripper.
      const code = await readFile(join(REPO, file), 'utf8');
      expect(code, file).not.toMatch(/\.pdf\(|recordVideo/);
      if (/\.screenshot\(/.test(code)) taking.push(file);
    }
    expect(taking).toEqual([RENDERER]);
    const { raw, runner, outside } = await rendererParts();
    expect(raw.match(/\.screenshot\(/g)).toHaveLength(1);
    expect(runner).toContain('page.screenshot(');
    expect(outside).not.toContain('screenshot(');
  });
});

describe('canonical evaluation renders the exact build it evaluates', () => {
  it('evaluateSite renders after the deterministic gates and before review, bound to the exact subject', async () => {
    const evaluate = await src(EVALUATE);
    const site = body(evaluate, 'export async function evaluateSite(', '\nfunction firstErrors(');
    const order = ['await runDeterministicGates(deps.workspace.siteRoot', 'await captureInBrowser({', 'await persistScreenshotSet({', 'await reviewSite('].map((m) => site.indexOf(m));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const render = site.slice(site.indexOf('await captureInBrowser({'), site.indexOf('const browserRender = '));
    expect(render).toContain('exportDir: compiled.outDir,');
    expect(render).toContain('plan: progress.plan,');
    expect(render).toContain('projectId: facts.projectId,');
    expect(render).toContain('sitePlan: subject.sitePlan,');
    expect(render).toContain('sourceCommit: await deps.workspace.currentCommit(),');
    expect(render).toContain('authority: subject.authority,');
    expect(site).toMatch(/const captured = compiled\.ok\s*\?\s*await captureInBrowser\(/);
    // Evidence only: browser findings do not become defects in this slice.
    expect(site.slice(site.indexOf('const gateDefects'))).not.toMatch(/browserRender\.(renders|findings)/);
  });

  it('evaluateSite is the only production caller, and runProject hands it the exact plan version and authority', async () => {
    const callers: string[] = [];
    for (const file of await allProductionFiles()) {
      if (/(renderInBrowser|captureInBrowser)\(/.test(await src(file)) && file !== RENDERER) callers.push(file);
    }
    expect(callers).toEqual([EVALUATE]);

    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator.match(/await evaluateSite\(/g)).toHaveLength(1);
    expect(orchestrator).toMatch(/await evaluateSite\(ctx\(\), \{\s*sitePlan: currentSitePlanRef,[\s\S]{0,300}editableSiteModel: [^\n]*canonicalBuild\?\.jobSpec\.inputs\[FRONTEND_BACKEND_INPUT\.editableSiteModel\][^\n]*,\s*authority: renderAuthority\(\),\s*\}\)/);
    expect(orchestrator).toContain('let currentSitePlanRef: ArtifactRef = initialSitePlanRef;');
    expect(orchestrator).toMatch(/progress\.plan = revised\.plan;\s*currentSitePlanRef = revised\.sitePlanRef;/);
    const authority = body(orchestrator, 'const renderAuthority = (): BrowserRenderAuthority => {', '\n  };');
    expect(authority).toContain("if (frontendBackendExecutionMode !== 'job_lifecycle') return { mode: 'legacy_direct' };");
    expect(authority).toContain('buildBindingId: canonicalBuild._id,');
    // The initial promotion, the replan rebuild, the visual refinement, and 5q recovery.
    expect(orchestrator.match(/canonicalPromotion = \{/g)).toHaveLength(4);
  });
});

describe('durable screenshot evidence', () => {
  const EVIDENCE = 'packages/workspace/src/screenshot-evidence.ts';
  const BLOBS = 'packages/workspace/src/blob-store.ts';

  it('holds no model, job, promotion or release authority', async () => {
    for (const file of [EVIDENCE, BLOBS]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/ModelRuntime|\.invoke\(|@statxai\/(agents|job-engine|orchestrator)|JobEngine|accept\w*Candidate|promot|releas|lineage|budget/i);
    }
    const imports = [...(await src(EVIDENCE)).matchAll(/from '([^']+)'/g)].map((m) => m[1]!).sort();
    expect(imports).toEqual(['./blob-store.js', './browser-renderer.js', './registry.js', '@statxai/contracts', 'node:crypto']);
  });

  it('never looks screenshot evidence up by name: the set is written, and its exact ref returned', async () => {
    const evidence = await src(EVIDENCE);
    expect(evidence.match(/registry\.\w+\(/g)).toEqual(['registry.put(']);
    expect(evidence).toContain('return { ref, set };');
    const offenders: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      // Build-successor identity may name the artifact a ref must be; it looks nothing up.
      if (file !== EVIDENCE && file !== 'packages/contracts/src/build-lineage.ts' && /screenshot-set|SCREENSHOT_SET_ARTIFACT/.test(code)) offenders.push(file);
      // The collection itself is touched only by the blob store, which verifies every write and read.
      if (file !== BLOBS && /\bstore\.blobs\b|collection\(['"]blobs['"]\)/.test(code) && file !== 'packages/state/src/store.ts') offenders.push(`${file} (blobs)`);
    }
    expect(offenders).toEqual([]);
  });

  it('images are stored before the one set that names them, and a mismatched store is never claimed', async () => {
    const evidence = await src(EVIDENCE);
    const persist = body(evidence, 'export async function persistScreenshotSet(', '\n}\n');
    expect(persist.indexOf('await input.blobs.put(')).toBeGreaterThan(-1);
    expect(persist.indexOf('await input.blobs.put(')).toBeLessThan(persist.indexOf('await input.registry.put('));
    expect(persist.match(/await input\.registry\.put\(/g)).toHaveLength(1);
    expect(persist).toContain("if (stored.sha256 !== sha256 || stored.bytes !== capture.png.length) throw new Error(");
    expect(persist).toMatch(/complete: captures\.length > 0 && capturedCount === captures\.length && report\.status === 'completed',/);
  });

  it('evaluateSite captures, persists, and returns the exact screenshot-set reference', async () => {
    const evaluate = await src(EVALUATE);
    const site = body(evaluate, 'export async function evaluateSite(', '\nfunction firstErrors(');
    expect(site).toContain('await persistScreenshotSet({ registry: deps.registry, blobs: new BlobStore(deps.store), projectId: facts.projectId, outcome: captured })');
    expect(site).toContain('screenshotSet: screenshots?.ref ?? null,');
    expect(site).not.toMatch(/registry\.(get|latest)\(/);
  });

  it('no tool adapter reaches screenshots; no model skill reaches capture or blob storage, and only terra-review and terra-refine see screenshots', async () => {
    for (const file of await productionFiles('packages/orchestrator/src/tool-gateway')) {
      expect(await src(file), file).not.toMatch(/screenshot|captureInBrowser|BlobStore|blobs/i);
    }
    const seeing: string[] = [];
    for (const file of await productionFiles('packages/agents/src')) {
      const code = await src(file);
      expect(code, file).not.toMatch(/captureInBrowser|BlobStore|\bblobs\b|@statxai\/workspace/);
      if (/screenshot/i.test(code)) seeing.push(file);
    }
    // The reviewer judges screenshots; the refiner is shown the same ones. Neither can read or capture any.
    expect(seeing.sort()).toEqual(['packages/agents/src/skills/terra-refine.ts', 'packages/agents/src/skills/terra-review.ts']);
  });
});
