/**
 * The customer editor's server surface against real durable state: project
 * discovery from persisted tenancy, the one editor-state loader over an exact
 * canonical draft (available, handed off, failed, completed), the isolated
 * snapshot preview transport, durable edit submission and edit status — with
 * the real semantic-edit lifecycle and worker continuing submitted edits.
 *
 * Real: Mongo, canonical Git workspaces, the build lifecycle, promotion,
 * evaluation, snapshots and blobs, canonical drafts, customer tenancy and
 * sessions, the editor handlers, the semantic-edit worker. Faked: the model
 * skills, the compiler, the gates and the browser capture (see the rig).
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'parse5';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import { SITE_MODEL_MARKERS, type EditableSiteModel } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { SemanticEditWorker, resolveCanonicalDraftAuthority } from '@statxai/orchestrator';
import { BlobStore, exportDigestOf, readSiteExportFile, readSiteExportSnapshot, ArtifactRegistry } from '@statxai/workspace';
import {
  handleCustomerEditStatus,
  handleCustomerEditSubmit,
  handleCustomerEditorPreview,
  handleCustomerEditorState,
  handleCustomerProjects,
  listCustomerProjects,
  loadCustomerEditorState,
  setFieldValuePatch,
  editorModelView,
  resolveSelection,
  type CustomerEditorDeps,
  type CustomerEditorState,
} from '../src/index.js';
import { APP_ORIGIN, CONFIG, PNG, clearStore, cookieFor, customer, draftProject, rig, tenant, type Customer, type Draft } from './support/rig.js';

vi.mock('@statxai/agents', async (importOriginal) => (await import('./support/rig-mocks.js')).rigMocks.agents(await importOriginal<typeof Agents>()));
vi.mock('@statxai/workspace', async (importOriginal) => (await import('./support/rig-mocks.js')).rigMocks.workspace(await importOriginal<typeof Workspace>()));
vi.mock('@statxai/gates', async (importOriginal) => (await import('./support/rig-mocks.js')).rigMocks.gates(await importOriginal<typeof Gates>()));

let store: StateStore;
let workspacesRoot: string;
let validationWorkspacesRoot: string;
let deps: CustomerEditorDeps;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-editor-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-editor-validate-'));
  deps = { store, config: CONFIG, workspacesRoot, validationWorkspacesRoot };
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  rig.reset();
  await clearStore(store);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const roots = () => ({ store, workspacesRoot, validationWorkspacesRoot });

interface Owned {
  readonly d: Draft;
  readonly owner: Customer;
  readonly editor: Customer;
  readonly viewer: Customer;
  readonly outsider: Customer;
}

async function ownedDraft(): Promise<Owned> {
  const d = await draftProject(roots());
  const [owner, editor, viewer, outsider] = [await customer(store, 'owner'), await customer(store, 'editor'), await customer(store, 'viewer'), await customer(store, 'outsider')];
  await tenant(store, 'Harrowgate', [d.projectId], [
    { who: owner, role: 'owner' },
    { who: editor, role: 'editor' },
    { who: viewer, role: 'viewer' },
  ]);
  return { d, owner, editor, viewer, outsider };
}

const get = (path: string, who: Customer | null, headers: Record<string, string> = {}) => new Request(`${APP_ORIGIN}${path}`, { headers: { ...cookieFor(who), ...headers } });
const post = (path: string, who: Customer | null, body: unknown, headers: Record<string, string> = { origin: APP_ORIGIN }) =>
  new Request(`${APP_ORIGIN}${path}`, { method: 'POST', headers: { ...cookieFor(who), 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function stateOf(who: Customer, projectId: string): Promise<CustomerEditorState> {
  const response = await handleCustomerEditorState(get(`/api/projects/${projectId}/editor`, who), deps, projectId);
  expect(response.status).toBe(200);
  return (await response.json()) as CustomerEditorState;
}
const draftState = (state: CustomerEditorState) => {
  if (state.kind !== 'draft') throw new Error(`expected a draft state, got ${state.kind}`);
  return state;
};

const headingOf = (model: EditableSiteModel, route = '/') => model.pages.find((p) => p.route === route)!.sections[0]!.fields[0]!;
const headingPatch = (d: Draft, value: string, model = d.model0, ref = d.m0) => setFieldValuePatch({ name: 'editable-site-model', version: ref.version, contentHash: ref.contentHash }, headingOf(model), value);
const editBody = (d: Draft, value = 'Wardrobes made in our workshop') => ({ expectedDraftId: d.d0._id, baseModel: { name: d.m0.name, version: d.m0.version, contentHash: d.m0.contentHash }, patch: headingPatch(d, value) });

async function submitAs(who: Customer, d: Draft, body: unknown = editBody(d), headers?: Record<string, string>) {
  return handleCustomerEditSubmit(post(`/api/projects/${d.projectId}/edits`, who, body, headers), deps, d.projectId);
}

const workerFor = (owner: string) => new SemanticEditWorker({ store, workspacesRoot, validationWorkspacesRoot, owner, limits: { pollMs: 50, leaseMs: 5_000, heartbeatMs: 100 }, jobLeaseMs: 2_000, jobHeartbeatEveryMs: 200 });
async function runWorkerOnce(owner = 'editor-test-worker') {
  const worker = workerFor(owner);
  expect(await worker.claimOne()).toBe(true);
  await worker.drain();
}

async function previewOf(who: Customer | null, projectId: string, draftId: string, route: string[] = [], channel = 'channel_0123456789abcdef') {
  const path = `/api/projects/${projectId}/preview/${draftId}/${route.join('/')}${channel === '' ? '' : `?channel=${channel}`}`;
  return handleCustomerEditorPreview(get(path, who), deps, { projectId, draftId, route });
}

type P5 = { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: P5[]; value?: string };
const elementsOf = (html: string) => {
  const out: P5[] = [];
  const walk = (n: P5) => {
    for (const c of n.childNodes ?? []) {
      if (c.tagName) out.push(c);
      walk(c);
    }
  };
  walk(parse(html) as unknown as P5);
  return out;
};
const textOf = (el: P5): string => (el.childNodes ?? []).map((c) => c.value ?? textOf(c)).join('');

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

describe('project discovery from persisted tenancy', () => {
  it('refuses an unauthenticated customer', async () => {
    expect((await handleCustomerProjects(get('/api/projects', null), deps)).status).toBe(401);
  });

  it('lists exactly the projects of active memberships — viewers included, other tenants and disabled memberships excluded — whatever the request claims', async () => {
    const a = await draftProject(roots());
    const b = await draftProject(roots());
    const foreign = await draftProject(roots());
    const viewer = await customer(store, 'viewer');
    const other = await customer(store, 'other');
    const accountA = await tenant(store, 'Acme', [a.projectId], [{ who: viewer, role: 'viewer' }]);
    await tenant(store, 'Beta', [b.projectId], [{ who: viewer, role: 'editor' }]);
    const foreignAccount = await tenant(store, 'Foreign', [foreign.projectId], [{ who: other, role: 'owner' }]);
    await store.customerMemberships.updateOne({ accountId: (await store.projectAccountBindings.findOne({ _id: b.projectId }))!.accountId, customerUserId: viewer.principal.customerUserId }, { $set: { status: 'disabled' } });

    const response = await handleCustomerProjects(get(`/api/projects?accountId=${foreignAccount._id}&projectId=${foreign.projectId}`, viewer, { 'x-account-id': foreignAccount._id }), deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: { projectId: string }[] };
    expect(body).toEqual({ projects: [{ projectId: a.projectId, displayName: a.projectId, accountName: 'Acme', role: 'viewer', draft: 'ready_to_edit', generation: null }] });
    expect(JSON.stringify(body)).not.toMatch(/bnd_|binding|promotion|lineage|job|acct_|mem_|cu_/i);
    expect(accountA._id).toMatch(/^acct_/);
  });
});

// ---------------------------------------------------------------------------
// Editor load
// ---------------------------------------------------------------------------

describe('the editor state of an exact canonical draft', () => {
  it('refuses the unauthenticated and hides a foreign project behind the generic not-found', async () => {
    const { d, outsider } = await ownedDraft();
    expect((await handleCustomerEditorState(get(`/api/projects/${d.projectId}/editor`, null), deps, d.projectId)).status).toBe(401);
    const foreign = await handleCustomerEditorState(get(`/api/projects/${d.projectId}/editor`, outsider), deps, d.projectId);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });
    const missing = await handleCustomerEditorState(get('/api/projects/proj_does_not_exist/editor', outsider), deps, 'proj_does_not_exist');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('an authorised viewer loads exactly D0, its build’s exact model M0 and its exact snapshot S0 — read-only', async () => {
    const { d, viewer } = await ownedDraft();
    const state = draftState(await stateOf(viewer, d.projectId));
    expect(state.draft).toEqual({ draftId: d.d0._id, editability: 'ready_to_edit', editableSiteModel: { name: d.m0.name, version: d.m0.version, contentHash: d.m0.contentHash }, siteExportSnapshot: { name: d.s0.name, version: d.s0.version, contentHash: d.s0.contentHash } });
    expect(state.model).toEqual(editorModelView(d.model0));
    expect(state.preview.routes.map((r) => [r.route, r.available])).toEqual([['/', true], ['/services', true]]);
    expect(state.permissions).toEqual({ canEdit: false, canSubmit: false });
    expect(state.edit).toBeNull();
    expect(JSON.stringify(state)).not.toMatch(/bnd_|canonicalBindingId|promotion|lineage|jobId|token|planKey|sitePlan|acct_/);

    // Internally, exactly B0.
    const load = await loadCustomerEditorState(store, viewer.principal, d.projectId);
    expect(load.ok && load.authority).toMatchObject({ canonicalBindingId: d.b0._id, draft: { _id: d.d0._id }, modelRef: { contentHash: d.m0.contentHash }, snapshotRef: { contentHash: d.s0.contentHash } });
  });

  it('owners and editors may submit', async () => {
    const { d, owner, editor } = await ownedDraft();
    expect(draftState(await stateOf(owner, d.projectId)).permissions).toEqual({ canEdit: true, canSubmit: true });
    expect(draftState(await stateOf(editor, d.projectId)).permissions).toEqual({ canEdit: true, canSubmit: true });
  });

  it('never looks up "latest": a newer model and a newer snapshot of the same project change nothing', async () => {
    const { d, owner } = await ownedDraft();
    const registry = new ArtifactRegistry(store);
    const newerModel = await registry.put(d.projectId, 'editable-site-model', { ...d.model0, pages: d.model0.pages.map((p, i) => (i === 0 ? { ...p, sections: [{ ...p.sections[0]!, fields: [{ ...p.sections[0]!.fields[0]!, value: 'LATEST MODEL' }] }, ...p.sections.slice(1)] } : p)) });
    const s0 = await readSiteExportSnapshot(registry, d.projectId, d.s0);
    // A newer, valid snapshot of the same build and model that lacks the stylesheet: "latest" would lose the design.
    const files = s0.files.filter((f) => f.path !== '_next/static/chunks/site.css');
    const newerSnapshot = await registry.put(d.projectId, 'site-export-snapshot', { ...s0, files, totalFiles: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), exportDigest: exportDigestOf(files) });
    expect(newerModel.version).toBeGreaterThan(d.m0.version);
    expect(newerSnapshot.version).toBeGreaterThan(d.s0.version);

    const state = draftState(await stateOf(owner, d.projectId));
    expect(state.draft.editableSiteModel.version).toBe(d.m0.version);
    expect(state.draft.siteExportSnapshot.version).toBe(d.s0.version);
    expect(JSON.stringify(state.model)).not.toContain('LATEST MODEL');
    expect(await (await previewOf(owner, d.projectId, d.d0._id)).text()).toContain('font-family:Site');
  });

  it('fails closed, without the cause, on a malformed draft: a missing snapshot, a snapshot of another build, a missing model pin', async () => {
    const { d, owner } = await ownedDraft();
    await store.canonicalDrafts.updateOne({ _id: d.d0._id }, { $unset: { siteExportSnapshot: '' } });
    expect(await stateOf(owner, d.projectId)).toEqual({ kind: 'unavailable', project: { projectId: d.projectId, accountName: 'Harrowgate' }, unavailable: 'draft_unavailable', permissions: { canEdit: true, canSubmit: false } });

    const other = await draftProject(roots());
    await store.canonicalDrafts.updateOne({ _id: d.d0._id }, { $set: { siteExportSnapshot: other.s0 } });
    expect((await stateOf(owner, d.projectId)).kind).toBe('unavailable');

    await store.canonicalDrafts.updateOne({ _id: d.d0._id }, { $set: { siteExportSnapshot: d.s0 } });
    expect((await stateOf(owner, d.projectId)).kind).toBe('draft');
    await store.frontendBackendBuildBindings.updateOne({ _id: d.b0._id }, { $unset: { 'jobSpec.inputs.editableSiteModel': '' } });
    const broken = await stateOf(owner, d.projectId);
    expect(broken).toMatchObject({ kind: 'unavailable', unavailable: 'draft_unavailable' });
    expect(JSON.stringify(broken)).not.toMatch(/Error|corrupt|missing|stack/i);
  });

  it('a snapshot of another build of the same project is refused: the draft is unavailable, never previewed with the wrong bytes', async () => {
    const { d, editor } = await ownedDraft();
    expect((await submitAs(editor, d)).status).toBe(202);
    await runWorkerOnce('wrong-build');
    const d1 = draftState(await stateOf(editor, d.projectId));
    expect(d1.draft.draftId).not.toBe(d.d0._id);
    // D1 now names S0: a real, valid snapshot of this project — but of B0, with M0.
    await store.canonicalDrafts.updateOne({ _id: d1.draft.draftId }, { $set: { siteExportSnapshot: d.s0 } });
    expect(await stateOf(editor, d.projectId)).toMatchObject({ kind: 'unavailable', unavailable: 'draft_unavailable' });
    expect((await previewOf(editor, d.projectId, d1.draft.draftId)).status).toBe(404);
  });

  it('operator Basic credentials are never a customer identity on any editor route', async () => {
    const { d } = await ownedDraft();
    const basic = { authorization: `Basic ${btoa('ops:correct-horse-battery-staple')}`, origin: APP_ORIGIN };
    const responses = [
      await handleCustomerProjects(get('/api/projects', null, basic), deps),
      await handleCustomerEditorState(get(`/api/projects/${d.projectId}/editor`, null, basic), deps, d.projectId),
      await handleCustomerEditorPreview(get(`/api/projects/${d.projectId}/preview/${d.d0._id}/?channel=channel_0123456789abcdef`, null, basic), deps, { projectId: d.projectId, draftId: d.d0._id, route: [] }),
      await handleCustomerEditSubmit(post(`/api/projects/${d.projectId}/edits`, null, editBody(d), basic), deps, d.projectId),
      await handleCustomerEditStatus(get(`/api/projects/${d.projectId}/edits/semantic-edit-${'a'.repeat(64)}`, null, basic), deps, { projectId: d.projectId, intentId: `semantic-edit-${'a'.repeat(64)}` }),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(await store.semanticEditIntents.countDocuments({})).toBe(0);
  });

  it('a project without a draft says so', async () => {
    const { d, owner } = await ownedDraft();
    await store.canonicalDrafts.deleteMany({ projectId: d.projectId });
    await store.projects.updateOne({ _id: d.projectId }, { $set: { state: 'building' } });
    expect(await stateOf(owner, d.projectId)).toMatchObject({ kind: 'unavailable', unavailable: 'no_draft' });
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe('the exact-snapshot editor preview', () => {
  it('requires authentication and project access, and binds to exactly the current draft', async () => {
    const { d, viewer, outsider } = await ownedDraft();
    expect((await previewOf(null, d.projectId, d.d0._id)).status).toBe(401);
    expect((await previewOf(outsider, d.projectId, d.d0._id)).status).toBe(404);
    expect((await previewOf(viewer, d.projectId, 'draft-not-this-one')).status).toBe(404);
    const other = await draftProject(roots());
    // Another project's real draft id, under this project: not this project's draft.
    expect((await previewOf(viewer, d.projectId, other.d0._id)).status).toBe(404);
    expect((await previewOf(viewer, d.projectId, d.d0._id, [], '')).status).toBe(400);
    const ok = await previewOf(viewer, d.projectId, d.d0._id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toMatch(/default-src 'none'.*script-src 'nonce-.*connect-src 'none'.*frame-ancestors 'self'; sandbox allow-scripts$/);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('renders the snapshot index and a nested page, with its CSS, font and image inlined from S0 — and serves no generated script', async () => {
    const { d, viewer } = await ownedDraft();
    const s0 = await readSiteExportSnapshot(new ArtifactRegistry(store), d.projectId, d.s0);
    const blobs = new BlobStore(store);
    const css = (await readSiteExportFile(blobs, s0, '_next/static/chunks/site.css'))!.bytes.toString('utf8');
    const font = (await readSiteExportFile(blobs, s0, '_next/static/media/site.woff2'))!.bytes;

    const home = await (await previewOf(viewer, d.projectId, d.d0._id)).text();
    const els = elementsOf(home);
    expect(els.find((e) => e.attrs?.some((a) => a.name === SITE_MODEL_MARKERS.page))!.attrs).toContainEqual({ name: SITE_MODEL_MARKERS.page, value: d.model0.pages[0]!.pageId });
    const style = els.filter((e) => e.tagName === 'style').map(textOf).join('\n');
    expect(style).toContain(css.match(/main::before\{content:"[a-f0-9]+"\}/)![0]);
    expect(style).toContain(`data:font/woff2;base64,${font.toString('base64')}`);
    expect(style).toContain(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(els.filter((e) => e.tagName === 'script')).toHaveLength(1);
    expect(home).not.toMatch(/app\.js|\/_next\/static|dataset\.generated/);

    const services = await (await previewOf(viewer, d.projectId, d.d0._id, ['services'])).text();
    expect(services).toContain(d.model0.pages[1]!.pageId);
  });

  it('unknown paths, traversal, encoded traversal and non-documents are not found', async () => {
    const { d, viewer } = await ownedDraft();
    for (const route of [['nope'], ['..', '..', 'etc', 'passwd'], ['%2e%2e', 'secret'], ['_next', 'static', 'chunks', 'site.css'], ['images', 'bg.png'], ['..%2fservices']]) {
      expect((await previewOf(viewer, d.projectId, d.d0._id, route)).status, route.join('/')).toBe(404);
    }
  });

  it('serves exactly S0 even after another build overwrote app/out and the workspace is gone — no filesystem is ever read', async () => {
    const { d, viewer } = await ownedDraft();
    const before = await (await previewOf(viewer, d.projectId, d.d0._id)).text();
    const out = join(workspacesRoot, d.projectId, 'app', 'out');
    await writeFile(join(out, 'index.html'), '<html><body><h1>A LATER BUILD</h1></body></html>');
    const afterOverwrite = await (await previewOf(viewer, d.projectId, d.d0._id)).text();
    await rm(join(workspacesRoot, d.projectId), { recursive: true, force: true });
    const afterRemoval = await (await previewOf(viewer, d.projectId, d.d0._id)).text();
    const strip = (html: string) => html.replace(/nonce="[^"]+"/g, '');
    expect(strip(afterOverwrite)).toBe(strip(before));
    expect(strip(afterRemoval)).toBe(strip(before));
    expect(before).not.toContain('A LATER BUILD');
  });
});

// ---------------------------------------------------------------------------
// Edit submission
// ---------------------------------------------------------------------------

describe('edit submission: authorised, same-origin, exact, and durable handoff only', () => {
  it('refuses the unauthenticated, a foreign tenant, a viewer, and a cross-origin or origin-less request — writing nothing', async () => {
    const { d, viewer, outsider, editor } = await ownedDraft();
    expect((await submitAs(null as unknown as Customer, d)).status).toBe(401);
    expect((await submitAs(outsider, d)).status).toBe(404);
    const denied = await submitAs(viewer, d);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden' });
    expect((await submitAs(editor, d, editBody(d), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await submitAs(editor, d, editBody(d), {})).status).toBe(403);
    expect((await submitAs(editor, d, editBody(d), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(await store.semanticEditIntents.countDocuments({})).toBe(0);
    expect(rig.calls.edit).toEqual([]);
  });

  it('an editor submits: 202 with the exact durable intent, promptly, before any model, build or release runs', async () => {
    const { d, editor } = await ownedDraft();
    const started = Date.now();
    const response = await submitAs(editor, d);
    const elapsed = Date.now() - started;
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { intentId: string; state: string; baseDraftId: string; baseModel: unknown };
    const intent = (await store.semanticEditIntents.findOne({ projectId: d.projectId }))!;
    expect(accepted).toEqual({ intentId: intent._id, state: 'queued', baseDraftId: d.d0._id, baseModel: { name: d.m0.name, version: d.m0.version, contentHash: d.m0.contentHash } });
    expect(intent).toMatchObject({ status: 'building', sourceDraftId: d.d0._id, requestedBy: { customerUserId: editor.principal.customerUserId } });
    expect(rig.calls.edit).toEqual([]);
    expect(await store.jobs.countDocuments({ _id: intent.jobId })).toBe(0);
    expect(await store.releasePublications.countDocuments({ projectId: d.projectId })).toBe(0);
    expect(rig.calls.approve + rig.calls.deploy + rig.calls.refine).toBe(0);
    expect(elapsed).toBeLessThan(15_000);
  });

  it('an owner submits too', async () => {
    const { d, owner } = await ownedDraft();
    expect((await submitAs(owner, d)).status).toBe(202);
  });

  it('refuses a malformed, unsupported or over-claiming body as invalid_edit — account, role, build, job or CSS are never accepted', async () => {
    const { d, editor } = await ownedDraft();
    const body = editBody(d);
    const bad: unknown[] = [
      'not json',
      { ...body, accountId: 'acct_0123' },
      { ...body, role: 'owner' },
      { ...body, expectedCanonicalBindingId: d.b0._id },
      { ...body, jobId: 'job_x' },
      { ...body, patch: { ...body.patch, operation: { op: 'set_css', selector: 'h1', css: 'color:red' } } },
      { ...body, patch: { ...body.patch, operation: { ...(body.patch.operation as object), value: '' } } },
      { ...body, patch: { baseModel: { ...body.baseModel, version: body.baseModel.version + 1 }, operation: body.patch.operation } },
      { expectedDraftId: d.d0._id, patch: body.patch },
    ];
    for (const candidate of bad) {
      const response = await submitAs(editor, d, candidate);
      expect(response.status, JSON.stringify(candidate).slice(0, 80)).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_edit' });
    }
    const huge = await submitAs(editor, d, { ...body, padding: 'x'.repeat(70_000) });
    expect(huge.status).toBe(400);
    expect(await store.semanticEditIntents.countDocuments({})).toBe(0);
  });

  it('a CTA edit with an executable link is refused by the existing contract validators server-side', async () => {
    const { d, editor } = await ownedDraft();
    const heading = headingOf(d.model0);
    const body = { ...editBody(d), patch: { baseModel: editBody(d).baseModel, operation: { op: 'set_field_value', fieldId: heading.fieldId, expected: heading.value, value: { label: 'x', href: 'javascript:alert(1)' } } } };
    expect((await submitAs(editor, d, body)).status).toBe(400);
  });

  it('a stale draft, a stale model or a stale expectation is a conflict; the patch is never rebased', async () => {
    const { d, editor } = await ownedDraft();
    const stale = await submitAs(editor, d, { ...editBody(d), expectedDraftId: 'draft-seen-earlier' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'stale_revision' });
    const staleBase = { ...editBody(d).baseModel, contentHash: 'f'.repeat(64) };
    const staleModel = { ...editBody(d), baseModel: staleBase, patch: { ...editBody(d).patch, baseModel: staleBase } };
    expect((await submitAs(editor, d, staleModel)).status).toBe(409);
    const heading = headingOf(d.model0);
    const staleExpectation = { ...editBody(d), patch: { baseModel: editBody(d).baseModel, operation: { op: 'set_field_value', fieldId: heading.fieldId, expected: 'what someone else saw', value: 'x' } } };
    expect((await submitAs(editor, d, staleExpectation)).status).toBe(409);
    expect(await store.semanticEditIntents.countDocuments({})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// In progress, status, completion, failure
// ---------------------------------------------------------------------------

describe('while an edit runs, and after', () => {
  it('D0, M0 and S0 stay the editor’s authority while queued and running; M1 is never shown; a second edit is refused', async () => {
    const { d, editor, viewer } = await ownedDraft();
    const accepted = (await (await submitAs(editor, d)).json()) as { intentId: string };
    const intent = (await store.semanticEditIntents.findOne({ _id: accepted.intentId }))!;

    const queued = draftState(await stateOf(editor, d.projectId));
    expect(queued.draft).toMatchObject({ draftId: d.d0._id, editability: 'edit_in_progress', editableSiteModel: { contentHash: d.m0.contentHash }, siteExportSnapshot: { contentHash: d.s0.contentHash } });
    expect(queued.edit).toEqual({ intentId: accepted.intentId, state: 'queued', failure: null, baseDraftId: d.d0._id, resultDraftId: null });
    expect(queued.permissions).toEqual({ canEdit: true, canSubmit: false });
    expect(JSON.stringify(queued)).not.toContain(intent.editableSiteModel.contentHash!);
    expect(JSON.stringify(queued.model)).not.toContain('Wardrobes made in our workshop');

    const open = rig.gate();
    const worker = workerFor('slow');
    expect(await worker.claimOne()).toBe(true);
    await vi.waitFor(() => expect(rig.calls.edit).toHaveLength(1), { timeout: 20_000 });
    const running = draftState(await stateOf(viewer, d.projectId));
    expect(running.edit).toMatchObject({ state: 'running' });
    expect(running.draft.draftId).toBe(d.d0._id);
    const preview = await (await previewOf(viewer, d.projectId, d.d0._id)).text();
    expect(preview).toContain(String(headingOf(d.model0).value));
    expect(preview).not.toContain('Wardrobes made in our workshop');

    const second = await submitAs(editor, d, editBody(d, 'Another change'));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'edit_in_progress' });

    const status = await handleCustomerEditStatus(get(`/api/projects/${d.projectId}/edits/${accepted.intentId}`, viewer), deps, { projectId: d.projectId, intentId: accepted.intentId });
    const body = await status.json();
    expect(body).toEqual({ intentId: accepted.intentId, state: 'running', failure: null, baseDraftId: d.d0._id, resultDraftId: null });
    expect(JSON.stringify(body)).not.toMatch(/token|lease|job|owner|worker/i);
    open();
    await worker.drain();
  });

  it('status requires view authorisation and an intent of exactly this project', async () => {
    const { d, editor, outsider } = await ownedDraft();
    const accepted = (await (await submitAs(editor, d)).json()) as { intentId: string };
    const statusOf = (who: Customer | null, projectId: string, intentId: string) => handleCustomerEditStatus(get(`/api/projects/${projectId}/edits/${intentId}`, who), deps, { projectId, intentId });
    expect((await statusOf(null, d.projectId, accepted.intentId)).status).toBe(401);
    expect((await statusOf(outsider, d.projectId, accepted.intentId)).status).toBe(404);
    const mine = await ownedDraft();
    // A real intent of another project, asked for under a project this customer may see.
    expect((await statusOf(mine.editor, mine.d.projectId, accepted.intentId)).status).toBe(404);
    expect((await statusOf(editor, d.projectId, 'semantic-edit-nope')).status).toBe(404);
    expect((await statusOf(editor, d.projectId, accepted.intentId)).status).toBe(200);
  });

  it('on completion a fresh editor state is exactly D1, M1 and S1 — and the preview serves S1, not S0', async () => {
    const { d, editor } = await ownedDraft();
    const accepted = (await (await submitAs(editor, d)).json()) as { intentId: string };
    await runWorkerOnce();

    const status = (await (await handleCustomerEditStatus(get(`/api/projects/${d.projectId}/edits/${accepted.intentId}`, editor), deps, { projectId: d.projectId, intentId: accepted.intentId })).json()) as { state: string; resultDraftId: string };
    const intent = (await store.semanticEditIntents.findOne({ _id: accepted.intentId }))!;
    expect(status).toMatchObject({ state: 'completed', resultDraftId: intent.resultDraftId });
    const authority = await resolveCanonicalDraftAuthority(store, d.projectId);

    const fresh = draftState(await stateOf(editor, d.projectId));
    expect(fresh.draft.draftId).toBe(status.resultDraftId);
    expect(fresh.draft.draftId).toBe(authority!.draft._id);
    expect(fresh.draft.editableSiteModel.contentHash).toBe(intent.editableSiteModel.contentHash);
    expect(fresh.draft.siteExportSnapshot.contentHash).toBe(intent.evaluation!.siteExportSnapshot!.contentHash);
    expect(fresh.draft.siteExportSnapshot.contentHash).not.toBe(d.s0.contentHash);
    expect(fresh.draft.editability).toBe('ready_to_edit');
    expect(fresh.edit).toBeNull();
    expect(resolveSelection(fresh.model, '/', { kind: 'field', id: headingOf(d.model0).fieldId })).toMatchObject({ field: { value: 'Wardrobes made in our workshop' } });

    const s1 = await (await previewOf(editor, d.projectId, fresh.draft.draftId)).text();
    expect(s1).toContain('Wardrobes made in our workshop');
    // The superseded draft is no longer previewable here: history is never served with current bytes.
    expect((await previewOf(editor, d.projectId, d.d0._id)).status).toBe(404);
    expect(await store.releasePublications.countDocuments({ projectId: d.projectId })).toBe(0);
    expect(rig.calls.approve + rig.calls.deploy).toBe(0);
  });

  it('an added block gets harness-minted identity; once removed, its selection no longer resolves in the fresh model', async () => {
    const { d, editor } = await ownedDraft();
    const section = d.model0.pages[0]!.sections[0]!;
    const base = editBody(d).baseModel;
    const add = { expectedDraftId: d.d0._id, baseModel: base, patch: { baseModel: base, operation: { op: 'add_block', sectionId: section.sectionId, index: section.blocks.length, kind: 'text', values: { body: 'Hand-made in Harrogate.' } } } };
    expect((await submitAs(editor, d, add)).status).toBe(202);
    await runWorkerOnce('adder');

    const added = draftState(await stateOf(editor, d.projectId));
    const block = added.model.pages[0]!.sections.find((s) => s.sectionId === section.sectionId)!.blocks.at(-1)!;
    expect(block).toMatchObject({ kind: 'text', fields: [{ key: 'body', value: 'Hand-made in Harrogate.' }] });
    expect(block.blockId).toMatch(/^blk_[a-f0-9]{16}$/);
    expect(resolveSelection(added.model, '/', { kind: 'block', id: block.blockId })).not.toBeNull();

    const baseModel = { name: added.draft.editableSiteModel.name, version: added.draft.editableSiteModel.version, contentHash: added.draft.editableSiteModel.contentHash };
    const remove = { expectedDraftId: added.draft.draftId, baseModel, patch: { baseModel, operation: { op: 'remove_block', blockId: block.blockId } } };
    expect((await submitAs(editor, d, remove)).status).toBe(202);
    await runWorkerOnce('remover');
    const fresh = draftState(await stateOf(editor, d.projectId));
    expect(resolveSelection(fresh.model, '/', { kind: 'block', id: block.blockId })).toBeNull();
  });

  it('a terminal failure leaves D0 displayed and claimed, claims no D1, and shows only a safe failure', async () => {
    const { d, editor } = await ownedDraft();
    rig.editFailures = new Set([1, 2, 3, 4]);
    const accepted = (await (await submitAs(editor, d)).json()) as { intentId: string };
    const worker = workerFor('failing');
    for (let pass = 0; pass < 5 && (await worker.claimOne()); pass += 1) await worker.drain();

    const state = draftState(await stateOf(editor, d.projectId));
    expect(state.draft).toMatchObject({ draftId: d.d0._id, editability: 'edit_failed', siteExportSnapshot: { contentHash: d.s0.contentHash } });
    expect(state.edit).toEqual({ intentId: accepted.intentId, state: 'failed', failure: 'build_failed', baseDraftId: d.d0._id, resultDraftId: null });
    expect(state.permissions.canSubmit).toBe(false);
    expect(JSON.stringify(state)).not.toMatch(/provider|secret-provider-detail|Error|stack/i);
    expect(await store.canonicalDrafts.countDocuments({ projectId: d.projectId })).toBe(1);
    expect((await submitAs(editor, d, editBody(d, 'Try again'))).status).toBe(409);
    expect((await previewOf(editor, d.projectId, d.d0._id)).status).toBe(200);
    const listed = await listCustomerProjects(store, editor.principal);
    expect(listed).toEqual([{ projectId: d.projectId, displayName: d.projectId, accountName: 'Harrowgate', role: 'editor', draft: 'edit_failed', generation: null }]);
  });
});
