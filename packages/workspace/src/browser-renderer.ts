/**
 * The browser renderer: an exact static export, rendered route by route in real
 * Chromium, inside a disposable container.
 *
 * A generated site's client JavaScript is untrusted code exactly as its build
 * is, so it never runs in a browser on the host. One container holds a trusted
 * static server and Chromium together:
 *
 * - **Filesystem** — a snapshot of the export mounted read-only at `/site`, the
 *   trusted Playwright client (installed from `templates/browser-runtime`'s own
 *   lockfile) read-only, and this run's trusted runner and job read-only. A
 *   read-only root, size-capped `/tmp` and `/dev/shm`. Nothing else of the host.
 * - **Network** — `--network none`: loopback only. The server and browser share
 *   it; nothing else is reachable, and every request for another origin is also
 *   refused in the browser and recorded.
 * - **Environment** — `HOME=/tmp` and nothing from the harness.
 * - **Privileges and limits** — non-root, every capability dropped,
 *   `no-new-privileges`, explicit memory, CPU, PID and wall-clock limits.
 *   Chromium's own sandbox needs user namespaces the hardened container denies,
 *   so it is off: the container is the boundary, not Chromium.
 * - **Cancellation** — timeout and abort kill the container, and with it the
 *   browser, the server and every descendant.
 *
 * Routes come only from the plan being evaluated, checked against the route
 * grammar and addressed at the one trusted local origin; there is no way to ask
 * for another URL. Each route renders at every viewport under one readiness
 * contract ({@link RENDER_READINESS}), and what happened comes back as a bounded,
 * sanitized {@link BrowserRenderReport} naming the exact subject rendered.
 *
 * Observation only: this module renders nothing it was not given and decides
 * nothing — no job, acceptance, promotion, release or project state, no model,
 * and no screenshot.
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOCKING_BROWSER_FINDINGS,
  BrowserRouteRender,
  type BrowserFinding,
  type BrowserRenderReport,
  type BrowserRenderSubject,
  type BrowserViewport,
  type SitePlan,
} from '@statxai/contracts';
import {
  SANDBOX_LABEL,
  SandboxUnavailable,
  attach,
  docker,
  prepareTrustedDependencies,
  removeContainer,
  sandboxUser,
  sanitizeSandboxOutput,
  type SandboxLimits,
} from './sandbox.js';

/** Pinned by digest, and matched to the Playwright client below (Chromium build 1243). */
export const BROWSER_IMAGE =
  'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27';
export const PLAYWRIGHT_VERSION = '1.63.0';

/**
 * The viewports every route renders at — the one policy the screenshot phase
 * will inherit. A common laptop, a portrait tablet, and a modern phone.
 */
export const BROWSER_VIEWPORTS: readonly BrowserViewport[] = Object.freeze([
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: 'tablet', width: 768, height: 1024, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
]);

/**
 * When a rendered page counts as ready: the `load` event (not `networkidle`,
 * which a polling page never reaches), then web fonts settled, then two
 * animation frames painted, then a short settle — each step bounded, so a page
 * that never becomes ready is reported as such rather than waited on.
 */
