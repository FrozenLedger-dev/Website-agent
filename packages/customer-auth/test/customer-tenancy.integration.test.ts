/**
 * Customer project tenancy against real durable state: accounts, memberships,
 * project bindings, and the two central checks — view and edit — through every
 * role, status, tenant boundary and historical project.
 *
 * Integration: needs the Mongo replica set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StateStore, type CustomerRole } from '@statxai/state';
import {
  CUSTOMER_ACCOUNT_ROLE_PERMISSIONS,
  CUSTOMER_ROLE_PERMISSIONS,
  CustomerTenancyConflict,
  authorizeCustomerAccountCreate,
  authorizeCustomerProjectEdit,
  authorizeCustomerProjectView,
  bindProjectToCustomerAccount,
  createCustomerAccount,
  customerProjectDenialResponse,
  grantCustomerMembership,
  listCustomerCreateEligibleAccounts,
  resolveCustomerUser,
  setCustomerAccountStatus,
  setCustomerMembershipStatus,
  type CustomerPrincipal,
} from '../src/index.js';

let store: StateStore;
const ISSUER = 'https://idp.example.com';

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
});

afterAll(async () => {
  await store?.close();
});

beforeEach(async () => {
  for (const c of [store.customerUsers, store.customerAccounts, store.customerMemberships, store.projectAccountBindings]) await (c as { deleteMany(f: object): Promise<unknown> }).deleteMany({});
  await store.projects.deleteMany({ _id: { $regex: /^proj_tenancy_/ } } as never);
});

async function customer(subject: string, email = `${subject}@example.com`): Promise<CustomerPrincipal> {
  const user = await resolveCustomerUser(store, { issuer: ISSUER, subject, email, emailVerified: true, displayName: subject }, new Date());
  return { customerUserId: user._id, externalIdentity: { issuer: ISSUER, subject }, authMethod: 'oidc_session' };
}

/** A project as an operator run creates it — no tenancy field of any kind. */
async function operatorProject(projectId: string): Promise<void> {
  await store.projects.insertOne({ _id: projectId, state: 'planning', autonomyMode: 'full_autonomous', reviewCycle: 0, createdAt: new Date(), updatedAt: new Date() });
}

async function tenant(name: string) {
  const account = await createCustomerAccount(store, { displayName: name });
  const projectId = `proj_tenancy_${name.toLowerCase()}`;
  await operatorProject(projectId);
  await bindProjectToCustomerAccount(store, { projectId, accountId: account._id, boundBy: 'operator:ops' });
  return { account, projectId };
}

const both = async (principal: CustomerPrincipal, projectId: string) => ({
  view: await authorizeCustomerProjectView(store, principal, projectId),
  edit: await authorizeCustomerProjectEdit(store, principal, projectId),
});

describe('roles: view and edit are distinct', () => {
  it('pins the role model: owner and editor view and edit; viewer only views', () => {
    expect(CUSTOMER_ROLE_PERMISSIONS).toEqual({ owner: ['view', 'edit'], editor: ['view', 'edit'], viewer: ['view'] });
  });

  it.each([
    ['owner', true, true],
    ['editor', true, true],
    ['viewer', true, false],
  ] as [CustomerRole, boolean, boolean][])('a %s can view: %s, can edit: %s — from the project’s persisted account', async (role, canView, canEdit) => {
    const { account, projectId } = await tenant('Acme');
    const person = await customer(`${role}-1`);
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: person.customerUserId, role });

    const { view, edit } = await both(person, projectId);
    expect(view.allowed).toBe(canView);
    expect(edit.allowed).toBe(canEdit);
    if (view.allowed) expect(view).toEqual({ allowed: true, permission: 'view', projectId, accountId: account._id, role });
    if (!edit.allowed) expect(edit).toEqual({ allowed: false, permission: 'edit', denial: 'insufficient_role' });
  });

  it('no membership can neither view nor edit', async () => {
    const { projectId } = await tenant('Acme');
    const stranger = await customer('stranger');
    const { view, edit } = await both(stranger, projectId);
    expect([view, edit]).toEqual([
      { allowed: false, permission: 'view', denial: 'no_membership' },
      { allowed: false, permission: 'edit', denial: 'no_membership' },
    ]);
  });
});

