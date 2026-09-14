/**
 * The customer authentication HTTP surface — login, callback, logout, me —
 * as framework-agnostic `Request → Response` handlers.
 *
 * Nothing else: no project data, no editor, no artifact or workspace access.
 * Every failure a browser sees is a generic, cacheless response; the cause is
 * never echoed, and no provider token, session token or database document is
 * ever part of a response body.
 *
 * **Same-origin rule for customer mutations.** Every session-authenticated
 * customer request that changes anything must pass
 * {@link isSameOriginCustomerMutation} before doing any work — logout here, and
 * every future customer mutation route. Together with the session cookie's
 * `SameSite=Lax`, it refuses cross-site form posts and scripted requests
 * without any per-route token scheme.
 */
import * as client from 'openid-client';
import type { StateStore } from '@statxai/state';
import { CUSTOMER_CALLBACK_PATH, CUSTOMER_LOGIN_TTL_SECONDS, type CustomerAuthConfig } from './config.js';
import { readCustomerCookie, serializeCustomerCookie } from './cookies.js';
import { resolveCustomerUser } from './identity.js';
import type { CustomerOidcConfiguration } from './oidc.js';
import { customerUnauthenticatedResponse, requireCustomerPrincipal } from './principal.js';
import { createCustomerSession, revokeCustomerSession } from './session.js';
import { hashToken, newOpaqueToken } from './tokens.js';

export interface CustomerAuthHttpDeps {
  readonly store: StateStore;
  readonly config: CustomerAuthConfig;
  readonly oidc: CustomerOidcConfiguration;
  readonly now?: () => Date;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;
const SCOPE = 'openid email profile';

/** Where a login may return to: a same-site absolute path, and nothing that could leave the app. */
export function safeReturnTo(value: string | null): string {
  if (!value || !/^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]*$/.test(value) || value.length > 512) return '/';
  return value;
}

/** Whether a mutating customer request comes from the customer app's own origin. Fails closed when it cannot tell. */
export function isSameOriginCustomerMutation(request: Request, config: Pick<CustomerAuthConfig, 'appOrigin'>): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === config.appOrigin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

function loginFailed(config: CustomerAuthConfig): Response {
  const headers = new Headers(NO_STORE);
  headers.append('set-cookie', serializeCustomerCookie('login', null, 0, config));
  return Response.json({ error: 'login_failed' }, { status: 400, headers });
}