export interface RenderReadiness {
  readonly navigationTimeoutMs: number;
  readonly fontsTimeoutMs: number;
  readonly animationFrames: number;
  readonly settleMs: number;
  readonly readyTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

export const RENDER_READINESS: RenderReadiness = Object.freeze({
  navigationTimeoutMs: 20_000,
  fontsTimeoutMs: 5_000,
  animationFrames: 2,
  settleMs: 250,
  readyTimeoutMs: 10_000,
  closeTimeoutMs: 5_000,
});

export interface BrowserLimits {
  readonly memoryBytes: number;
  readonly cpus: number;
  readonly pids: number;
  readonly tmpBytes: number;
  readonly shmBytes: number;
  /** Browser launch and server start, before the first route. */
  readonly startupMs: number;
  /** The whole run, however many targets — the hard wall clock. */
  readonly maxRunMs: number;
  readonly outputBytes: number;
}

export const BROWSER_LIMITS: BrowserLimits = Object.freeze({
  // Chromium with one context open at a time stays well under this; a page
  // allocating without bound does not.
  memoryBytes: 2 * 1024 ** 3,
  cpus: 2,
  pids: 512,
  tmpBytes: 512 * 1024 ** 2,
  shmBytes: 512 * 1024 ** 2,
  startupMs: 60_000,
  maxRunMs: 15 * 60 * 1000,
  outputBytes: 4 * 1024 ** 2,
});

/** Routes rendered per run, in plan order with the homepage first. The rest are reported as omitted. */
export const MAX_RENDER_ROUTES = 24;

export const BROWSER_REPORT_BOUNDS = Object.freeze({
  maxFindingsPerCategory: 10,
  maxDetailChars: 500,
  maxReportBytes: 256_000,
});

/** The one local origin the server listens on inside the container. */
export const BROWSER_ORIGIN_PORT = 4173;

/** The route grammar a plan's `PageSpec.route` already obeys, enforced again here. */
const ROUTE = /^\/([a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*)?$/;

export class BrowserRouteRefused extends Error {
  constructor(readonly route: string) {
    super(`Refusing to render "${route}": only planned site routes under the local origin are rendered`);
    this.name = 'BrowserRouteRefused';
  }
}

export interface RenderTarget {
  readonly route: string;
  readonly viewport: BrowserViewport;
}

/**
 * Every (route, viewport) the plan asks for, in a fixed order: routes in plan
 * order with the homepage first, each at every viewport. A route that is not a
 * plain site path — an absolute URL, `//host`, `javascript:`, `file:`, a port —
 * is refused before anything runs.
 */
export function planRenderTargets(
  plan: Pick<SitePlan, 'sitemap'>,
  viewports: readonly BrowserViewport[] = BROWSER_VIEWPORTS,
): { targets: RenderTarget[]; omittedRoutes: string[] } {
  const routes = plan.sitemap.pages.map((page) => page.route);
  for (const route of routes) {
    if (typeof route !== 'string' || !ROUTE.test(route)) throw new BrowserRouteRefused(String(route));
  }
  const ordered = [...routes.filter((r) => r === '/'), ...routes.filter((r) => r !== '/')];
  const rendered = ordered.slice(0, MAX_RENDER_ROUTES);
  return {
    targets: rendered.flatMap((route) => viewports.map((viewport) => ({ route, viewport }))),
    omittedRoutes: ordered.slice(MAX_RENDER_ROUTES),
  };
}

/**
 * The trusted in-container runner: the static server and the Playwright
 * session. Harness code — nothing in it is model- or site-supplied; the site is
 * only ever the thing served and rendered.
 */
export const BROWSER_RUNNER_SOURCE = String.raw`
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const job = JSON.parse(readFileSync('/runner/app/job.json', 'utf8'));
const SITE = '/site';
const ORIGIN = 'http://127.0.0.1:' + job.port;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml' };
const emit = (value) => process.stdout.write('@@render ' + JSON.stringify(value) + '\n');
// A page cannot take the runner down with it: a stray error in an event is not a crash.
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
// Every page event handler runs guarded, so hostile page behaviour becomes a finding, never a lost render.
const guarded = (handler) => (...args) => { try { const result = handler(...args); if (result && typeof result.catch === 'function') result.catch(() => {}); return result; } catch { return undefined; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function kind(rel) {
  try {
    const info = statSync(join(SITE, rel));
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : null;
  } catch {
    return null;
  }
}

// Clean URLs the way the export is deployed: "/services" is services.html.
function resolvePath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const path = segments.join('/');
  if (path === '') return kind('index.html') === 'file' ? 'index.html' : null;
  const direct = kind(path);
  if (direct === 'file') return path;
  if (!extname(path) && kind(path + '.html') === 'file') return path + '.html';
  if (direct === 'directory' && kind(path + '/index.html') === 'file') return path + '/index.html';
  return null;
}

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
  const rel = resolvePath(new URL(request.url || '/', ORIGIN).pathname);
  const full = rel === null ? null : realpathSync(join(SITE, rel));
  if (full === null || !full.startsWith(SITE + '/')) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('not found'); return; }
  const body = readFileSync(full);
  response.writeHead(200, { 'content-type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
  response.end(request.method === 'HEAD' ? undefined : body);
});
await new Promise((resolve) => server.listen(job.port, '127.0.0.1', resolve));

const browser = await chromium.launch({
  chromiumSandbox: false,
  timeout: job.startupMs,
  args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--disable-domain-reliability', '--dns-prefetch-disable', '--disable-features=Translate,MediaRouter,OptimizationHints'],
});
emit({ ready: true });

async function readiness({ fontsTimeoutMs, animationFrames, settleMs }) {
  await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, fontsTimeoutMs))]);
  for (let i = 0; i < animationFrames; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, settleMs));
}

const firstLine = (text) => String(text || '').split('\n')[0];
const shown = (url) => url.protocol + '//' + url.host + url.pathname;

for (const target of job.targets) {
  const findings = [];
  const counts = {};
  const add = (category, detail) => {
    counts[category] = (counts[category] || 0) + 1;
    if (counts[category] <= job.bounds.maxFindingsPerCategory) {
      const text = firstLine(detail);
      findings.push({ category, route: target.route, viewport: target.viewport.name, detail: text.length > job.bounds.maxDetailChars ? text.slice(0, job.bounds.maxDetailChars - 1) + '…' : text });
    }
  };
  const targetUrl = new URL(target.route, ORIGIN);
  if (targetUrl.origin !== ORIGIN || targetUrl.pathname !== target.route) {
    add('navigation_failed', 'refused: not a local site route');
    emit({ route: target.route, viewport: target.viewport.name, status: 'failed', httpStatus: null, navigationMs: null, readyMs: null, findings });
    continue;
  }

  const { name, width, height, ...device } = target.viewport;
  const context = await browser.newContext({
    viewport: { width, height },
    ...device,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    acceptDownloads: false,
    locale: 'en-GB',
    timezoneId: 'UTC',
    colorScheme: 'light',
  });
  const page = await context.newPage();

  await context.route('**/*', (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { add('external_request_blocked', 'unparseable URL'); return route.abort('blockedbyclient').catch(() => {}); }
    if (url.origin === ORIGIN) return route.continue().catch(() => {});
    // A popup's first navigation has no frame yet; only the rendered page's own main frame is a navigation away.
    let mainFrame = false;
    try { mainFrame = request.isNavigationRequest() && request.frame() === page.mainFrame(); } catch { mainFrame = false; }
    add(mainFrame ? 'unexpected_navigation' : 'external_request_blocked', shown(url));
    return route.abort('blockedbyclient').catch(() => {});
  });
  // Popups are never rendered: whatever they requested is already recorded above.
  context.on('page', guarded((popup) => { if (popup !== page) popup.close().catch(() => {}); }));
  page.on('pageerror', guarded((error) => add('runtime_exception', error && error.message ? error.message : String(error))));
  page.on('console', guarded((message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The request itself is already recorded, with its URL.
    if (text.startsWith('Failed to load resource')) return;
    add('console_error', text);
  }));
  page.on('response', guarded((response) => {
    const url = new URL(response.url());
    if (url.origin === ORIGIN && response.status() >= 400 && url.href !== targetUrl.href) add('local_resource_failed', response.status() + ' ' + url.pathname);
  }));
  page.on('requestfailed', guarded((request) => {
    const url = new URL(request.url());
    if (url.origin === ORIGIN) add('local_resource_failed', firstLine(request.failure() && request.failure().errorText) + ' ' + url.pathname);
  }));
  page.on('framenavigated', guarded((frame) => {
    if (frame !== page.mainFrame() || frame.url() === 'about:blank') return;
    const url = new URL(frame.url());
    if (url.origin !== ORIGIN || url.pathname !== targetUrl.pathname) add('unexpected_navigation', url.origin === ORIGIN ? url.pathname : shown(url));
  }));

  let status = 'rendered';
  let httpStatus = null;
  let navigationMs = null;
  let readyMs = null;
  const started = Date.now();
  try {
    const response = await page.goto(targetUrl.href, { waitUntil: 'load', timeout: job.readiness.navigationTimeoutMs });
    navigationMs = Date.now() - started;
    httpStatus = response ? response.status() : null;
    if (!response) { status = 'failed'; add('navigation_failed', 'no response'); }
    else if (httpStatus >= 400) { status = 'failed'; add('http_error', 'HTTP ' + httpStatus); }
  } catch (error) {
    const timedOut = error && error.name === 'TimeoutError';
    status = timedOut ? 'timed_out' : 'failed';
    add(timedOut ? 'readiness_timeout' : 'navigation_failed', error && error.message);
  }

  if (status === 'rendered') {
    const readyStarted = Date.now();
    const outcome = await Promise.race([
      page.evaluate(readiness, job.readiness).then(() => 'ready', (error) => 'error:' + (error && error.message)),
      sleep(job.readiness.readyTimeoutMs).then(() => 'timeout'),
    ]);
    if (outcome === 'ready') readyMs = Date.now() - readyStarted;
    else if (outcome === 'timeout') { status = 'timed_out'; add('readiness_timeout', 'not ready within ' + job.readiness.readyTimeoutMs + 'ms'); }
    else { status = 'failed'; add('navigation_failed', outcome.slice(6)); }
  }

  await Promise.race([context.close().catch(() => {}), sleep(job.readiness.closeTimeoutMs)]);
  emit({ route: target.route, viewport: name, status, httpStatus, navigationMs, readyMs, findings });
}

await Promise.race([browser.close().catch(() => {}), sleep(job.readiness.closeTimeoutMs)]);
server.close();
emit({ done: true });
process.exit(0);
`;

/** Locate templates/browser-runtime from this package. */
export function defaultBrowserRuntimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'templates/browser-runtime');
}