describe('revocation', () => {
  it('a disabled membership can neither view nor edit, and a re-enabled one follows its role again', async () => {
    const { account, projectId } = await tenant('Acme');
    const person = await customer('editor-1');
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: person.customerUserId, role: 'editor' });

    await setCustomerMembershipStatus(store, { accountId: account._id, customerUserId: person.customerUserId, status: 'disabled' });
    expect(Object.values(await both(person, projectId)).map((r) => (r.allowed ? 'allowed' : r.denial))).toEqual(['disabled_membership', 'disabled_membership']);

    await setCustomerMembershipStatus(store, { accountId: account._id, customerUserId: person.customerUserId, status: 'active' });
    expect(Object.values(await both(person, projectId)).map((r) => r.allowed)).toEqual([true, true]);
  });

  it('a disabled account blocks every member, and re-enabling restores exactly their active memberships', async () => {
    const { account, projectId } = await tenant('Acme');
    const owner = await customer('owner-1');
    const viewer = await customer('viewer-1');
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: owner.customerUserId, role: 'owner' });
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: viewer.customerUserId, role: 'viewer' });

    await setCustomerAccountStatus(store, account._id, 'disabled');
    for (const person of [owner, viewer]) {
      expect(Object.values(await both(person, projectId)).map((r) => (r.allowed ? 'allowed' : r.denial))).toEqual(['disabled_account', 'disabled_account']);
    }
    await setCustomerAccountStatus(store, account._id, 'active');
    expect(Object.values(await both(owner, projectId)).map((r) => r.allowed)).toEqual([true, true]);
    expect(Object.values(await both(viewer, projectId)).map((r) => r.allowed)).toEqual([true, false]);
  });

  it('a disabled customer user is denied, and a principal whose identity no longer matches its user is refused', async () => {
    const { account, projectId } = await tenant('Acme');
    const person = await customer('owner-1');
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: person.customerUserId, role: 'owner' });

    const forged: CustomerPrincipal = { ...person, externalIdentity: { issuer: ISSUER, subject: 'someone-else' } };
    expect((await authorizeCustomerProjectView(store, forged, projectId)).allowed).toBe(false);

    await store.customerUsers.updateOne({ _id: person.customerUserId }, { $set: { status: 'disabled' } });
    expect(await authorizeCustomerProjectView(store, person, projectId)).toEqual({ allowed: false, permission: 'view', denial: 'disabled_user' });
  });
});

describe('cross-tenant security', () => {
  it('a member of account A can neither view nor edit account B’s project — knowing its id grants nothing', async () => {
    const a = await tenant('Acme');
    const b = await tenant('Bravo');
    const aliceOfA = await customer('alice');
    await grantCustomerMembership(store, { accountId: a.account._id, customerUserId: aliceOfA.customerUserId, role: 'owner' });

    expect((await authorizeCustomerProjectView(store, aliceOfA, a.projectId)).allowed).toBe(true);
    const { view, edit } = await both(aliceOfA, b.projectId);
    expect([view.allowed, edit.allowed]).toEqual([false, false]);
    expect(view).toMatchObject({ denial: 'no_membership' });
  });

  it('a person in both A and B gets authority on each project only from that project’s own account', async () => {
    const a = await tenant('Acme');
    const b = await tenant('Bravo');
    const dual = await customer('dual');
    await grantCustomerMembership(store, { accountId: a.account._id, customerUserId: dual.customerUserId, role: 'viewer' });
    await grantCustomerMembership(store, { accountId: b.account._id, customerUserId: dual.customerUserId, role: 'owner' });

    // Owning B never lends edit authority on A's project.
    expect(await authorizeCustomerProjectEdit(store, dual, a.projectId)).toEqual({ allowed: false, permission: 'edit', denial: 'insufficient_role' });
    expect(await authorizeCustomerProjectEdit(store, dual, b.projectId)).toMatchObject({ allowed: true, accountId: b.account._id, role: 'owner' });
    expect(await authorizeCustomerProjectView(store, dual, a.projectId)).toMatchObject({ allowed: true, accountId: a.account._id, role: 'viewer' });
  });

  it('no request field can claim a tenant: the checks take only a principal and a project id, and ignore anything extra', async () => {
    const a = await tenant('Acme');
    const b = await tenant('Bravo');
    const bob = await customer('bob');
    await grantCustomerMembership(store, { accountId: b.account._id, customerUserId: bob.customerUserId, role: 'owner' });

    expect(authorizeCustomerProjectEdit.length).toBe(3);
    // Bob owns account B, and claims B while asking about A's project: the persisted binding of A decides, not the claim.
    const smuggled = { ...bob, accountId: b.account._id, role: 'owner', tenantId: b.account._id } as unknown as CustomerPrincipal;
    expect(await authorizeCustomerProjectEdit(store, smuggled, a.projectId)).toEqual({ allowed: false, permission: 'edit', denial: 'no_membership' });
    expect(await authorizeCustomerProjectView(store, smuggled, a.projectId)).toEqual({ allowed: false, permission: 'view', denial: 'no_membership' });
  });

  it('every project denial reaches the browser as the same 404: another tenant’s, unbound or nonexistent look identical', async () => {
    const a = await customerProjectDenialResponse().text();
    const b = await customerProjectDenialResponse().text();
    expect(a).toBe(b);
    expect(customerProjectDenialResponse().status).toBe(404);
    expect(JSON.parse(a)).toEqual({ error: 'not_found' });
  });
});

