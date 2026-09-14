/**
 * The projects one customer may see — from persisted tenancy only.
 *
 *   principal → active memberships of that user
 *     → the active accounts they belong to
 *     → project bindings of exactly those accounts (indexed by account)
 *     → each project authorised again through the one central view check
 *
 * The request contributes nothing but the session: no account id, role or
 * filter is read from it, so nothing a browser sends can widen the list. The
 * summary is bounded and customer-safe; the full proof of a draft happens when
 * its editor is opened.
 */
import { authorizeCustomerProjectView, type CustomerPrincipal } from '@statxai/customer-auth';
import { readSemanticEditExecutionStatus } from '@statxai/orchestrator';
import type { StateStore } from '@statxai/state';
import type { CustomerProjectSummary, DraftEditability } from './dto.js';

/** At most this many projects are listed for one customer. */
export const MAX_LISTED_PROJECTS = 200;

async function draftSummary(store: StateStore, projectId: string): Promise<'none' | DraftEditability> {
  const draft = await store.canonicalDrafts.findOne({ projectId, current: true }, { projection: { status: 1, claim: 1 } });
  if (!draft) return 'none';
  if (draft.status === 'available') return 'ready_to_edit';
  if (draft.claim?.kind !== 'semantic_edit') return 'busy';
  const edit = await readSemanticEditExecutionStatus(store, projectId, draft.claim.operationId);
  return edit?.state === 'failed' ? 'edit_failed' : 'edit_in_progress';
}

export async function listCustomerProjects(store: StateStore, principal: CustomerPrincipal): Promise<CustomerProjectSummary[]> {
  const user = await store.customerUsers.findOne({ _id: principal.customerUserId });
  if (!user || user.status !== 'active') return [];
  const memberships = await store.customerMemberships.find({ customerUserId: user._id, status: 'active' }).limit(MAX_LISTED_PROJECTS).toArray();
  if (memberships.length === 0) return [];
  const accounts = await store.customerAccounts.find({ _id: { $in: memberships.map((m) => m.accountId) }, status: 'active' }).toArray();
  if (accounts.length === 0) return [];
  const bindings = await store.projectAccountBindings
    .find({ accountId: { $in: accounts.map((a) => a._id) } })
    .sort({ _id: 1 })
    .limit(MAX_LISTED_PROJECTS)
    .toArray();

  const projects: CustomerProjectSummary[] = [];
  for (const binding of bindings) {
    // The same central check every project route makes; a project it denies is not listed.
    const authorization = await authorizeCustomerProjectView(store, principal, binding._id);
    if (!authorization.allowed) continue;
    const account = accounts.find((a) => a._id === authorization.accountId);
    projects.push({ projectId: binding._id, accountName: account?.displayName ?? '', role: authorization.role, draft: await draftSummary(store, binding._id) });
  }
  return projects;
}