export interface BrowserContainerSpec {
  readonly name: string;
  readonly site: string;
  readonly runtime: string;
  readonly app: string;
  readonly limits: BrowserLimits;
  readonly user: { uid: number; gid: number };
}

/** `docker create` arguments for one render run — every isolation property, in one reviewable place. */
export function browserCreateArgs(spec: BrowserContainerSpec): string[] {
  const { limits } = spec;
  return [
    'create',
    '--name', spec.name,
    '--label', `${SANDBOX_LABEL}=browser`,
    '--network', 'none',
    '--user', `${spec.user.uid}:${spec.user.gid}`,
    '--read-only',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${limits.tmpBytes}`,
    '--tmpfs', `/dev/shm:rw,nosuid,nodev,noexec,size=${limits.shmBytes}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', String(limits.memoryBytes),
    '--memory-swap', String(limits.memoryBytes),
    '--cpus', String(limits.cpus),
    '--pids-limit', String(limits.pids),
    '--mount', readonlyMount(spec.site, '/site'),
    '--mount', readonlyMount(spec.runtime, '/runner/node_modules'),
    '--mount', readonlyMount(spec.app, '/runner/app'),
    '--workdir', '/runner/app',
    '--env', 'HOME=/tmp',
    BROWSER_IMAGE,
    'node', '/runner/app/runner.mjs',
  ];
}

