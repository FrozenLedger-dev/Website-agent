/**
 * Customer self-service project creation: the trusted service the customer
 * `POST /api/projects` and generation-status routes call.
 *
 *   principal → resolve (and re-authorise) which account owns this →
 *   validate the intake against the one existing contract → durable creation
 *   request, minted project id and account binding, all inside
 *   `@statxai/orchestrator`'s `createInitialDraftRequest` → bounded, customer-
 *   safe accepted response
 *
 * The browser supplies exactly the intake and, optionally, which account —
 * never a project id, a request id or a role. An `accountId` the browser
 * sends is always re-resolved through `authorizeCustomerAccountCreate`; a
 * customer with exactly one eligible account may omit it and this defaults
 * silently, but a browser-forged mismatch between "the account I claim" and
 * "the account this session actually belongs to" is refused, never trusted.
 *
 * Reading status is a separate, narrower concern: `readCustomerGenerationStatus`
 * never reports `completed` on the stored request's word alone — it re-proves
 * the exact canonical draft the request names actually exists and is
 * concluded, the same authority `loadCustomerEditorState` itself proves,
 * before a customer route (or the browser polling it) ever treats generation
 * as finished.
 */
import { authorizeCustomerAccountCreate, authorizeCustomerProjectView, listCustomerCreateEligibleAccounts, type CustomerPrincipal } from '@statxai/customer-auth';
import { createInitialDraftRequest, InitialDraftRequestRefused, validateIntake } from '@statxai/orchestrator';
import type { InitialDraftRequestDocument, StateStore } from '@statxai/state';
import type { CustomerCreateEligibleAccount, CustomerGenerationState, CustomerGenerationStatusView, CustomerProjectCreateAccepted, CustomerProjectCreateError } from './dto.js';
import { loadCustomerEditorState } from './editor-state.js';

/** The largest project-creation request body read. Generous for a free-text business brief, still far short of an abuse-sized payload. */
export const MAX_PROJECT_CREATE_REQUEST_BYTES = 32 * 1024;

export type CustomerProjectCreation = { readonly ok: true; readonly accepted: CustomerProjectCreateAccepted } | { readonly ok: false; readonly error: CustomerProjectCreateError };

function mapGenerationState(request: InitialDraftRequestDocument, provenComplete: boolean): CustomerGenerationState {
  if (request.status === 'failed') return 'failed';
  if (request.status === 'completed') return provenComplete ? 'completed' : 'finishing';
  return request.progress;
}

/** Every account this customer may create a project in — for a "which account" picker the browser shows only when there is more than one. */
export function listCustomerCreateAccounts(store: StateStore, principal: CustomerPrincipal): Promise<CustomerCreateEligibleAccount[]> {
  return listCustomerCreateEligibleAccounts(store, principal);
}

async function resolveCreateAccount(store: StateStore, principal: CustomerPrincipal, requestedAccountId: string | undefined): Promise<{ readonly ok: true; readonly accountId: string } | { readonly ok: false; readonly error: 'forbidden' | 'account_required' }> {
  if (requestedAccountId !== undefined) {
    const authorization = await authorizeCustomerAccountCreate(store, principal, requestedAccountId);
    return authorization.allowed ? { ok: true, accountId: authorization.accountId } : { ok: false, error: 'forbidden' };
  }
  const eligible = await listCustomerCreateEligibleAccounts(store, principal);
  if (eligible.length === 1) return { ok: true, accountId: eligible[0]!.accountId };
  return { ok: false, error: 'account_required' };
}

/**
 * Create (or resolve the exact replay of) one customer's initial draft
 * generation request. Authorises the account, validates the intake against the
 * existing `BusinessProfile` contract, and hands off durably — nothing here
 * plans, builds or evaluates anything.
 */
export async function createCustomerProject(input: { readonly store: StateStore; readonly principal: CustomerPrincipal; readonly accountId?: string; readonly intake: unknown }): Promise<CustomerProjectCreation> {
  const account = await resolveCreateAccount(input.store, input.principal, input.accountId);
  if (!account.ok) return { ok: false, error: account.error };

  const validated = validateIntake(input.intake);
  if (!validated.ok) return { ok: false, error: 'invalid_request' };

  try {
    const created = await createInitialDraftRequest(input.store, {
      accountId: account.accountId,
      customerUserId: input.principal.customerUserId,
      intake: validated.profile,
      boundBy: 'customer-project-creation',
    });
    const request = await input.store.initialDraftRequests.findOne({ _id: created.requestId });
    const state = request ? mapGenerationState(request, false) : 'queued';
    return { ok: true, accepted: { creationRequestId: created.requestId, projectId: created.projectId, status: state } };
  } catch (error) {
    if (error instanceof InitialDraftRequestRefused) return { ok: false, error: 'too_many_active' };
    throw error;
  }
}

/**
 * One project's generation status, by exact project id — bounded and
 * customer-safe. `completed` is reported only once the exact canonical draft
 * the request names is independently proven to exist and be concluded; until
 * then a request whose stored status is already `completed` still reports
 * `finishing`, never a premature redirect signal.
 */
export async function readCustomerGenerationStatus(store: StateStore, principal: CustomerPrincipal, projectId: string): Promise<{ readonly ok: true; readonly status: CustomerGenerationStatusView } | { readonly ok: false }> {
  const authorization = await authorizeCustomerProjectView(store, principal, projectId);
  if (!authorization.allowed) return { ok: false };
  const request = await store.initialDraftRequests.findOne({ projectId });
  if (!request) return { ok: false };

  let provenComplete = false;
  if (request.status === 'completed') {
    // Re-proven through the one editor-state authority, never a second
    // resolution path: `completed` is reported only once this project's
    // current editor state genuinely has a draft, and it is exactly the one
    // this request produced.
    const load = await loadCustomerEditorState(store, principal, projectId);
    provenComplete = load.ok && load.state.kind === 'draft' && load.authority?.draft._id === request.resultDraftId;
  }
  const state = mapGenerationState(request, provenComplete);
  return { ok: true, status: { projectId, state, failure: state === 'failed' ? (request.disposition?.reason ?? 'needs_attention') : null } };
}
