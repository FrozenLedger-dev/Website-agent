/**
 * Customer tenancy: accounts, memberships, project ownership — and the two
 * central checks every future customer project route must call.
 *
 * Authority is resolved, in order, from persisted server state only:
 *
 *   principal → the customer user it names (active, same external identity)
 *   project   → it exists, and its binding names exactly one account
 *   account   → active
 *   membership of that user in that account → active
 *   role      → permits the requested permission
 *
 * The checks take a principal and a project id — never an account id, a role or
 * a membership — so there is no parameter through which a browser could claim
 * tenancy. A user who belongs to several accounts gets authority on a project
 * only from the project's own account.
 *
 * Provisioning (accounts, memberships, project binding) is for trusted server
 * code — an operator tool, a future invitation flow — and is never an HTTP
 * route in this slice. A project binding is insert-only: a bound project can
 * never be moved to another account.
 */
import type { CustomerMembershipDocument, CustomerRole, StateStore } from '@statxai/state';
import type { CustomerPrincipal } from './principal.js';
import { newOpaqueId } from './tokens.js';

export type CustomerProjectPermission = 'view' | 'edit';

/** Which roles hold which permission. View and edit are distinct: a viewer can see and never change. */
export const CUSTOMER_ROLE_PERMISSIONS: Readonly<Record<CustomerRole, readonly CustomerProjectPermission[]>> = Object.freeze({
  owner: Object.freeze(['view', 'edit'] as const),
  editor: Object.freeze(['view', 'edit'] as const),
  viewer: Object.freeze(['view'] as const),
});

export type CustomerProjectDenial =
  | 'unknown_user'
  | 'disabled_user'
  | 'identity_mismatch'
  | 'no_project'
  | 'project_not_customer_accessible'
  | 'unknown_account'
  | 'disabled_account'
  | 'no_membership'
  | 'disabled_membership'
  | 'insufficient_role';

export type CustomerProjectAuthorization =
  | {
      readonly allowed: true;
      readonly permission: CustomerProjectPermission;
      readonly projectId: string;
      /** Read from the project's persisted binding — never supplied by a caller. */
      readonly accountId: string;
      readonly role: CustomerRole;
    }
  | { readonly allowed: false; readonly permission: CustomerProjectPermission; readonly denial: CustomerProjectDenial };

async function authorizeProject(
  store: StateStore,
  principal: CustomerPrincipal,
  projectId: string,
  permission: CustomerProjectPermission,
): Promise<CustomerProjectAuthorization> {
  const deny = (denial: CustomerProjectDenial): CustomerProjectAuthorization => ({ allowed: false, permission, denial });

  const user = await store.customerUsers.findOne({ _id: principal.customerUserId });
  if (!user) return deny('unknown_user');
  if (user.status !== 'active') return deny('disabled_user');
  if (user.issuer !== principal.externalIdentity.issuer || user.subject !== principal.externalIdentity.subject) return deny('identity_mismatch');

  if (typeof projectId !== 'string' || projectId.length === 0) return deny('no_project');
  const [project, binding] = await Promise.all([store.projects.findOne({ _id: projectId }), store.projectAccountBindings.findOne({ _id: projectId })]);
  if (!project) return deny('no_project');
  if (!binding) return deny('project_not_customer_accessible');

  const account = await store.customerAccounts.findOne({ _id: binding.accountId });
  if (!account) return deny('unknown_account');
  if (account.status !== 'active') return deny('disabled_account');

  const membership = await store.customerMemberships.findOne({ accountId: binding.accountId, customerUserId: user._id });
  if (!membership) return deny('no_membership');
  if (membership.status !== 'active') return deny('disabled_membership');
  if (!CUSTOMER_ROLE_PERMISSIONS[membership.role].includes(permission)) return deny('insufficient_role');

  return { allowed: true, permission, projectId, accountId: binding.accountId, role: membership.role };
}

