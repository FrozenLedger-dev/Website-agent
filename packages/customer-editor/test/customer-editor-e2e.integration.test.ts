/**
 * The customer editor end to end, in a real browser against the real customer
 * app: a signed-in customer opens their project, sees the exact draft, selects
 * a heading in the isolated preview, saves a text edit, keeps seeing D0 while
 * the edit is queued and running, and lands on the exact new draft once the
 * standalone semantic-edit worker has concluded it. A viewer cannot save.
 *
 * Real: the Next customer app (`next dev`, its own process: authentication,
 * tenancy, editor state, preview transport, durable submission, status), Mongo,
 * canonical Git workspaces, Chrome, the editor UI and the semantic-edit worker.
 * Faked, in this process only (the worker's): the model skills, compiler, gates
 * and browser capture — the customer app never runs any of them.
 *
 * Integration: needs the Mongo replica set and Chrome (CHROME_PATH).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { SITE_MODEL_MARKERS } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { SemanticEditWorker } from '@statxai/orchestrator';
import { clearStore, customer, draftProject, rig, tenant, type Customer, type Draft } from './support/rig.js';

vi.mock('@statxai/agents', async (importOriginal) => (await import('./support/rig-mocks.js')).rigMocks.agents(await importOriginal<typeof Agents>()));
vi.mock('@statxai/workspace', async (importOriginal) => (await import('./support/rig-mocks.js')).rigMocks.workspace(await importOriginal<typeof Workspace>()));
vi.mock('@statxai/gates', async (importOriginal) => (await import('./support/rig-mocks.js')).rigMocks.gates(await importOriginal<typeof Gates>()));

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CUSTOMER_APP = join(REPO, 'apps', 'customer');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0';
const DB = 'statxai_test';

let store: StateStore;
let workspacesRoot: string;
let validationWorkspacesRoot: string;
let app: ChildProcess;
let appOrigin: string;
let appLog = '';
let browser: Browser;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  store = await StateStore.connect({ uri: URI, dbName: DB });
  await store.ensureIndexes();
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-e2e-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-e2e-validate-'));
  const port = await freePort();
  appOrigin = `http://localhost:${port}`;
  app = spawn(process.execPath, [join(CUSTOMER_APP, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--port', String(port), '--hostname', 'localhost'], {
    cwd: CUSTOMER_APP,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      NEXT_TELEMETRY_DISABLED: '1',
      MONGODB_URI: URI,
      MONGODB_DB: DB,
      WORKSPACES_ROOT: workspacesRoot,
      VALIDATION_WORKSPACES_ROOT: validationWorkspacesRoot,
      // A local, non-production customer app: an http issuer is accepted for localhost, and never discovered by editor routes.
      CUSTOMER_OIDC_ISSUER: 'http://localhost:9/',
      CUSTOMER_OIDC_CLIENT_ID: 'statxai-e2e',
      CUSTOMER_APP_ORIGIN: appOrigin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout!.on('data', (chunk: Buffer) => (appLog += chunk.toString()));
  app.stderr!.on('data', (chunk: Buffer) => (appLog += chunk.toString()));
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 180_000) throw new Error(`customer app did not start:\n${appLog.slice(-4000)}`);
    const ready = await fetch(`${appOrigin}/api/projects`).then((r) => r.status === 401, () => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  if (app && app.exitCode === null) {
    app.kill('SIGTERM');
    await new Promise((r) => app.once('exit', r));
  }
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  rig.reset();
  await clearStore(store);
});

async function signedIn(who: Customer): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'statx_customer_session', value: who.token, url: appOrigin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.on('dialog', (d) => void d.accept());
  return { context, page };
}

/** The preview frame currently showing exactly `draftId`, once its document has rendered. Retries across frame reloads. */
const previewFrame = async (page: Page, draftId: string): Promise<Frame> => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const handle = await page.$(`iframe[title="Draft preview"][src*="/preview/${draftId}"]`);
    const frame = await handle?.contentFrame().catch(() => null);
    if (frame && (await frame.$(`[${SITE_MODEL_MARKERS.page}]`).catch(() => null))) return frame;
    if (Date.now() > deadline) throw new Error(`no rendered preview of ${draftId}`);
    await page.waitForTimeout(250);
  }
};

