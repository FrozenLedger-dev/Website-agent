/**
 * Customer self-service project creation against real durable state: account
 * authorisation, the create HTTP surface, the durable creation-request
 * lifecycle, and the generation-status route's exact-draft proof.
 *
 * Real: Mongo, canonical Git workspaces, customer tenancy and sessions, the
 * create/status handlers, the real `InitialDraftWorker` class. A real
 * generation through `runProject` needs a Sol-planning skill fake this rig
 * does not have (only the build/evaluate/gates layer is faked here — see
 * `support/rig-mocks.ts`), so the worker's *fresh-request* path is proven
 * structurally in `packages/orchestrator/test/initial-draft-worker.test.ts`
 * and its own idempotency/lease mechanics against real Mongo in
 * `packages/orchestrator/test/initial-draft-generation.integration.test.ts`.
 * What this suite proves for real: the exact "already concluded" fast path a
 * crash between `runProject` concluding and the worker recording it depends
 * on — built here against a real, fully concluded canonical draft — and the
 * status route's independent re-proof before it will ever say `completed`.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import type { BusinessProfile } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { InitialDraftWorker } from '@statxai/orchestrator';
import {
  createCustomerProject,
  handleCustomerCreateAccounts,
  handleCustomerGenerationStatus,
  handleCustomerProjectCreate,
  handleCustomerProjects,
  readCustomerGenerationStatus,
  type CustomerEditorDeps,
} from '../src/index.js';
import { APP_ORIGIN, clearStore, CONFIG, cookieFor, customer, draftProject, rig, tenant, type Customer, type Draft } from './support/rig.js';

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
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-creation-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-creation-validate-'));
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
  await store.initialDraftRequests.deleteMany({});
});

const roots = () => ({ store, workspacesRoot, validationWorkspacesRoot });

function intake(businessName: string): BusinessProfile {
  return {
    businessName,
    industry: 'joinery',
    location: 'Leeds, UK',
    audience: 'homeowners',
    services: [{ name: 'Custom cabinetry', description: 'Bespoke kitchen and built-in cabinetry.' }],
    differentiators: ['20 years of experience'],
    contact: { email: 'hello@example.com', phone: '01133456789' },
    tone: 'warm and professional',
    goals: ['generate qualified leads'],
  };
}

const get = (path: string, who: Customer | null, headers: Record<string, string> = {}) => new Request(`${APP_ORIGIN}${path}`, { headers: { ...cookieFor(who), ...headers } });
const post = (path: string, who: Customer | null, body: unknown, headers: Record<string, string> = { origin: APP_ORIGIN }) =>
  new Request(`${APP_ORIGIN}${path}`, { method: 'POST', headers: { ...cookieFor(who), 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const workerFor = (owner: string) => new InitialDraftWorker({ store, workspacesRoot, validationWorkspacesRoot, owner, limits: { pollMs: 50, leaseMs: 5_000, heartbeatMs: 100 } });
async function runWorkerOnce(owner = 'initial-draft-test-worker') {
  const worker = workerFor(owner);
  expect(await worker.claimOne()).toBe(true);
  await worker.drain();
}

describe('POST /api/projects — durable creation handoff', () => {
  it('unauthenticated is refused, and same-origin is required', async () => {
    const owner = await customer(store, 'owner');
    await tenant(store, 'Acme', [], [{ who: owner, role: 'owner' }]);
    expect((await handleCustomerProjectCreate(post('/api/projects', null, { intake: intake('Acme Joinery') }), deps)).status).toBe(401);
    expect((await handleCustomerProjectCreate(post('/api/projects', owner, { intake: intake('Acme Joinery') }, { origin: 'https://evil.example' }), deps)).status).toBe(403);
  });

  it('a viewer cannot create; an owner or editor can, defaulting silently to their one eligible account', async () => {
    const [owner, editor, viewer] = [await customer(store, 'owner'), await customer(store, 'editor'), await customer(store, 'viewer')];
    const account = await tenant(store, 'Acme', [], [
      { who: owner, role: 'owner' },
      { who: editor, role: 'editor' },
      { who: viewer, role: 'viewer' },
    ]);

    // Named explicitly, so the failure is proven to be the role check — omitting it would 409 first, since a viewer is eligible for no account at all.
    const denied = await handleCustomerProjectCreate(post('/api/projects', viewer, { accountId: account._id, intake: intake('Acme Joinery') }), deps);
    expect(denied.status).toBe(403);
    expect(await store.initialDraftRequests.countDocuments({})).toBe(0);

    const accepted = await handleCustomerProjectCreate(post('/api/projects', owner, { intake: intake('Acme Joinery') }), deps);
    expect(accepted.status).toBe(202);
    const body = (await accepted.json()) as { creationRequestId: string; projectId: string; status: string };
    expect(body.status).toBe('queued');
    const binding = await store.projectAccountBindings.findOne({ _id: body.projectId });
    expect(binding).toMatchObject({ accountId: account._id });
    expect(body.projectId).not.toMatch(/^cu_|^acct_/); // never an internal id shape leaking

    const accepted2 = await handleCustomerProjectCreate(post('/api/projects', editor, { intake: intake('Acme Cabinets') }), deps);
    expect(accepted2.status).toBe(202);
  });

  it('a browser-supplied accountId is always re-authorised — a foreign account is refused, never trusted', async () => {
    const alice = await customer(store, 'alice');
    const acmeAccount = await tenant(store, 'Acme', [], [{ who: alice, role: 'owner' }]);
    const bravoAccount = await tenant(store, 'Bravo', [], []);

    const denied = await handleCustomerProjectCreate(post('/api/projects', alice, { accountId: bravoAccount._id, intake: intake('Sneaky') }), deps);
    expect(denied.status).toBe(403);
    expect(await store.initialDraftRequests.countDocuments({})).toBe(0);

    const allowed = await handleCustomerProjectCreate(post('/api/projects', alice, { accountId: acmeAccount._id, intake: intake('Legit') }), deps);
    expect(allowed.status).toBe(202);
  });

  it('a customer in more than one eligible account must choose; omitting the account is refused, not guessed', async () => {
    const bob = await customer(store, 'bob');
    await tenant(store, 'Acme', [], [{ who: bob, role: 'owner' }]);
    await tenant(store, 'Bravo', [], [{ who: bob, role: 'editor' }]);
    const response = await handleCustomerProjectCreate(post('/api/projects', bob, { intake: intake('Which Account') }), deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'account_required' });
  });

  it('malformed or thin intake is refused before anything durable is written', async () => {
    const owner = await customer(store, 'owner');
    await tenant(store, 'Acme', [], [{ who: owner, role: 'owner' }]);
    const missingFields = await handleCustomerProjectCreate(post('/api/projects', owner, { intake: { businessName: 'Acme' } }), deps);
    expect(missingFields.status).toBe(400);
    expect(await missingFields.json()).toEqual({ error: 'invalid_request' });

    const thin = intake('Acme Joinery');
    const insufficient = await handleCustomerProjectCreate(post('/api/projects', owner, { intake: { ...thin, differentiators: [] } }), deps);
    expect(insufficient.status).toBe(400);
    expect(await store.initialDraftRequests.countDocuments({})).toBe(0);
  });

  it('an oversized body is refused before it is ever parsed, and writes nothing durable', async () => {
    const owner = await customer(store, 'owner');
    await tenant(store, 'Acme', [], [{ who: owner, role: 'owner' }]);
    const oversized = { intake: { ...intake('Acme Joinery'), differentiators: [`x`.repeat(64 * 1024)] } };
    const response = await handleCustomerProjectCreate(post('/api/projects', owner, oversized), deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(await store.initialDraftRequests.countDocuments({})).toBe(0);
  });

  it('a double-submitted, identical request is idempotent: the same project, never a second one', async () => {
    const owner = await customer(store, 'owner');
    await tenant(store, 'Acme', [], [{ who: owner, role: 'owner' }]);
    const body = { intake: intake('Acme Joinery') };
    const first = (await (await handleCustomerProjectCreate(post('/api/projects', owner, body), deps)).json()) as { projectId: string };
    const second = (await (await handleCustomerProjectCreate(post('/api/projects', owner, body), deps)).json()) as { projectId: string };
    expect(second.projectId).toBe(first.projectId);
    expect(await store.initialDraftRequests.countDocuments({})).toBe(1);
    expect(await store.projectAccountBindings.countDocuments({})).toBe(1);
  });
});

describe('GET /api/projects/accounts', () => {
  it('lists only accounts this customer may create in', async () => {
    const owner = await customer(store, 'owner');
    await tenant(store, 'Acme', [], [{ who: owner, role: 'owner' }]);
    const response = await handleCustomerCreateAccounts(get('/api/projects/accounts', owner), deps);
    const body = (await response.json()) as { accounts: { accountId: string; displayName: string }[] };
    expect(body.accounts).toEqual([{ accountId: expect.any(String), displayName: 'Acme' }]);
  });
});

describe('GET /api/projects/:projectId/generation — exact-draft proof before completed', () => {
  it('reports the mapped state for an in-flight request, and 404s for a request this customer cannot view', async () => {
    const owner = await customer(store, 'owner');
    const account = await tenant(store, 'Acme', [], [{ who: owner, role: 'owner' }]);
    const created = (await createCustomerProject({ store, principal: owner.principal, accountId: account._id, intake: intake('Acme Joinery') })) as { ok: true; accepted: { projectId: string } };
    expect(created.ok).toBe(true);

    const response = await handleCustomerGenerationStatus(get(`/api/projects/${created.accepted.projectId}/generation`, owner), deps, created.accepted.projectId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectId: created.accepted.projectId, state: 'queued', failure: null });

    const outsider = await customer(store, 'outsider');
    expect((await handleCustomerGenerationStatus(get(`/api/projects/${created.accepted.projectId}/generation`, outsider), deps, created.accepted.projectId)).status).toBe(404);
  });

  it('never reports completed on the stored status alone: a mismatched or missing draft still reads as finishing', async () => {
    const owner = await customer(store, 'owner');
    const account = await tenant(store, 'Acme', [], [{ who: owner, role: 'owner' }]);
    const created = (await createCustomerProject({ store, principal: owner.principal, accountId: account._id, intake: intake('Acme Joinery') })) as { ok: true; accepted: { projectId: string } };
    // Simulate exactly the crash/bug this proof defends against: the request
    // claims completion, but no such canonical draft exists yet.
    await store.initialDraftRequests.updateOne({ projectId: created.accepted.projectId }, { $set: { status: 'completed', resultDraftId: 'draft_does_not_exist' } });

    const status = await readCustomerGenerationStatus(store, owner.principal, created.accepted.projectId);
    expect(status).toEqual({ ok: true, status: { projectId: created.accepted.projectId, state: 'finishing', failure: null } });
  });

  it('reports completed once the exact canonical draft the request names genuinely exists and is concluded — proven through the one editor-state authority, against a real draft', async () => {
    const d: Draft = await draftProject(roots());
    const owner = await customer(store, 'owner');
    await tenant(store, 'Acme', [d.projectId], [{ who: owner, role: 'owner' }]);
    await store.initialDraftRequests.insertOne({
      _id: 'ir_test_fixture',
      accountId: 'acct_unused_in_this_check',
      projectId: d.projectId,
      requestedBy: { customerUserId: owner.principal.customerUserId },
      intake: intake('Fixture'),
      intakeDigest: 'digest',
      status: 'completed',
      progress: 'finishing',
      resultDraftId: d.d0._id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const status = await readCustomerGenerationStatus(store, owner.principal, d.projectId);
    expect(status).toEqual({ ok: true, status: { projectId: d.projectId, state: 'completed', failure: null } });
  });
});

describe('the standalone worker, holding a lease, settles a request whose draft is already concluded', () => {
  it('crash-recovery: the worker never re-runs generation once the canonical draft it names already exists — it discovers and records completion', async () => {
    const d: Draft = await draftProject(roots());
    const owner = await customer(store, 'owner');
    const account = await tenant(store, 'Acme', [d.projectId], [{ who: owner, role: 'owner' }]);
    await store.initialDraftRequests.insertOne({
      _id: 'ir_crash_recovery',
      accountId: account._id,
      projectId: d.projectId,
      requestedBy: { customerUserId: owner.principal.customerUserId },
      intake: intake('Fixture'),
      intakeDigest: 'digest',
      status: 'queued',
      progress: 'queued',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await runWorkerOnce();

    const request = await store.initialDraftRequests.findOne({ _id: 'ir_crash_recovery' });
    expect(request).toMatchObject({ status: 'completed', resultDraftId: d.d0._id });
    expect(request?.execution).toBeUndefined();

    const status = await readCustomerGenerationStatus(store, owner.principal, d.projectId);
    expect(status).toEqual({ ok: true, status: { projectId: d.projectId, state: 'completed', failure: null } });
  });
});

describe('projects list reflects generation and never breaks for a legacy operator project', () => {
  it('shows a generating badge while a request is in flight, and no operator-created project ever needs one', async () => {
    const owner = await customer(store, 'owner');
    const account = await tenant(store, 'Acme', [], [{ who: owner, role: 'owner' }]);
    const created = (await createCustomerProject({ store, principal: owner.principal, accountId: account._id, intake: intake('Acme Joinery') })) as { ok: true; accepted: { projectId: string } };

    const response = await handleCustomerProjects(get('/api/projects', owner), deps);
    const body = (await response.json()) as { projects: { projectId: string; generation: string | null; draft: string; displayName: string }[] };
    const listed = body.projects.find((p) => p.projectId === created.accepted.projectId);
    expect(listed).toMatchObject({ generation: 'in_progress', draft: 'none', displayName: 'Acme Joinery' });
  });
});