function readonlyMount(source: string, target: string): string {
  if (!source.startsWith(sep) || /[,\n\r\0]/.test(source)) throw new SandboxUnavailable('Refusing an unsafe browser mount source');
  return `type=bind,source=${source},target=${target},readonly`;
}

let imageReady: Promise<void> | null = null;

function ensureBrowserImage(): Promise<void> {
  imageReady ??= (async () => {
    const present = await docker(['image', 'inspect', '--format', '{{.Id}}', BROWSER_IMAGE]);
    if (present.code === 0) return;
    const pulled = await docker(['pull', '--quiet', BROWSER_IMAGE], 20 * 60 * 1000);
    if (pulled.code !== 0) throw new SandboxUnavailable(`Browser image unavailable: ${sanitizeSandboxOutput(pulled.stderr)}`);
  })().catch((error: unknown) => {
    imageReady = null;
    throw error instanceof SandboxUnavailable ? error : new SandboxUnavailable(`Docker is unavailable: ${String(error)}`);
  });
  return imageReady;
}

/** Copy the export's regular files — never a symlink — and digest them, path and content, in path order. */
async function snapshotExport(from: string, to: string): Promise<{ files: number; digest: string }> {
  const entries: { path: string; hash: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const full = join(dir, child.name);
      if (child.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!child.isFile() || !(await lstat(full)).isFile()) continue;
      const path = relative(from, full).split(sep).join('/');
      const target = join(to, path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(full, target);
      entries.push({ path, hash: createHash('sha256').update(await readFile(target)).digest('hex') });
    }
  };
  await mkdir(to, { recursive: true });
  await walk(from);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash('sha256');
  for (const entry of entries) digest.update(`${entry.path}\0${entry.hash}\n`);
  return { files: entries.length, digest: digest.digest('hex') };
}

