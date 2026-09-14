/**
 * The one customer authentication boundary.
 *
 * `requireCustomerPrincipal` is the only way any customer route learns who is
 * asking. It reads exactly one thing from the request — the customer session
 * cookie — and resolves everything else from server state: the session row
 * (unexpired, unrevoked) and the customer user (active). It never reads an
 * `Authorization` header, so operator HTTP Basic credentials — or any bearer
 * token — can never produce a customer principal, and nothing a browser sends
 * besides the opaque cookie is consulted at all.
 */
import type { StateStore } from '@statxai/state';
import type { CustomerAuthConfig } from './config.js';
import { readCustomerCookie } from './cookies.js';
import { resolveCustomerSession, type CustomerSessionFailure } from './session.js';

/** A customer, as proven by a live server-side session. Carries no secret and no authority beyond identity. */
export interface CustomerPrincipal {
  readonly customerUserId: string;
  readonly externalIdentity: { readonly issuer: string; readonly subject: string };
  readonly authMethod: 'oidc_session';
}

export type CustomerAuthFailure = CustomerSessionFailure | 'unknown_user' | 'disabled_user';

export type CustomerAuthOutcome =
  | { readonly ok: true; readonly principal: CustomerPrincipal }
  | { readonly ok: false; readonly failure: CustomerAuthFailure };

export interface CustomerPrincipalDeps {
  readonly store: StateStore;
  readonly config: Pick<CustomerAuthConfig, 'secureCookies'>;
  readonly now?: () => Date;
}

export async function requireCustomerPrincipal(request: Request, deps: CustomerPrincipalDeps): Promise<CustomerAuthOutcome> {
  const now = deps.now?.() ?? new Date();
  const session = await resolveCustomerSession(deps.store, readCustomerCookie(request, 'session', deps.config), now);
  if (!session.ok) return session;
  const user = await deps.store.customerUsers.findOne({ _id: session.customerUserId });
  if (!user) return { ok: false, failure: 'unknown_user' };
  if (user.status !== 'active') return { ok: false, failure: 'disabled_user' };
  return {
    ok: true,
    principal: { customerUserId: user._id, externalIdentity: { issuer: user.issuer, subject: user.subject }, authMethod: 'oidc_session' },
  };
}

/** The one unauthenticated response every customer route returns. The cause stays server-side. */
export function customerUnauthenticatedResponse(): Response {
  return Response.json({ error: 'unauthenticated' }, { status: 401, headers: { 'cache-control': 'no-store' } });
}