// ---------------------------------------------------------------------------
// Account-scoped authority — for actions taken before a project exists
// ---------------------------------------------------------------------------
//
// Project creation has no project to authorise against yet, so it is checked
// against the account instead: the same principal → user → membership → role
// chain as `authorizeProject`, minus the project and its binding. A browser
// may name which account it means; this never trusts that name past
// re-resolving the membership it implies.

export type CustomerAccountPermission = 'create';

/** Which roles may create a project in their account. A viewer never can, centrally — not by omission at each call site. */
export const CUSTOMER_ACCOUNT_ROLE_PERMISSIONS: Readonly<Record<CustomerRole, readonly CustomerAccountPermission[]>> = Object.freeze({
  owner: Object.freeze(['create'] as const),
  editor: Object.freeze(['create'] as const),
  viewer: Object.freeze([] as const),
});

export type CustomerAccountDenial = 'unknown_user' | 'disabled_user' | 'identity_mismatch' | 'unknown_account' | 'disabled_account' | 'no_membership' | 'disabled_membership' | 'insufficient_role';

export type CustomerAccountAuthorization =
  | { readonly allowed: true; readonly permission: CustomerAccountPermission; readonly accountId: string; readonly role: CustomerRole }
  | { readonly allowed: false; readonly permission: CustomerAccountPermission; readonly denial: CustomerAccountDenial };

/** May this customer create a project in this account? Re-resolves the membership server-side; a browser-supplied `accountId` is never trusted past this. */
export async function authorizeCustomerAccountCreate(store: StateStore, principal: CustomerPrincipal, accountId: string): Promise<CustomerAccountAuthorization> {
  const deny = (denial: CustomerAccountDenial): CustomerAccountAuthorization => ({ allowed: false, permission: 'create', denial });

  const user = await store.customerUsers.findOne({ _id: principal.customerUserId });
  if (!user) return deny('unknown_user');
  if (user.status !== 'active') return deny('disabled_user');
  if (user.issuer !== principal.externalIdentity.issuer || user.subject !== principal.externalIdentity.subject) return deny('identity_mismatch');

  if (typeof accountId !== 'string' || accountId.length === 0) return deny('unknown_account');
  const account = await store.customerAccounts.findOne({ _id: accountId });
  if (!account) return deny('unknown_account');
  if (account.status !== 'active') return deny('disabled_account');

  const membership = await store.customerMemberships.findOne({ accountId, customerUserId: user._id });
  if (!membership) return deny('no_membership');
  if (membership.status !== 'active') return deny('disabled_membership');
  if (!CUSTOMER_ACCOUNT_ROLE_PERMISSIONS[membership.role].includes('create')) return deny('insufficient_role');

  return { allowed: true, permission: 'create', accountId, role: membership.role };
}

/**
 * Every active account this customer may create a project in, with a
 * customer-safe display name only — for the "which account" picker. A user in
 * exactly one eligible account is the common case a caller can default
 * silently; more than one means the browser must ask.
 */
export async function listCustomerCreateEligibleAccounts(store: StateStore, principal: CustomerPrincipal): Promise<Array<{ readonly accountId: string; readonly displayName: string }>> {
  const user = await store.customerUsers.findOne({ _id: principal.customerUserId });
  if (!user || user.status !== 'active') return [];
  const memberships = await store.customerMemberships
    .find({ customerUserId: user._id, status: 'active', role: { $in: ['owner', 'editor'] } })
    .toArray();
  if (memberships.length === 0) return [];
  const accounts = await store.customerAccounts.find({ _id: { $in: memberships.map((m) => m.accountId) }, status: 'active' }).toArray();
  return accounts.map((account) => ({ accountId: account._id, displayName: account.displayName }));
}

/** May this customer see this project? */
export function authorizeCustomerProjectView(store: StateStore, principal: CustomerPrincipal, projectId: string): Promise<CustomerProjectAuthorization> {
  return authorizeProject(store, principal, projectId, 'view');
}

/** May this customer change this project? Never implied by view. */
export function authorizeCustomerProjectEdit(store: StateStore, principal: CustomerPrincipal, projectId: string): Promise<CustomerProjectAuthorization> {
  return authorizeProject(store, principal, projectId, 'edit');
}