export interface BrowserRenderOptions {
  /** The exact static export the evaluated build produced. */
  readonly exportDir: string;
  /** The exact plan being evaluated — the only source of routes. */
  readonly plan: Pick<SitePlan, 'sitemap'>;
  /** What was built, and on what authority. The renderer adds the digest of what it rendered. */
  readonly subject: Omit<BrowserRenderSubject, 'exportDigest'>;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<BrowserLimits>;
  readonly readiness?: Partial<RenderReadiness>;
  /** Where the runtime cache and disposable run directories live. */
  readonly workRoot?: string;
  readonly runtimeRoot?: string;
}

/**
 * Render an exact static export at every planned route and viewport.
 *
 * Resolves with a report whatever the site does — a 404, an exception, a page
 * that never becomes ready — and with `status: 'unavailable'` when the browser
 * sandbox cannot be provided. Rejects only when aborted, or when the plan names
 * a route that is not a site path. By the time it settles, the container and
 * every file of the run are gone.
 */
export async function renderInBrowser(options: BrowserRenderOptions): Promise<BrowserRenderReport> {
  const started = Date.now();
  const limits: BrowserLimits = { ...BROWSER_LIMITS, ...options.limits };
  const readiness: RenderReadiness = { ...RENDER_READINESS, ...options.readiness };
  options.signal?.throwIfAborted();
  const { targets, omittedRoutes } = planRenderTargets(options.plan);

  const workRoot = options.workRoot ?? join(tmpdir(), 'statxai-browser');
  await mkdir(join(workRoot, 'runs'), { recursive: true });
  const runRoot = await mkdtemp(join(workRoot, 'runs', 'render-'));
  let exportDigest = createHash('sha256').digest('hex');

  const report = (status: BrowserRenderReport['status'], renders: BrowserRouteRender[], reason: string | null): BrowserRenderReport =>
    boundReport({
      subject: { ...options.subject, exportDigest },
      runtime: { playwright: PLAYWRIGHT_VERSION, image: BROWSER_IMAGE },
      viewports: [...BROWSER_VIEWPORTS],
      status,
      renders,
      omittedRoutes,
      passed:
        status === 'completed' &&
        renders.length === targets.length &&
        renders.every((r) => r.status === 'rendered' && !r.findings.some((f) => BLOCKING_BROWSER_FINDINGS.includes(f.category))),
      truncated: false,
      durationMs: Date.now() - started,
      reason: reason === null ? null : sanitizeSandboxOutput(reason).slice(0, BROWSER_REPORT_BOUNDS.maxDetailChars),
    });
  const notRun = (done: readonly BrowserRouteRender[]) =>
    targets.slice(done.length).map((t): BrowserRouteRender => ({ route: t.route, viewport: t.viewport.name, status: 'not_run', httpStatus: null, navigationMs: null, readyMs: null, findings: [] }));

  let name: string | null = null;
  try {
    const site = join(runRoot, 'site');
    const snapshot = await snapshotExport(options.exportDir, site);
    exportDigest = snapshot.digest;
    if (snapshot.files === 0) return report('unavailable', notRun([]), 'There is no static export to render.');

    let runtime: string;
    try {
      runtime = await prepareTrustedDependencies(options.runtimeRoot ?? defaultBrowserRuntimeRoot(), workRoot);
      await ensureBrowserImage();
    } catch (error) {
      if (error instanceof SandboxUnavailable) return report('unavailable', notRun([]), error.message);
      throw error;
    }
    options.signal?.throwIfAborted();

    const app = join(runRoot, 'app');
    await mkdir(app);
    await writeFile(join(app, 'runner.mjs'), BROWSER_RUNNER_SOURCE);
    await writeFile(
      join(app, 'job.json'),
      JSON.stringify({ port: BROWSER_ORIGIN_PORT, startupMs: limits.startupMs, targets, readiness, bounds: BROWSER_REPORT_BOUNDS }),
    );

    name = `statxai-browser-${randomBytes(8).toString('hex')}`;
    const created = await docker(browserCreateArgs({ name, site, runtime, app, limits, user: sandboxUser() }));
    if (created.code !== 0) {
      name = null;
      return report('unavailable', notRun([]), `Browser container could not be created: ${created.stderr}`);
    }
    options.signal?.throwIfAborted();

    const perTarget = readiness.navigationTimeoutMs + readiness.readyTimeoutMs + readiness.closeTimeoutMs + 2_000;
    const runLimits: SandboxLimits = {
      memoryBytes: limits.memoryBytes,
      cpus: limits.cpus,
      pids: limits.pids,
      tmpBytes: limits.tmpBytes,
      outputBytes: limits.outputBytes,
      timeoutMs: Math.min(limits.maxRunMs, limits.startupMs + targets.length * perTarget),
    };
    const attached = await attach(name, runLimits, options.signal);
    if (attached.aborted) throw options.signal?.reason ?? new Error('Browser render aborted');

    const renders = parseRenders(attached.output, targets);
    const finished = /^@@render \{"done":true\}$/m.test(attached.output);
    if (attached.timedOut) return report('timed_out', [...renders, ...notRun(renders)], `The render run exceeded its ${Math.round(runLimits.timeoutMs / 1000)}s limit.`);
    if (!finished || renders.length !== targets.length) {
      const tail = attached.output.split('\n').filter((line) => !line.startsWith('@@render')).slice(-5).join(' ');
      return report('unavailable', [...renders, ...notRun(renders)], `The browser did not finish rendering: ${tail}`);
    }
    return report('completed', renders, null);
  } finally {
    try {
      if (name !== null) await removeContainer(name);
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  }
}

/** The runner's per-target lines, in target order, each checked against the contract and its target. */
function parseRenders(output: string, targets: readonly RenderTarget[]): BrowserRouteRender[] {
  const renders: BrowserRouteRender[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('@@render {"route"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice('@@render '.length));
    } catch {
      break;
    }
    const parsed = BrowserRouteRender.safeParse(value);
    const expected = targets[renders.length];
    if (!parsed.success || !expected || parsed.data.route !== expected.route || parsed.data.viewport !== expected.viewport.name) break;
    // The harness decides what a finding means, not the runner: a page that
    // loaded but threw, or lost a resource, did not render cleanly.
    const blocked = parsed.data.findings.some((f) => BLOCKING_BROWSER_FINDINGS.includes(f.category));
    renders.push(parsed.data.status === 'rendered' && blocked ? { ...parsed.data, status: 'failed' } : parsed.data);
  }
  return renders;
}

/**
 * Sanitize every text the page produced, cap each category per render, and fit
 * the whole report within its byte bound — dropping the least important
 * findings first and saying so.
 */
export function boundReport(report: BrowserRenderReport): BrowserRenderReport {
  const { maxFindingsPerCategory, maxDetailChars, maxReportBytes } = BROWSER_REPORT_BOUNDS;
  let truncated = report.truncated;
  const renders = report.renders.map((render) => {
    const counts = new Map<string, number>();
    const findings: BrowserFinding[] = [];
    for (const finding of render.findings) {
      const count = (counts.get(finding.category) ?? 0) + 1;
      counts.set(finding.category, count);
      if (count > maxFindingsPerCategory) {
        truncated = true;
        continue;
      }
      const detail = sanitizeSandboxOutput(finding.detail);
      findings.push({ ...finding, detail: detail.length > maxDetailChars ? `${detail.slice(0, maxDetailChars - 1)}…` : detail });
    }
    return { ...render, findings };
  });

  // Size tracked incrementally: re-serialising after every removal is quadratic
  // in exactly the reports that need trimming. Each removal saves the finding
  // plus at most one separating comma; the exact size is checked again after.
  let size = Buffer.byteLength(JSON.stringify({ ...report, renders, truncated: true }), 'utf8');
  // Non-blocking findings go first, then everything else from the last render back.
  for (const keep of [(f: BrowserFinding) => BLOCKING_BROWSER_FINDINGS.includes(f.category), () => false]) {
    for (let i = renders.length - 1; i >= 0 && size > maxReportBytes; i -= 1) {
      const findings = renders[i]!.findings;
      for (let j = findings.length - 1; j >= 0 && size > maxReportBytes; j -= 1) {
        if (keep(findings[j]!)) continue;
        size -= Buffer.byteLength(JSON.stringify(findings[j]), 'utf8') + 1;
        findings.splice(j, 1);
        truncated = true;
      }
    }
  }
  const bounded: BrowserRenderReport = { ...report, renders, truncated };
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > maxReportBytes) {
    // Only findings are trimmed; a report still over bound after that has
    // nothing left to drop but renders themselves, which are never hidden.
    return { ...bounded, renders: renders.map((r) => ({ ...r, findings: [] })), truncated: true };
  }
  return bounded;
}