describe('project tenancy', () => {
  it('a historical or operator project with no binding is valid for the operator and inaccessible to every customer', async () => {
    await operatorProject('proj_tenancy_legacy');
    const owner = await customer('owner-1');
    const { account } = await tenant('Acme');
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: owner.customerUserId, role: 'owner' });

    expect(await store.projects.findOne({ _id: 'proj_tenancy_legacy' })).toMatchObject({ state: 'planning' });
    expect(await both(owner, 'proj_tenancy_legacy')).toEqual({
      view: { allowed: false, permission: 'view', denial: 'project_not_customer_accessible' },
      edit: { allowed: false, permission: 'edit', denial: 'project_not_customer_accessible' },
    });
    expect((await authorizeCustomerProjectView(store, owner, 'proj_tenancy_missing')).allowed).toBe(false);
  });

  it('a binding is insert-only: rebinding to the same account is a no-op, and to another account is refused', async () => {
    const a = await tenant('Acme');
    const b = await createCustomerAccount(store, { displayName: 'Bravo' });
    await bindProjectToCustomerAccount(store, { projectId: a.projectId, accountId: a.account._id, boundBy: 'operator:ops' });
    await expect(bindProjectToCustomerAccount(store, { projectId: a.projectId, accountId: b._id, boundBy: 'operator:ops' })).rejects.toBeInstanceOf(CustomerTenancyConflict);
    expect(await store.projectAccountBindings.findOne({ _id: a.projectId })).toMatchObject({ accountId: a.account._id });
    await expect(bindProjectToCustomerAccount(store, { projectId: 'proj_tenancy_x', accountId: 'acct_nonexistent', boundBy: 'operator:ops' })).rejects.toBeInstanceOf(CustomerTenancyConflict);
  });

  it('tenancy survives a run resetting its project document, because it is not stored there', async () => {
    const { account, projectId } = await tenant('Acme');
    const owner = await customer('owner-1');
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: owner.customerUserId, role: 'owner' });
    // Exactly what discovery does at the start of a fresh run.
    await store.projects.deleteOne({ _id: projectId });
    await operatorProject(projectId);
    expect(await authorizeCustomerProjectEdit(store, owner, projectId)).toMatchObject({ allowed: true, accountId: account._id });
  });

  it('a membership is durably unique per account and user: a second grant is refused, never merged', async () => {
    const { account } = await tenant('Acme');
    const person = await customer('editor-1');
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: person.customerUserId, role: 'viewer' });
    await expect(grantCustomerMembership(store, { accountId: account._id, customerUserId: person.customerUserId, role: 'owner' })).rejects.toBeInstanceOf(CustomerTenancyConflict);
    const existing = (await store.customerMemberships.findOne({ accountId: account._id }))!;
    await expect(store.customerMemberships.insertOne({ ...existing, _id: 'mem_duplicate', role: 'owner' })).rejects.toMatchObject({ code: 11000 });
    expect(await store.customerMemberships.countDocuments({ accountId: account._id })).toBe(1);
  });

  it('accounts are opaque and validated, and a membership needs an existing account and user', async () => {
    const account = await createCustomerAccount(store, { displayName: '  Acme Joinery  ' });
    expect(account).toMatchObject({ displayName: 'Acme Joinery', status: 'active' });
    expect(account._id).toMatch(/^acct_[a-f0-9]{32}$/);
    await expect(createCustomerAccount(store, { displayName: '   ' })).rejects.toBeInstanceOf(CustomerTenancyConflict);
    await expect(grantCustomerMembership(store, { accountId: account._id, customerUserId: 'cu_nonexistent', role: 'owner' })).rejects.toBeInstanceOf(CustomerTenancyConflict);
    const person = await customer('someone');
    await expect(grantCustomerMembership(store, { accountId: account._id, customerUserId: person.customerUserId, role: 'admin' as never })).rejects.toBeInstanceOf(CustomerTenancyConflict);
  });
});

