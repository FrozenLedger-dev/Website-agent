/**
 * The browser renderer's policy and isolation as the harness asks Docker for
 * them — no Docker needed. `browser-renderer.integration.test.ts` renders for real.
 */
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserRenderReport } from '@statxai/contracts';
import {
  BROWSER_IMAGE,
  BROWSER_LIMITS,
  BROWSER_REPORT_BOUNDS,
  BROWSER_RUNNER_SOURCE,
  BROWSER_VIEWPORTS,
  BrowserRouteRefused,
  MAX_RENDER_ROUTES,
  PLAYWRIGHT_VERSION,
  RENDER_READINESS,
  boundReport,
  browserCreateArgs,
  defaultBrowserRuntimeRoot,
  planRenderTargets,
  sandboxUser,
  type BrowserContainerSpec,
} from '../src/index.js';

const plan = (...routes: string[]) => ({ sitemap: { pages: routes.map((route) => ({ route })) } }) as never;

function spec(overrides: Partial<BrowserContainerSpec> = {}): BrowserContainerSpec {
  return {
    name: 'statxai-browser-unit',
    site: '/var/lib/statxai-browser/runs/render-x/site',
    runtime: '/var/lib/statxai-browser/deps-x/node_modules',
    app: '/var/lib/statxai-browser/runs/render-x/app',
    limits: BROWSER_LIMITS,
    user: sandboxUser(),
    ...overrides,
  };
}