/** GET /api/auth/login — start an Authorization Code + PKCE login. */
export async function handleCustomerLogin(request: Request, deps: CustomerAuthHttpDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const attemptToken = newOpaqueToken();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

  await deps.store.customerLoginAttempts.insertOne({
    _id: hashToken(attemptToken),
    state,
    nonce,
    codeVerifier,
    returnTo: safeReturnTo(new URL(request.url).searchParams.get('returnTo')),
    createdAt: now,
    expiresAt: new Date(now.getTime() + CUSTOMER_LOGIN_TTL_SECONDS * 1000),
    consumedAt: null,
  });

  const location = client.buildAuthorizationUrl(deps.oidc, {
    redirect_uri: new URL(CUSTOMER_CALLBACK_PATH, deps.config.appOrigin).href,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  const headers = new Headers({ ...NO_STORE, location: location.href });
  headers.append('set-cookie', serializeCustomerCookie('login', attemptToken, CUSTOMER_LOGIN_TTL_SECONDS, deps.config));
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/callback — finish the login the provider redirected back from, and open a session. */
export async function handleCustomerCallback(request: Request, deps: CustomerAuthHttpDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const attemptToken = readCustomerCookie(request, 'login', deps.config);
  if (!attemptToken) return loginFailed(deps.config);

  // Consumed exactly once, and only while fresh: a replayed or late callback finds nothing.
  const attempt = await deps.store.customerLoginAttempts.findOneAndUpdate(
    { _id: hashToken(attemptToken), consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now } },
    { returnDocument: 'after' },
  );
  if (!attempt) return loginFailed(deps.config);

  // The callback URL is rebuilt from the configured origin, never from the Host a proxy or client supplied.
  const currentUrl = new URL(CUSTOMER_CALLBACK_PATH, deps.config.appOrigin);
  for (const [key, value] of new URL(request.url).searchParams) currentUrl.searchParams.append(key, value);

  let claims: client.IDToken | undefined;
  try {
    const tokens = await client.authorizationCodeGrant(deps.oidc, currentUrl, {
      pkceCodeVerifier: attempt.codeVerifier,
      expectedState: attempt.state,
      expectedNonce: attempt.nonce,
      idTokenExpected: true,
    });
    claims = tokens.claims();
  } catch {
    return loginFailed(deps.config);
  }

  // Validated by the library; checked again against our own configuration so identity is never taken from anywhere else.
  if (!claims || claims.iss !== deps.config.issuer || claims.iss !== deps.oidc.serverMetadata().issuer) return loginFailed(deps.config);
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return loginFailed(deps.config);

  const user = await resolveCustomerUser(
    deps.store,
    {
      issuer: claims.iss,
      subject: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: typeof claims.email_verified === 'boolean' ? claims.email_verified : null,
      displayName: typeof claims.name === 'string' ? claims.name : null,
    },
    now,
  );
  if (user.status !== 'active') return loginFailed(deps.config);

  // Signing in proves identity only. No account and no membership is created: access is provisioned, never self-granted.
  const session = await createCustomerSession(deps.store, user._id, deps.config.sessionTtlSeconds, now);
  const headers = new Headers({ ...NO_STORE, location: new URL(attempt.returnTo, deps.config.appOrigin).href });
  headers.append('set-cookie', serializeCustomerCookie('login', null, 0, deps.config));
  headers.append('set-cookie', serializeCustomerCookie('session', session.token, deps.config.sessionTtlSeconds, deps.config));
  return new Response(null, { status: 303, headers });
}

/** POST /api/auth/logout — revoke this session server-side, then clear its cookie. */
export async function handleCustomerLogout(request: Request, deps: CustomerAuthHttpDeps): Promise<Response> {
  if (!isSameOriginCustomerMutation(request, deps.config)) return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
  const token = readCustomerCookie(request, 'session', deps.config);
  if (token) await revokeCustomerSession(deps.store, token, deps.now?.() ?? new Date());
  const headers = new Headers(NO_STORE);
  headers.append('set-cookie', serializeCustomerCookie('session', null, 0, deps.config));
  return new Response(null, { status: 204, headers });
}

/** The customer-safe session view: who this is, and the accounts they may act in. Nothing else. */
export interface CustomerMeResponse {
  readonly customerUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly accounts: readonly { readonly accountId: string; readonly displayName: string; readonly role: string }[];
}

/** GET /api/auth/me */
export async function handleCustomerMe(request: Request, deps: Pick<CustomerAuthHttpDeps, 'store' | 'config' | 'now'>): Promise<Response> {
  const auth = await requireCustomerPrincipal(request, deps);
  if (!auth.ok) return customerUnauthenticatedResponse();
  const user = await deps.store.customerUsers.findOne({ _id: auth.principal.customerUserId });
  if (!user) return customerUnauthenticatedResponse();

  const memberships = await deps.store.customerMemberships.find({ customerUserId: user._id, status: 'active' }).toArray();
  const accounts = memberships.length
    ? await deps.store.customerAccounts.find({ _id: { $in: memberships.map((m) => m.accountId) }, status: 'active' }).toArray()
    : [];
  const body: CustomerMeResponse = {
    customerUserId: user._id,
    email: user.email,
    displayName: user.displayName,
    accounts: accounts
      .map((account) => ({ accountId: account._id, displayName: account.displayName, role: memberships.find((m) => m.accountId === account._id)!.role }))
      .sort((a, b) => (a.accountId < b.accountId ? -1 : 1)),
  };
  return Response.json(body, { status: 200, headers: NO_STORE });
}
