/**
 * Structural enforcement of the browser render boundary.
 *
 * Generated client JavaScript is untrusted: production opens a generated site in
 * a browser only through the isolated `BrowserRenderer`, only from canonical
 * evaluation, and only as observation. The renderer holds no job, promotion,
 * release or model authority, is not a model tool, and captures no screenshot.
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
    const renderer = await src(RENDERER);
    expect(renderer.match(/chromium\.launch\(/g)).toHaveLength(1);
    expect(renderer.indexOf('chromium.launch(')).toBeGreaterThan(renderer.indexOf('export const BROWSER_RUNNER_SOURCE = String.raw`'));
    expect(renderer.indexOf('chromium.launch(')).toBeLessThan(renderer.indexOf('export function defaultBrowserRuntimeRoot('));
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
    const renderer = await src(RENDERER);
    const outside = renderer.replace(/export const BROWSER_RUNNER_SOURCE = String\.raw`[\s\S]*?`;/, '');
    expect(outside).not.toMatch(/child_process|\bexec(File|Sync)?\(|\bspawn\(|process\.env/);
    expect(outside).toMatch(/const created = await docker\(browserCreateArgs\(/);
    expect(outside).toMatch(/const attached = await attach\(name, runLimits, options\.signal\);/);
    expect(outside).toMatch(/if \(name !== null\) await removeContainer\(name\);/);
  });

  it('routes come only from the plan, through the route grammar', async () => {
    const renderer = await src(RENDERER);
    const run = body(renderer, 'export async function renderInBrowser(', '\nfunction parseRenders(');
    expect(run).toContain('const { targets, omittedRoutes } = planRenderTargets(options.plan);');
    const plan = body(renderer, 'export function planRenderTargets(', '\nexport const BROWSER_RUNNER_SOURCE');
    expect(plan).toContain('const routes = plan.sitemap.pages.map((page) => page.route);');
    expect(plan).toContain('if (typeof route !== \'string\' || !ROUTE.test(route)) throw new BrowserRouteRefused(String(route));');
  });
});

describe('authority separation', () => {
  it('the renderer imports only Node built-ins, the contracts and the sandbox primitives', async () => {
    const renderer = await src(RENDERER);
    const outside = renderer.replace(/export const BROWSER_RUNNER_SOURCE = String\.raw`[\s\S]*?`;/, '');
    const imports = [...outside.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.filter((name) => !name.startsWith('node:')).sort()).toEqual(['./sandbox.js', '@statxai/contracts']);
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

  it('no production code captures a screenshot, a PDF or a video yet', async () => {
    for (const file of await allProductionFiles()) {
      expect(await src(file), file).not.toMatch(/\.screenshot\(|\.pdf\(|recordVideo|toBuffer\(\)\s*;?\s*\/\/\s*screenshot/);
    }
  });
});

describe('canonical evaluation renders the exact build it evaluates', () => {
  it('evaluateSite renders after the deterministic gates and before review, bound to the exact subject', async () => {
    const evaluate = await src(EVALUATE);
    const site = body(evaluate, 'export async function evaluateSite(', '\nfunction firstErrors(');
    const order = ['await runDeterministicGates(deps.workspace.siteRoot', 'await renderInBrowser({', 'await reviewSite('].map((m) => site.indexOf(m));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const render = site.slice(site.indexOf('await renderInBrowser({'), site.indexOf('  if (browserRender) {'));
    expect(render).toContain('exportDir: compiled.outDir,');
    expect(render).toContain('plan: progress.plan,');
    expect(render).toContain('projectId: facts.projectId,');
    expect(render).toContain('sitePlan: subject.sitePlan,');
    expect(render).toContain('sourceCommit: await deps.workspace.currentCommit(),');
    expect(render).toContain('authority: subject.authority,');
    expect(site).toMatch(/const browserRender = compiled\.ok\s*\?\s*await renderInBrowser\(/);
    // Evidence only: browser findings do not become defects in this slice.
    expect(site.slice(site.indexOf('const gateDefects'))).not.toMatch(/browserRender\.(renders|findings)/);
  });

  it('evaluateSite is the only production caller, and runProject hands it the exact plan version and authority', async () => {
    const callers: string[] = [];
    for (const file of await allProductionFiles()) {
      if (/renderInBrowser\(/.test(await src(file)) && file !== RENDERER) callers.push(file);
    }
    expect(callers).toEqual([EVALUATE]);

    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator.match(/await evaluateSite\(/g)).toHaveLength(1);
    expect(orchestrator).toContain('await evaluateSite(ctx(), { sitePlan: currentSitePlanRef, authority: renderAuthority() })');
    expect(orchestrator).toContain('let currentSitePlanRef: ArtifactRef = initialSitePlanRef;');
    expect(orchestrator).toMatch(/progress\.plan = revised\.plan;\s*currentSitePlanRef = revised\.sitePlanRef;/);
    const authority = body(orchestrator, 'const renderAuthority = (): BrowserRenderAuthority => {', '\n  };');
    expect(authority).toContain("if (frontendBackendExecutionMode !== 'job_lifecycle') return { mode: 'legacy_direct' };");
    expect(authority).toContain('buildBindingId: canonicalBuild._id,');
    expect(orchestrator.match(/canonicalPromotion = \{/g)).toHaveLength(3);
  });
});