const values = (args: readonly string[], flag: string) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pinned runtime and policy', () => {
  it('pins the browser image by digest, matched to the trusted Playwright client lockfile', async () => {
    expect(BROWSER_IMAGE).toMatch(new RegExp(`^mcr\\.microsoft\\.com/playwright:v${PLAYWRIGHT_VERSION.replace(/\./g, '\\.')}-noble@sha256:[0-9a-f]{64}$`));
    const manifest = JSON.parse(await readFile(join(defaultBrowserRuntimeRoot(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(manifest.dependencies).toEqual({ 'playwright-core': PLAYWRIGHT_VERSION });
    const lock = await readFile(join(defaultBrowserRuntimeRoot(), 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toContain(`playwright-core@${PLAYWRIGHT_VERSION}:\n    resolution: {integrity: sha512-`);
  });

  it('defines exactly three named viewports in one place', () => {
    expect(BROWSER_VIEWPORTS.map((v) => [v.name, v.width, v.height, v.isMobile])).toEqual([
      ['desktop', 1440, 900, false],
      ['tablet', 768, 1024, true],
      ['mobile', 390, 844, true],
    ]);
    expect(BROWSER_VIEWPORTS.every((v) => v.deviceScaleFactor === 1)).toBe(true);
  });

  it('bounds every readiness step', () => {
    expect(RENDER_READINESS).toEqual({
      navigationTimeoutMs: 20_000,
      fontsTimeoutMs: 5_000,
      animationFrames: 2,
      settleMs: 250,
      readyTimeoutMs: 10_000,
      closeTimeoutMs: 5_000,
    });
  });
});

describe('route authority', () => {
  it('renders every planned route, homepage first, at every viewport, in a fixed order', () => {
    const { targets, omittedRoutes } = planRenderTargets(plan('/services', '/', '/about/team'));

    expect(targets.map((t) => `${t.route}@${t.viewport.name}`)).toEqual([
      '/@desktop', '/@tablet', '/@mobile',
      '/services@desktop', '/services@tablet', '/services@mobile',
      '/about/team@desktop', '/about/team@tablet', '/about/team@mobile',
    ]);
    expect(omittedRoutes).toEqual([]);
  });

  it(`renders at most ${MAX_RENDER_ROUTES} routes and names every omitted one`, () => {
    const routes = ['/', ...Array.from({ length: MAX_RENDER_ROUTES + 3 }, (_, i) => `/page-${i}`)];
    const { targets, omittedRoutes } = planRenderTargets(plan(...routes));
    expect(new Set(targets.map((t) => t.route)).size).toBe(MAX_RENDER_ROUTES);
    expect(omittedRoutes).toEqual(routes.slice(MAX_RENDER_ROUTES));
  });

  it.each([
    ['an external URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a file: URL', 'file:///etc/passwd'],
    ['another localhost port', 'http://127.0.0.1:9999/'],
    ['a traversal', '/../runner/app/job.json'],
    ['a query', '/?next=https://evil.example'],
    ['a fragment', '/#x'],
    ['an encoded path', '/%2e%2e/etc'],
    ['an empty route', ''],
  ])('refuses %s', (_label, route) => {
    expect(() => planRenderTargets(plan('/', route))).toThrow(BrowserRouteRefused);
  });
});

describe('browser container arguments', () => {
  it('has no network at all — loopback only', () => {
    const args = browserCreateArgs(spec());
    expect(values(args, '--network')).toEqual(['none']);
    for (const flag of ['--net', '--add-host', '--dns', '--publish', '-p']) expect(args).not.toContain(flag);
  });

  it('mounts exactly the export snapshot, the trusted client and the run’s runner, all read-only', () => {
    const args = browserCreateArgs(spec());
    expect(values(args, '--mount')).toEqual([
      'type=bind,source=/var/lib/statxai-browser/runs/render-x/site,target=/site,readonly',
      'type=bind,source=/var/lib/statxai-browser/deps-x/node_modules,target=/runner/node_modules,readonly',
      'type=bind,source=/var/lib/statxai-browser/runs/render-x/app,target=/runner/app,readonly',
    ]);
    for (const flag of ['-v', '--volume', '--volumes-from', '--device', '--privileged']) expect(args).not.toContain(flag);
    const joined = args.join('\n');
    expect(joined).not.toContain(process.cwd());
    expect(joined).not.toContain(homedir());
    expect(joined).not.toMatch(/docker\.sock|containerd\.sock/);
    expect(joined).not.toMatch(new RegExp(`source=${tmpdir()}(,|$)`));
  });

  it('refuses a mount source that could smuggle options', () => {
    expect(() => browserCreateArgs(spec({ site: '/tmp/site,target=/etc' }))).toThrow(/unsafe browser mount/);
    expect(() => browserCreateArgs(spec({ app: 'relative/app' }))).toThrow(/unsafe browser mount/);
  });

  it('passes only HOME, runs non-root, read-only, capability-free and without privilege escalation', () => {
    const args = browserCreateArgs(spec({ user: { uid: 1000, gid: 1000 } }));
    expect(values(args, '--env')).toEqual(['HOME=/tmp']);
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--env-file');
    expect(values(args, '--user')).toEqual(['1000:1000']);
    expect(args).toContain('--read-only');
    expect(values(args, '--cap-drop')).toEqual(['ALL']);
    expect(values(args, '--cap-add')).toEqual([]);
    expect(values(args, '--security-opt')).toEqual(['no-new-privileges']);
    for (const flag of ['--pid', '--ipc', '--userns', '--cgroupns']) expect(args).not.toContain(flag);
  });

  it('never runs as root, even for a root harness', () => {
    vi.spyOn(process as unknown as { getuid: () => number }, 'getuid').mockReturnValue(0);
    vi.spyOn(process as unknown as { getgid: () => number }, 'getgid').mockReturnValue(0);
    expect(values(browserCreateArgs(spec({ user: sandboxUser() })), '--user')).toEqual(['65534:65534']);
  });

  it('applies memory without swap, CPU, PID and tmpfs limits', () => {
    const args = browserCreateArgs(spec());
    expect(values(args, '--memory')).toEqual([String(BROWSER_LIMITS.memoryBytes)]);
    expect(values(args, '--memory-swap')).toEqual([String(BROWSER_LIMITS.memoryBytes)]);
    expect(values(args, '--cpus')).toEqual([String(BROWSER_LIMITS.cpus)]);
    expect(values(args, '--pids-limit')).toEqual([String(BROWSER_LIMITS.pids)]);
    expect(values(args, '--tmpfs')).toEqual([
      `/tmp:rw,nosuid,nodev,size=${BROWSER_LIMITS.tmpBytes}`,
      `/dev/shm:rw,nosuid,nodev,noexec,size=${BROWSER_LIMITS.shmBytes}`,
    ]);
  });

  it('runs the pinned image, then exactly the trusted runner', () => {
    const args = browserCreateArgs(spec());
    expect(args.slice(args.indexOf(BROWSER_IMAGE))).toEqual([BROWSER_IMAGE, 'node', '/runner/app/runner.mjs']);
  });
});

describe('the trusted runner', () => {
  it('serves only the export, over loopback, for GET and HEAD', () => {
    expect(BROWSER_RUNNER_SOURCE).toContain("server.listen(job.port, '127.0.0.1', resolve)");
    expect(BROWSER_RUNNER_SOURCE).toContain("const SITE = '/site';");
    expect(BROWSER_RUNNER_SOURCE).toContain("if (full === null || !full.startsWith(SITE + '/'))");
    expect(BROWSER_RUNNER_SOURCE).toContain("if (request.method !== 'GET' && request.method !== 'HEAD')");
  });

  it('refuses every other origin in the browser and records it, and listens for every failure category', () => {
    expect(BROWSER_RUNNER_SOURCE).toContain("await context.route('**/*'");
    expect(BROWSER_RUNNER_SOURCE).toContain("return route.abort('blockedbyclient').catch(() => {});");
    for (const event of ["page.on('pageerror'", "page.on('console'", "page.on('response'", "page.on('requestfailed'", "page.on('framenavigated'"]) {
      expect(BROWSER_RUNNER_SOURCE).toContain(event);
    }
    expect(BROWSER_RUNNER_SOURCE).toContain("serviceWorkers: 'block'");
    expect(BROWSER_RUNNER_SOURCE).toContain("process.on('uncaughtException', () => {});");
    expect(BROWSER_RUNNER_SOURCE.match(/page\.on\('[a-z]+', guarded\(/g)).toHaveLength(5);
    expect(BROWSER_RUNNER_SOURCE).toContain("reducedMotion: 'reduce'");
    expect(BROWSER_RUNNER_SOURCE).toContain("waitUntil: 'load'");
    expect(BROWSER_RUNNER_SOURCE).not.toContain('networkidle');
    // One screenshot call, after readiness, PNG only; never a PDF or video.
    expect(BROWSER_RUNNER_SOURCE.match(/page\.screenshot\(/g)).toHaveLength(1);
    expect(BROWSER_RUNNER_SOURCE.indexOf('page.screenshot(')).toBeGreaterThan(BROWSER_RUNNER_SOURCE.indexOf('page.evaluate(readiness, job.readiness)'));
    expect(BROWSER_RUNNER_SOURCE).toMatch(/page\.screenshot\(\{ type: 'png', fullPage: true, clip: \{ x: 0, y: 0, width, height \}, animations: 'disabled', caret: 'hide', scale: 'css'/);
    expect(BROWSER_RUNNER_SOURCE).not.toMatch(/\.pdf\(|recordVideo|type: 'jpeg'|type: "jpeg"/);
  });
});

describe('report bounds', () => {
  const report = (findings: BrowserRenderReport['renders'][number]['findings']): BrowserRenderReport => ({
    subject: { projectId: 'p', sitePlan: { name: 'site-plan', version: 1 }, sourceCommit: null, exportDigest: 'a'.repeat(64), authority: { mode: 'legacy_direct' } },
    runtime: { playwright: PLAYWRIGHT_VERSION, image: BROWSER_IMAGE },
    viewports: [...BROWSER_VIEWPORTS],
    status: 'completed',
    renders: [{ route: '/', viewport: 'desktop', status: 'failed', httpStatus: 200, navigationMs: 1, readyMs: 1, findings }],
    omittedRoutes: [],
    passed: false,
    truncated: false,
    durationMs: 1,
    reason: null,
  });

  it('caps findings per category and characters per finding, and says it did', () => {
    const bounded = boundReport(report(Array.from({ length: 50 }, (_, i) => ({ category: 'console_error' as const, route: '/', viewport: 'desktop' as const, detail: `${i} ${'x'.repeat(5_000)}` }))));

    const findings = bounded.renders[0]!.findings;
    expect(findings).toHaveLength(BROWSER_REPORT_BOUNDS.maxFindingsPerCategory);
    expect(findings.every((f) => f.detail.length <= BROWSER_REPORT_BOUNDS.maxDetailChars)).toBe(true);
    expect(bounded.truncated).toBe(true);
  });

  it('fits the whole report in its byte bound, keeping blocking findings over non-blocking ones', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ route: `/r${i}`, viewport: 'desktop' as const, status: 'failed' as const, httpStatus: 200, navigationMs: 1, readyMs: 1, findings: [
      { category: 'console_error' as const, route: `/r${i}`, viewport: 'desktop' as const, detail: 'c'.repeat(400) },
      { category: 'runtime_exception' as const, route: `/r${i}`, viewport: 'desktop' as const, detail: 'boom' },
    ] }));
    const bounded = boundReport({ ...report([]), renders: many });

    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(BROWSER_REPORT_BOUNDS.maxReportBytes);
    expect(bounded.truncated).toBe(true);
    const kept = bounded.renders.flatMap((r) => r.findings);
    expect(kept.filter((f) => f.category === 'runtime_exception')).toHaveLength(400);
    expect(kept.filter((f) => f.category === 'console_error').length).toBeLessThan(400);
    expect(bounded.renders).toHaveLength(400);
  });

  it('sanitizes host paths and secret values out of page-produced text', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-browser-unit-secret-4411');
    const bounded = boundReport(report([
      { category: 'console_error', route: '/', viewport: 'desktop', detail: `leaked ${homedir()}/.ssh/id_rsa and sk-browser-unit-secret-4411` },
    ]));
    const detail = bounded.renders[0]!.findings[0]!.detail;
    expect(detail).not.toContain(homedir());
    expect(detail).not.toContain('sk-browser-unit-secret-4411');
    vi.unstubAllEnvs();
  });
});