/**
 * The response a customer route returns for any project denial: the same 404
 * whether the project is another tenant's, not customer-accessible, or does not
 * exist — so a project id reveals nothing. The typed denial stays server-side.
 */
export function customerProjectDenialResponse(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// Trusted provisioning — server code only, never an HTTP route in this slice
// ---------------------------------------------------------------------------

export class CustomerTenancyConflict extends Error {
  constructor(detail: string) {
    super(`customer tenancy refused: ${detail}`);
    this.name = 'CustomerTenancyConflict';
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

export async function createCustomerAccount(store: StateStore, input: { readonly displayName: string }, now = new Date()) {
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 120) throw new CustomerTenancyConflict('an account needs a display name of 1–120 characters');
  const account = { _id: newOpaqueId('acct'), displayName, status: 'active' as const, createdAt: now, updatedAt: now };
  await store.customerAccounts.insertOne(account);
  return account;
}

export async function setCustomerAccountStatus(store: StateStore, accountId: string, status: 'active' | 'disabled', now = new Date()): Promise<void> {
  const result = await store.customerAccounts.updateOne({ _id: accountId }, { $set: { status, updatedAt: now } });
  if (result.matchedCount === 0) throw new CustomerTenancyConflict(`no account ${accountId}`);
}

/** Grant one user one role in one account. A second membership for the same pair is refused by the unique index, never merged. */
export async function grantCustomerMembership(
  store: StateStore,
  input: { readonly accountId: string; readonly customerUserId: string; readonly role: CustomerRole },
  now = new Date(),
): Promise<CustomerMembershipDocument> {
  if (!(input.role in CUSTOMER_ROLE_PERMISSIONS)) throw new CustomerTenancyConflict(`unknown role ${String(input.role)}`);
  const [account, user] = await Promise.all([store.customerAccounts.findOne({ _id: input.accountId }), store.customerUsers.findOne({ _id: input.customerUserId })]);
  if (!account) throw new CustomerTenancyConflict(`no account ${input.accountId}`);
  if (!user) throw new CustomerTenancyConflict(`no customer user ${input.customerUserId}`);
  const membership: CustomerMembershipDocument = { _id: newOpaqueId('mem'), accountId: input.accountId, customerUserId: input.customerUserId, role: input.role, status: 'active', createdAt: now, updatedAt: now };
  try {
    await store.customerMemberships.insertOne(membership);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new CustomerTenancyConflict('that user already has a membership in that account');
    throw error;
  }
  return membership;
}

export async function setCustomerMembershipStatus(
  store: StateStore,
  input: { readonly accountId: string; readonly customerUserId: string; readonly status: 'active' | 'disabled' },
  now = new Date(),
): Promise<void> {
  const result = await store.customerMemberships.updateOne({ accountId: input.accountId, customerUserId: input.customerUserId }, { $set: { status: input.status, updatedAt: now } });
  if (result.matchedCount === 0) throw new CustomerTenancyConflict('no such membership');
}

/**
 * Bind a project to the account that owns it. Insert-only on the project id:
 * binding the same project to the same account again is a no-op, and binding it
 * to any other account is refused — a customer project is never transferred.
 */
export async function bindProjectToCustomerAccount(
  store: StateStore,
  input: { readonly projectId: string; readonly accountId: string; readonly boundBy: string },
  now = new Date(),
): Promise<void> {
  if (!input.boundBy) throw new CustomerTenancyConflict('a binding records which trusted authority made it');
  const account = await store.customerAccounts.findOne({ _id: input.accountId });
  if (!account) throw new CustomerTenancyConflict(`no account ${input.accountId}`);
  try {
    await store.projectAccountBindings.insertOne({ _id: input.projectId, accountId: input.accountId, boundBy: input.boundBy, boundAt: now });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await store.projectAccountBindings.findOne({ _id: input.projectId });
    if (existing?.accountId === input.accountId) return;
    throw new CustomerTenancyConflict(`project ${input.projectId} already belongs to another account`);
  }
}