describe('a customer edits their draft end to end', () => {
  it('opens the exact draft, selects and saves a heading, keeps D0 while the worker runs, and lands on the exact D1', async () => {
    const d: Draft = await draftProject({ store, workspacesRoot, validationWorkspacesRoot }, 'proj_e2e');
    const editor = await customer(store, 'e2e-editor');
    await tenant(store, 'Harrowgate Joinery', [d.projectId], [{ who: editor, role: 'editor' }]);
    const heading = d.model0.pages[0]!.sections[0]!.fields[0]!;
    const { context, page } = await signedIn(editor);
    const requests: { url: string; method: string }[] = [];
    page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));

    // The project list, then the editor.
    await page.goto(`${appOrigin}/projects`, { timeout: 180_000 });
    await expect.poll(() => page.innerText('body'), { timeout: 60_000 }).toContain('Draft · Ready to edit');
    expect(await page.innerText('body')).not.toMatch(/approved|ready to publish|publish/i);
    await page.click('text=Open editor');
    let frame = await previewFrame(page, d.d0._id);
    expect(await frame.textContent(`[${SITE_MODEL_MARKERS.field}="${heading.fieldId}"]`)).toBe(String(heading.value));
    expect(await page.innerText('body')).not.toMatch(/publish|approved|chat|prompt|css/i);
    expect(await page.getAttribute('iframe[title="Draft preview"]', 'sandbox')).toBe('allow-scripts');

    // The route selector loads the exact other page of S0.
    await page.selectOption('select >> nth=0', '/services');
    await expect.poll(async () => (await page.$('iframe[title="Draft preview"]'))?.getAttribute('src'), { timeout: 30_000 }).toContain('/services?channel=');
    frame = await previewFrame(page, d.d0._id);
    expect(await frame.getAttribute(`[${SITE_MODEL_MARKERS.page}]`, SITE_MODEL_MARKERS.page)).toBe(d.model0.pages[1]!.pageId);
    await page.selectOption('select >> nth=0', '/');
    await expect.poll(async () => (await page.$('iframe[title="Draft preview"]'))?.getAttribute('src'), { timeout: 30_000 }).not.toContain('/services');
    frame = await previewFrame(page, d.d0._id);

    // Click the heading in the preview: the inspector shows exactly its current model value.
    await frame.click(`[${SITE_MODEL_MARKERS.field}="${heading.fieldId}"]`);
    const input = page.locator(`#field-${heading.fieldId}`);
    await expect.poll(() => input.inputValue(), { timeout: 30_000 }).toBe(String(heading.value));

    // Save: the request returns promptly with 202; nothing has been built.
    const open = rig.gate();
    await input.fill('Wardrobes made in our Harrogate workshop');
    const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/edits') && r.request().method() === 'POST', { timeout: 60_000 }), page.click('button:has-text("Save") >> nth=0')]);
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as { intentId: string };
    expect(rig.calls.edit).toEqual([]);
    await expect.poll(() => page.innerText('.editor-status'), { timeout: 30_000 }).toContain('Saving changes…');
    expect(await page.isDisabled(`#field-${heading.fieldId}`)).toBe(true);
    frame = await previewFrame(page, d.d0._id);
    expect(await frame.textContent(`[${SITE_MODEL_MARKERS.field}="${heading.fieldId}"]`)).toBe(String(heading.value));

    // The standalone worker picks it up; while it runs, D0 stays on screen.
    const worker = new SemanticEditWorker({ store, workspacesRoot, validationWorkspacesRoot, owner: 'e2e-worker', limits: { pollMs: 50, leaseMs: 10_000, heartbeatMs: 200 }, jobLeaseMs: 5_000, jobHeartbeatEveryMs: 500 });
    expect(await worker.claimOne()).toBe(true);
    await vi.waitFor(() => expect(rig.calls.edit).toHaveLength(1), { timeout: 30_000 });
    await expect.poll(() => page.innerText('.editor-status'), { timeout: 30_000 }).toContain('Building new revision…');
    frame = await previewFrame(page, d.d0._id);
    expect(await frame.textContent(`[${SITE_MODEL_MARKERS.field}="${heading.fieldId}"]`)).toBe(String(heading.value));

    open();
    await worker.drain();
    const intent = (await store.semanticEditIntents.findOne({ _id: accepted.intentId }))!;
    expect(intent.status).toBe('completed');

    // The editor reloads its state and lands on exactly D1 and S1.
    await expect.poll(() => page.innerText('.editor-status'), { timeout: 60_000 }).toContain('Changes applied');
    frame = await previewFrame(page, intent.resultDraftId!);
    expect(await frame.textContent(`[${SITE_MODEL_MARKERS.field}="${heading.fieldId}"]`)).toBe('Wardrobes made in our Harrogate workshop');
    expect(await page.innerText('body')).toContain('Draft · Ready to edit');

    // Polling was bounded and stopped at the terminal state.
    const polls = requests.filter((r) => r.url.includes(`/edits/${accepted.intentId}`)).length;
    await page.waitForTimeout(5_000);
    expect(requests.filter((r) => r.url.includes(`/edits/${accepted.intentId}`)).length).toBe(polls);
    expect(polls).toBeLessThan(60);
    // The frame itself requested nothing but its documents.
    expect(requests.filter((r) => r.url.includes('/_next/static/chunks/site.css') || r.url.includes('/images/'))).toEqual([]);
    expect(await store.releasePublications.countDocuments({ projectId: d.projectId })).toBe(0);
    await context.close();
  }, 600_000);

  it('a viewer sees the draft and the inspector read-only, and the server refuses a save', async () => {
    const d: Draft = await draftProject({ store, workspacesRoot, validationWorkspacesRoot }, 'proj_e2e');
    const viewer = await customer(store, 'e2e-viewer');
    await tenant(store, 'Harrowgate Joinery', [d.projectId], [{ who: viewer, role: 'viewer' }]);
    const heading = d.model0.pages[0]!.sections[0]!.fields[0]!;
    const { context, page } = await signedIn(viewer);

    await page.goto(`${appOrigin}/projects/${d.projectId}/editor`, { timeout: 180_000 });
    const frame = await previewFrame(page, d.d0._id);
    await frame.click(`[${SITE_MODEL_MARKERS.field}="${heading.fieldId}"]`);
    await expect.poll(() => page.innerText('body'), { timeout: 30_000 }).toContain('Your role does not allow editing');
    expect(await page.isDisabled(`#field-${heading.fieldId}`)).toBe(true);

    const status = await page.evaluate(async ({ projectId, draftId, m0, fieldId, value }) => {
      const response = await fetch(`/api/projects/${projectId}/edits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedDraftId: draftId, baseModel: m0, patch: { baseModel: m0, operation: { op: 'set_field_value', fieldId, expected: value, value: 'viewer change' } } }),
      });
      return response.status;
    }, { projectId: d.projectId, draftId: d.d0._id, m0: { name: d.m0.name, version: d.m0.version, contentHash: d.m0.contentHash }, fieldId: heading.fieldId, value: heading.value });
    expect(status).toBe(403);
    expect(await store.semanticEditIntents.countDocuments({})).toBe(0);
    await context.close();
  }, 300_000);
});