describe('account-scoped create authority — before a project exists', () => {
  it('pins the role model: owner and editor may create; viewer never can', () => {
    expect(CUSTOMER_ACCOUNT_ROLE_PERMISSIONS).toEqual({ owner: ['create'], editor: ['create'], viewer: [] });
  });

  it.each([
    ['owner', true],
    ['editor', true],
    ['viewer', false],
  ] as [CustomerRole, boolean][])('a %s may create a project in their own account: %s', async (role, canCreate) => {
    const { account } = await tenant('Acme');
    const person = await customer(`${role}-create`);
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: person.customerUserId, role });

    const authorization = await authorizeCustomerAccountCreate(store, person, account._id);
    expect(authorization.allowed).toBe(canCreate);
    if (canCreate) expect(authorization).toEqual({ allowed: true, permission: 'create', accountId: account._id, role });
    else expect(authorization).toEqual({ allowed: false, permission: 'create', denial: 'insufficient_role' });
  });

  it('no membership, a disabled membership, a disabled account, and a disabled user are all refused — a browser-claimed accountId is never trusted past this', async () => {
    const { account } = await tenant('Acme');
    const stranger = await customer('stranger-create');
    expect(await authorizeCustomerAccountCreate(store, stranger, account._id)).toEqual({ allowed: false, permission: 'create', denial: 'no_membership' });

    const owner = await customer('owner-create');
    await grantCustomerMembership(store, { accountId: account._id, customerUserId: owner.customerUserId, role: 'owner' });
    await setCustomerMembershipStatus(store, { accountId: account._id, customerUserId: owner.customerUserId, status: 'disabled' });
    expect(await authorizeCustomerAccountCreate(store, owner, account._id)).toEqual({ allowed: false, permission: 'create', denial: 'disabled_membership' });
    await setCustomerMembershipStatus(store, { accountId: account._id, customerUserId: owner.customerUserId, status: 'active' });

    await setCustomerAccountStatus(store, account._id, 'disabled');
    expect(await authorizeCustomerAccountCreate(store, owner, account._id)).toEqual({ allowed: false, permission: 'create', denial: 'disabled_account' });
    await setCustomerAccountStatus(store, account._id, 'active');

    expect(await authorizeCustomerAccountCreate(store, owner, 'acct_nonexistent')).toEqual({ allowed: false, permission: 'create', denial: 'unknown_account' });

    await store.customerUsers.updateOne({ _id: owner.customerUserId }, { $set: { status: 'disabled' } });
    expect(await authorizeCustomerAccountCreate(store, owner, account._id)).toEqual({ allowed: false, permission: 'create', denial: 'disabled_user' });
  });

  it('a member of account A cannot create in account B by naming its id — cross-tenant create is refused exactly like cross-tenant view/edit', async () => {
    const a = await tenant('Acme');
    const b = await tenant('Bravo');
    const aliceOfA = await customer('alice-create');
    await grantCustomerMembership(store, { accountId: a.account._id, customerUserId: aliceOfA.customerUserId, role: 'owner' });

    expect((await authorizeCustomerAccountCreate(store, aliceOfA, a.account._id)).allowed).toBe(true);
    expect(await authorizeCustomerAccountCreate(store, aliceOfA, b.account._id)).toEqual({ allowed: false, permission: 'create', denial: 'no_membership' });
  });

  it('lists every active account the customer may create in, with a customer-safe name only — excludes viewer-only accounts, disabled accounts and disabled memberships', async () => {
    const owned = await tenant('Acme');
    const viewedOnly = await tenant('Bravo');
    const disabledAcct = await tenant('Charlie');
    const person = await customer('multi-account');
    await grantCustomerMembership(store, { accountId: owned.account._id, customerUserId: person.customerUserId, role: 'editor' });
    await grantCustomerMembership(store, { accountId: viewedOnly.account._id, customerUserId: person.customerUserId, role: 'viewer' });
    await grantCustomerMembership(store, { accountId: disabledAcct.account._id, customerUserId: person.customerUserId, role: 'owner' });
    await setCustomerAccountStatus(store, disabledAcct.account._id, 'disabled');

    const eligible = await listCustomerCreateEligibleAccounts(store, person);
    expect(eligible).toEqual([{ accountId: owned.account._id, displayName: 'Acme' }]);

    const strangerWithNothing = await customer('nothing');
    expect(await listCustomerCreateEligibleAccounts(store, strangerWithNothing)).toEqual([]);
  });
});
