/**
 * Real screenshots, from real Chromium, in the isolated browser container,
 * persisted to real Mongo — and still readable after the container is gone.
 *
 * Integration: needs a Docker daemon and the Mongo replica set.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCREENSHOT_POLICY_VERSION, type ScreenshotSet } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import {
  ArtifactRegistry,
  BlobStore,
  SANDBOX_LABEL,
  buildSite,
  captureInBrowser,
  persistScreenshotSet,
  pngDimensions,
  scaffoldSite,
  type BrowserRenderOptions,
} from '../src/index.js';

const exec = promisify(execFile);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const FAKE_SECRETS = { OPENAI_API_KEY: 'sk-capture-probe-openai-71', VERCEL_TOKEN: 'vercel-capture-probe-72', MONGODB_URI_PROBE: 'mongodb://h:capture-probe-pw@m:1/x' };

let store: StateStore;
let registry: ArtifactRegistry;
let blobs: BlobStore;
let root: string;
let exportDir: string;
let workRoot: string;

const SUBJECT = {
  projectId: 'proj_capture',
  sitePlan: { name: 'site-plan', version: 2 },
  sourceCommit: 'abc1230000000000000000000000000000000000',
  authority: { mode: 'legacy_direct' as const },
};

const page = (body: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title>${head}</head><body style="margin:0;font-family:sans-serif">${body}</body></html>`;

const containers = async () => (await exec('docker', ['ps', '--all', '--quiet', '--filter', `label=${SANDBOX_LABEL}=browser`])).stdout.split('\n').filter(Boolean);
const chromiumOnHost = async () => (await exec('ps', ['-eo', 'args'])).stdout.split('\n').filter((line) => line.includes('/ms-playwright/'));

function options(routes: string[], overrides: Partial<BrowserRenderOptions> = {}): BrowserRenderOptions {
  return { exportDir, plan: { sitemap: { pages: routes.map((route) => ({ route })) } } as never, subject: SUBJECT, workRoot, ...overrides };
}

async function captureAndPersist(routes: string[], overrides: Partial<BrowserRenderOptions> = {}) {
  const outcome = await captureInBrowser(options(routes, overrides));
  const persisted = await persistScreenshotSet({ registry, blobs, projectId: SUBJECT.projectId, outcome });
  return { outcome, ...persisted };
}

const find = (set: ScreenshotSet, route: string, viewport: string) => set.captures.find((c) => c.route === route && c.viewport.name === viewport)!;

beforeAll(async () => {
  Object.assign(process.env, FAKE_SECRETS);
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  blobs = new BlobStore(store);
  root = await mkdtemp(join(tmpdir(), 'statxai-capture-'));
  exportDir = join(root, 'out');
  workRoot = join(root, 'browser');
  await mkdir(exportDir, { recursive: true });
  const files: Record<string, string> = {
    'index.html': page('<header style="height:120px;background:#123"></header><main style="padding:40px"><h1>Harrowgate Joinery</h1><p>Fitted wardrobes.</p></main>'),
    'long.html': page(`<div style="height:40000px;background:linear-gradient(#fff,#036)">very long</div>`),
    'error.html': page('<h1>Error page</h1><script>throw new Error("hydration boom")</script>'),
    'external.html': page('<h1>External</h1><img src="https://evil.example/hero.png" width="400" height="300">'),
    'animated.html': page(
      '<h1>Animated</h1><div class="spin"></div><span class="blink">caret</span>',
      '<style>.spin{width:120px;height:120px;background:#c00;animation:spin 1s linear infinite}@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.blink{animation:blink .3s step-end infinite}@keyframes blink{50%{opacity:0}}</style>',
    ),
    'responsive.html': page('<div class="box">layout</div>', '<style>.box{height:300px;background:#0a0}@media (max-width: 500px){.box{height:1500px;background:#a00}}</style>'),
    'stall.html': page('<h1>stall</h1><script>addEventListener("load", () => setTimeout(() => { for (;;) {} }, 0))</script>'),
    'heavy.html': page(`<div style="height:16000px;background:repeating-linear-gradient(45deg,#f00 0 3px,#0f0 3px 7px,#00f 7px 11px)">heavy</div>`),
  };
  for (const [path, contents] of Object.entries(files)) await writeFile(join(exportDir, path), contents);
}, 120_000);

afterAll(async () => {
  for (const key of Object.keys(FAKE_SECRETS)) delete process.env[key];
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.artifacts.deleteMany({ projectId: SUBJECT.projectId });
  await store.artifactSequences.deleteMany({});
  await store.blobs.deleteMany({});
});

describe('a real Next.js export', () => {
  it('captures every route at desktop, tablet and mobile, durably, bound to the exact subject', async () => {
    const site = join(root, 'next', 'app');
    await mkdir(site, { recursive: true });
    await scaffoldSite(site);
    await mkdir(join(site, 'app', 'about'), { recursive: true });
    await writeFile(join(site, 'app', 'about', 'page.tsx'), `export default function About() {\n  return <main className="p-12"><h1 className="text-5xl">About</h1></main>;\n}\n`);
    const built = await buildSite(site, { sandboxRoot: join(root, 'sandbox') });
    expect(built.ok).toBe(true);

    const { outcome, ref, set } = await captureAndPersist(['/', '/about'], { exportDir: built.outDir });

    // The container is gone; the images are not.
    expect(await containers()).toEqual([]);
    expect(await chromiumOnHost()).toEqual([]);
    expect(await readdir(join(workRoot, 'runs'))).toEqual([]);

    expect(ref).toMatchObject({ name: 'screenshot-set', version: 1 });
    expect(set.subject).toEqual({ ...SUBJECT, exportDigest: outcome.report.subject.exportDigest });
    expect(set.policy.version).toBe(SCREENSHOT_POLICY_VERSION);
    expect(set).toMatchObject({ expectedCaptures: 6, capturedCount: 6, missingCount: 0, complete: true });
    expect(set.captures.map((c) => [c.route, c.viewport.name])).toEqual([
      ['/', 'desktop'], ['/', 'tablet'], ['/', 'mobile'], ['/about', 'desktop'], ['/about', 'tablet'], ['/about', 'mobile'],
    ]);

    for (const capture of set.captures) {
      const stored = await blobs.get(capture.image!.blob);
      expect(stored.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect(sha(stored)).toBe(capture.image!.sha256);
      expect(stored.length).toBe(capture.image!.bytes);
      expect(pngDimensions(stored)).toEqual({ width: capture.viewport.width, height: capture.image!.height });
      expect(capture.image!.height).toBe(Math.min(capture.page!.height, set.policy.maxCaptureHeight));
      expect(capture.image!.height).toBeGreaterThanOrEqual(1);
    }
    // The browser report is preserved alongside, and agrees.
    expect(outcome.report.passed).toBe(true);
    expect(set.browser).toMatchObject({ status: 'completed', passed: true });
  }, 900_000);
});

describe('representative pages', () => {
  let set: ScreenshotSet;
  let reportFindings: Map<string, string[]>;

  beforeAll(async () => {
    const result = await captureAndPersist(['/', '/long', '/error', '/external', '/animated', '/responsive', '/missing', '/stall'], { readiness: { readyTimeoutMs: 3_000, closeTimeoutMs: 2_000 } });
    set = result.set;
    reportFindings = new Map(result.outcome.report.renders.map((r) => [`${r.route}@${r.viewport}`, r.findings.map((f) => f.category)]));
  }, 900_000);

  it('a very long page is captured at the height bound and marked truncated', () => {
    for (const viewport of ['desktop', 'tablet', 'mobile']) {
      const capture = find(set, '/long', viewport);
      expect(capture.reason).toBe('captured');
      expect(capture.page!.height).toBeGreaterThan(40_000 - 1);
      expect(capture.image!.height).toBe(set.policy.maxCaptureHeight);
      expect(capture.truncated).toBe(true);
    }
    expect(find(set, '/', 'desktop').truncated).toBe(false);
  });

  it('a page that threw after loading is captured as diagnostic evidence, and its finding is kept', () => {
    const capture = find(set, '/error', 'desktop');
    expect(capture.reason).toBe('captured');
    expect(capture.renderStatus).toBe('failed');
    expect(capture.findingCategories).toContain('runtime_exception');
    expect(reportFindings.get('/error@desktop')).toContain('runtime_exception');
  });

  it('a page with a blocked external image is captured, and the blocked request is still reported', () => {
    expect(find(set, '/external', 'mobile').reason).toBe('captured');
    expect(find(set, '/external', 'mobile').findingCategories).toContain('external_request_blocked');
  });

  it('animation is stopped: capturing the same animated page again yields identical bytes', async () => {
    const again = await captureInBrowser(options(['/animated']));
    const first = find(set, '/animated', 'desktop').image!;
    const second = again.captures.find((c) => c.viewport.name === 'desktop')!;
    expect(sha(second.png!)).toBe(first.sha256);
  }, 300_000);

  it('the mobile capture is the responsive mobile layout at the mobile width', () => {
    const mobile = find(set, '/responsive', 'mobile');
    const desktop = find(set, '/responsive', 'desktop');
    expect(mobile.image!.width).toBe(390);
    expect(desktop.image!.width).toBe(1440);
    expect(mobile.page!.height).toBeGreaterThan(desktop.page!.height);
  });

  it('a route that 404s and a page that never becomes ready have no fabricated image', () => {
    for (const route of ['/missing', '/stall']) {
      for (const viewport of ['desktop', 'tablet', 'mobile']) {
        expect(find(set, route, viewport)).toMatchObject({ reason: 'render_not_ready', image: null });
      }
    }
    expect(set).toMatchObject({ expectedCaptures: 24, capturedCount: 18, missingCount: 6, complete: false });
  });
});

describe('bounds and failures', () => {
  it('a capture over the byte bound is refused, not stored', async () => {
    const { set } = await captureAndPersist(['/long'], { screenshotLimits: { maxCaptureBytes: 2_000 } });
    expect(set.captures.every((c) => c.reason === 'capture_too_large' && c.image === null)).toBe(true);
    expect(await store.blobs.countDocuments({})).toBe(0);
    expect(set.policy.maxCaptureBytes).toBe(2_000);
  }, 300_000);

  it('the set’s aggregate byte bound stops further captures', async () => {
    const { set } = await captureAndPersist(['/', '/long'], { screenshotLimits: { maxSetBytes: 60_000 } });
    expect(set.captures.some((c) => c.reason === 'set_limit_reached')).toBe(true);
    expect(set.totalBytes).toBeLessThanOrEqual(60_000);
    expect(set.complete).toBe(false);
  }, 300_000);

  it('a tighter height bound bounds every image', async () => {
    const { set } = await captureAndPersist(['/long'], { screenshotLimits: { maxCaptureHeight: 2_000 } });
    expect(set.captures.map((c) => [c.image!.height, c.truncated])).toEqual([[2_000, true], [2_000, true], [2_000, true]]);
  }, 300_000);

  it('a capture that fails after a clean render is reported as capture_failed, distinct from the render', async () => {
    const { set, outcome } = await captureAndPersist(['/heavy'], { readiness: { readyTimeoutMs: 300, settleMs: 0, fontsTimeoutMs: 0 } });
    const failed = set.captures.filter((c) => c.reason === 'capture_failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const capture of failed) {
      expect(capture.image).toBeNull();
      expect(capture.detail).toMatch(/timeout|Timeout/);
    }
    expect(outcome.report.renders.some((r) => r.status === 'rendered')).toBe(true);
  }, 300_000);
});

describe('isolation and cancellation', () => {
  it('capture runs in the same isolated container: no secrets, only read-only mounts, no network, non-root', async () => {
    let inspected: string | null = null;
    const capturing = captureInBrowser(options(['/', '/long']));
    const deadline = Date.now() + 120_000;
    while (inspected === null && Date.now() < deadline) {
      const [id] = await containers();
      if (id) inspected = (await exec('docker', ['inspect', '--format', '{{json .Config.Env}}|{{json .Mounts}}|{{.HostConfig.NetworkMode}}|{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}', id]).catch(() => ({ stdout: '' }))).stdout || null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const outcome = await capturing;

    expect(inspected).not.toBeNull();
    const [env, mounts, network, user, readonlyRoot] = inspected!.trim().split('|');
    for (const value of Object.values(FAKE_SECRETS)) expect(env).not.toContain(value);
    const parsed = JSON.parse(mounts!) as { Source: string; Destination: string; RW: boolean }[];
    expect(parsed.map((m) => m.Destination).sort()).toEqual(['/runner/app', '/runner/node_modules', '/site']);
    expect(parsed.every((m) => !m.RW && m.Source.startsWith(workRoot))).toBe(true);
    expect(mounts).not.toMatch(/docker\.sock/);
    expect(mounts).not.toContain(`"Source":"${homedir()}"`);
    expect(network).toBe('none');
    expect(user).not.toMatch(/^0(:|$)/);
    expect(readonlyRoot).toBe('true');
    expect(outcome.captures.filter((c) => c.reason === 'captured')).toHaveLength(6);
  }, 300_000);

  it('abort stops the remaining captures and the container, and nothing is persisted', async () => {
    const controller = new AbortController();
    const reason = new Error('evaluation cancelled');
    const capturing = captureInBrowser(options(['/long', '/', '/error', '/animated'], { signal: controller.signal }));
    const deadline = Date.now() + 120_000;
    while ((await chromiumOnHost()).length === 0) {
      if (Date.now() > deadline) throw new Error('Chromium never started');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.abort(reason);

    await expect(capturing).rejects.toBe(reason);
    expect(await containers()).toEqual([]);
    expect(await chromiumOnHost()).toEqual([]);
    expect(await store.artifacts.countDocuments({ projectId: SUBJECT.projectId, name: 'screenshot-set' })).toBe(0);
    expect(await store.blobs.countDocuments({})).toBe(0);
  }, 300_000);
});
