/**
 * Customer authentication end to end: a real OpenID Connect Authorization Code
 * + PKCE login through `openid-client` against a local provider that signs real
 * ID tokens, into real server-side sessions in Mongo — and every way that must
 * fail: tampered state, nonce, issuer, subject, signature, expiry, replay,
 * forged or revoked sessions, and operator Basic credentials.
 *
 * Integration: needs the Mongo replica set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allowInsecureRequests } from 'openid-client';
import { StateStore } from '@statxai/state';
import {
  customerAuthConfigFromEnv,
  discoverCustomerOidc,
  handleCustomerCallback,
  handleCustomerLogin,
  handleCustomerLogout,
  handleCustomerMe,
  requireCustomerPrincipal,
  revokeAllCustomerSessions,
  type CustomerAuthConfig,
  type CustomerAuthHttpDeps,
} from '../src/index.js';
import { MockOidcProvider, type IssuedIdentity } from './support/mock-oidc-provider.js';

const APP = 'http://localhost:3200';
let store: StateStore;
let provider: MockOidcProvider;
let deps: CustomerAuthHttpDeps;
let config: CustomerAuthConfig;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  provider = new MockOidcProvider();
  await provider.start();
  config = customerAuthConfigFromEnv({
    NODE_ENV: 'test',
    CUSTOMER_OIDC_ISSUER: provider.issuer,
    CUSTOMER_OIDC_CLIENT_ID: provider.clientId,
    CUSTOMER_OIDC_CLIENT_SECRET: provider.clientSecret,
    CUSTOMER_APP_ORIGIN: APP,
  });
  // The only place insecure (http) provider requests are allowed: this local test provider.
  const oidc = await discoverCustomerOidc(config, { execute: [allowInsecureRequests] });
  deps = { store, config, oidc };
});

afterAll(async () => {
  await provider?.stop();
  await store?.close();
});

beforeEach(async () => {
  await store.customerUsers.deleteMany({});
  await store.customerSessions.deleteMany({});
  await store.customerLoginAttempts.deleteMany({});
  await store.customerMemberships.deleteMany({});
  await store.customerAccounts.deleteMany({});
});

const cookieValue = (response: Response, name: string): string | null => {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const [key, value] = pair!.split('=');
    if (key === name) return value ?? '';
  }
  return null;
};
const setCookie = (response: Response, name: string) => response.headers.getSetCookie().find((h) => h.startsWith(`${name}=`))!;
const withCookie = (url: string, cookie: string, init: RequestInit = {}) => new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });

/** Everything a browser does for one login. Returns the callback response and the login cookie it used. */
async function login(identity: IssuedIdentity, tamper: { state?: string; callbackUrl?: (url: string) => string; beforeCallback?: () => Promise<void> } = {}) {
  const start = await handleCustomerLogin(new Request(`${APP}/api/auth/login?returnTo=/projects`), deps);
  const loginCookie = cookieValue(start, 'statx_customer_login')!;
  let callback = provider.authorize(start.headers.get('location')!, identity, tamper.state ? { state: tamper.state } : {});
  if (tamper.callbackUrl) callback = tamper.callbackUrl(callback);
  await tamper.beforeCallback?.();
  const request = withCookie(callback, `statx_customer_login=${loginCookie}`);
  return { start, loginCookie, callback, response: await handleCustomerCallback(request, deps), request };
}

const sessionCookieOf = (response: Response) => cookieValue(response, 'statx_customer_session');
const principalFor = (token: string | null, extra: Record<string, string> = {}) =>
  requireCustomerPrincipal(new Request(`${APP}/api/auth/me`, { headers: { ...(token ? { cookie: `statx_customer_session=${token}` } : {}), ...extra } }), deps);

describe('an OpenID Connect login', () => {
  it('uses Authorization Code with PKCE S256, state and nonce, redirecting to the exact configured callback', async () => {
    const start = await handleCustomerLogin(new Request(`${APP}/api/auth/login`), deps);
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get('location')!);
    expect(url.origin + url.pathname).toBe(`${provider.issuer}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(provider.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP}/api/auth/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    // The verifier, state and nonce live server-side; the browser holds only an opaque cookie.
    expect(start.headers.get('location')).not.toContain('code_verifier');
    expect(setCookie(start, 'statx_customer_login')).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600$/);
    expect(await store.customerLoginAttempts.countDocuments()).toBe(1);
  });

  it('a valid login resolves exactly one customer user by issuer and subject, opens a server-side session, and grants nothing', async () => {
    const { response } = await login({ sub: 'user-123', email: 'ada@example.com', name: 'Ada' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP}/projects`);
    const session = sessionCookieOf(response)!;
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie(response, 'statx_customer_session')).toBe(`statx_customer_session=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
    expect(setCookie(response, 'statx_customer_login')).toContain('Max-Age=0');

    const users = await store.customerUsers.find().toArray();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ issuer: provider.issuer, subject: 'user-123', email: 'ada@example.com', displayName: 'Ada', status: 'active' });
    expect(users[0]!._id).toMatch(/^cu_[a-f0-9]{32}$/);
    // The database holds a hash, never the token; and no provider token is stored anywhere.
    const sessions = await store.customerSessions.find().toArray();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!._id).not.toBe(session);
    expect(JSON.stringify([users, sessions, await store.customerLoginAttempts.find().toArray()])).not.toMatch(/provider-access-token|provider-refresh-token|eyJ/);
    // Invite-only: signing in creates no account and no membership.
    expect(await store.customerAccounts.countDocuments()).toBe(0);
    expect(await store.customerMemberships.countDocuments()).toBe(0);

    const principal = await principalFor(session);
    expect(principal).toEqual({ ok: true, principal: { customerUserId: users[0]!._id, externalIdentity: { issuer: provider.issuer, subject: 'user-123' }, authMethod: 'oidc_session' } });
  });

  it.each([
    ['a tampered state', { state: 'attacker-state' }, {}],
    ['a nonce the login did not issue', {}, { claims: { nonce: 'replayed-nonce' } }],
    ['another issuer', {}, { claims: { iss: 'https://evil.example.com' } }],
    ['another audience', {}, { claims: { aud: 'someone-else' } }],
    ['an expired ID token', {}, { claims: { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 } }],
    ['no subject', {}, { sub: undefined }],
    ['an empty subject', {}, { sub: '' }],
    ['a signature from a key the provider does not publish', {}, { foreignKey: true }],
  ] as const)('rejects %s, opening no session and creating no user', async (_label, tamper, identity) => {
    const { response } = await login({ sub: 'user-123', email: 'ada@example.com', ...identity } as IssuedIdentity, tamper);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'login_failed' });
    expect(sessionCookieOf(response)).toBeNull();
    expect(await store.customerSessions.countDocuments()).toBe(0);
    expect(await store.customerUsers.countDocuments()).toBe(0);
  });

  it('PKCE is enforced end to end: a code exchanged with the wrong verifier is refused by the provider and the login fails', async () => {
    const { response } = await login({ sub: 'user-123' }, {
      beforeCallback: async () => {
        await store.customerLoginAttempts.updateMany({}, { $set: { codeVerifier: 'a'.repeat(43) } });
      },
    });
    expect(response.status).toBe(400);
    expect(await store.customerSessions.countDocuments()).toBe(0);
  });

  it('a login attempt is consumed exactly once: a replayed callback, a missing login cookie, or a stale attempt all fail', async () => {
    const first = await login({ sub: 'user-123' });
    expect(first.response.status).toBe(303);
    const replay = await handleCustomerCallback(withCookie(first.callback, `statx_customer_login=${first.loginCookie}`), deps);
    expect(replay.status).toBe(400);

    const start = await handleCustomerLogin(new Request(`${APP}/api/auth/login`), deps);
    const callback = provider.authorize(start.headers.get('location')!, { sub: 'user-456' });
    expect((await handleCustomerCallback(new Request(callback), deps)).status).toBe(400);

    const stale = await handleCustomerLogin(new Request(`${APP}/api/auth/login`), deps);
    await store.customerLoginAttempts.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const staleCallback = provider.authorize(stale.headers.get('location')!, { sub: 'user-789' });
    expect((await handleCustomerCallback(withCookie(staleCallback, `statx_customer_login=${cookieValue(stale, 'statx_customer_login')}`), deps)).status).toBe(400);
    expect(await store.customerUsers.countDocuments()).toBe(1);
  });

  it('never leaks the client secret, or any provider token, in any response', async () => {
    const { start, response } = await login({ sub: 'user-123', email: 'ada@example.com' });
    const me = await handleCustomerMe(withCookie(`${APP}/api/auth/me`, `statx_customer_session=${sessionCookieOf(response)}`), deps);
    for (const r of [start, response, me]) {
      const text = `${[...r.headers.entries()].map(([k, v]) => `${k}:${v}`).join('\n')}\n${await r.clone().text()}`;
      expect(text).not.toContain(provider.clientSecret);
      expect(text).not.toMatch(/provider-access-token|provider-refresh-token|id_token|eyJ/);
    }
  });

  it('only a same-site path may be returned to after login', async () => {
    for (const returnTo of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com', 'javascript:alert(1)']) {
      const start = await handleCustomerLogin(new Request(`${APP}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`), deps);
      const callback = provider.authorize(start.headers.get('location')!, { sub: `user-${returnTo.length}` });
      const response = await handleCustomerCallback(withCookie(callback, `statx_customer_login=${cookieValue(start, 'statx_customer_login')}`), deps);
      expect(response.headers.get('location')).toBe(`${APP}/`);
    }
  });
});

describe('identity', () => {
  it('issuer and subject identify one customer user: the same subject again is the same user, even with a changed email', async () => {
    const first = await login({ sub: 'user-123', email: 'ada@example.com' });
    const again = await login({ sub: 'user-123', email: 'ada@new-domain.example' });
    const users = await store.customerUsers.find().toArray();
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe('ada@new-domain.example');
    const a = await principalFor(sessionCookieOf(first.response));
    const b = await principalFor(sessionCookieOf(again.response));
    expect(a.ok && b.ok && a.principal.customerUserId === b.principal.customerUserId).toBe(true);
  });

  it('the same email under a different subject is a different person, never merged', async () => {
    await login({ sub: 'user-123', email: 'shared@example.com' });
    await login({ sub: 'user-999', email: 'shared@example.com' });
    const users = await store.customerUsers.find().sort({ subject: 1 }).toArray();
    expect(users.map((u) => u.subject)).toEqual(['user-123', 'user-999']);
    expect(users[0]!._id).not.toBe(users[1]!._id);
  });

  it('the external identity is durably unique: a second row for the same issuer and subject cannot be written', async () => {
    await login({ sub: 'user-123' });
    const [user] = await store.customerUsers.find().toArray();
    await expect(store.customerUsers.insertOne({ ...user!, _id: 'cu_ffffffffffffffffffffffffffffffff' })).rejects.toMatchObject({ code: 11000 });
  });
});

describe('sessions', () => {
  it('logout revokes the session server-side at once: the same cookie no longer resolves', async () => {
    const { response } = await login({ sub: 'user-123' });
    const token = sessionCookieOf(response)!;
    expect((await principalFor(token)).ok).toBe(true);

    const logout = await handleCustomerLogout(withCookie(`${APP}/api/auth/logout`, `statx_customer_session=${token}`, { method: 'POST', headers: { origin: APP } }), deps);
    expect(logout.status).toBe(204);
    expect(setCookie(logout, 'statx_customer_session')).toContain('Max-Age=0');
    expect(await principalFor(token)).toEqual({ ok: false, failure: 'revoked_session' });
  });

  it('logout from another origin is refused and revokes nothing', async () => {
    const { response } = await login({ sub: 'user-123' });
    const token = sessionCookieOf(response)!;
    const refused = await handleCustomerLogout(withCookie(`${APP}/api/auth/logout`, `statx_customer_session=${token}`, { method: 'POST', headers: { origin: 'https://evil.example.com' } }), deps);
    expect(refused.status).toBe(403);
    expect((await principalFor(token)).ok).toBe(true);
  });

  it('an expired session fails, as does an operator revoking every session of a person', async () => {
    const { response } = await login({ sub: 'user-123' });
    const token = sessionCookieOf(response)!;
    await store.customerSessions.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1) } });
    expect(await principalFor(token)).toEqual({ ok: false, failure: 'expired_session' });

    const second = await login({ sub: 'user-123' });
    const [user] = await store.customerUsers.find().toArray();
    // Both sessions the person holds are revoked — the already-expired one included.
    expect(await revokeAllCustomerSessions(store, user!._id, new Date())).toBe(2);
    expect((await principalFor(sessionCookieOf(second.response))).ok).toBe(false);
  });

  it('a forged or edited cookie resolves no one: the browser cannot name a customer user', async () => {
    await login({ sub: 'user-123' });
    const [user] = await store.customerUsers.find().toArray();
    expect(await principalFor('x'.repeat(43))).toEqual({ ok: false, failure: 'unknown_session' });
    expect(await principalFor(user!._id)).toEqual({ ok: false, failure: 'no_session' });
    const forged = await requireCustomerPrincipal(new Request(`${APP}/`, { headers: { cookie: `statx_customer_session=${'y'.repeat(43)}; customerUserId=${user!._id}`, 'x-customer-user-id': user!._id } }), deps);
    expect(forged.ok).toBe(false);
  });

  it('a disabled customer user has no principal, even with a live session', async () => {
    const { response } = await login({ sub: 'user-123' });
    await store.customerUsers.updateMany({}, { $set: { status: 'disabled' } });
    expect(await principalFor(sessionCookieOf(response))).toEqual({ ok: false, failure: 'disabled_user' });
  });

  it('no request without the session cookie is a customer — including operator HTTP Basic credentials and bearer tokens', async () => {
    const basic = `Basic ${Buffer.from('ops:correct-horse-battery-staple').toString('base64')}`;
    expect(await principalFor(null, { authorization: basic })).toEqual({ ok: false, failure: 'no_session' });
    expect(await principalFor(null, { authorization: 'Bearer anything' })).toEqual({ ok: false, failure: 'no_session' });
    expect(await principalFor(null)).toEqual({ ok: false, failure: 'no_session' });
  });
});

describe('the customer session view', () => {
  it('returns only safe identity fields and active accounts — never tokens, sessions, providers or documents', async () => {
    const { response } = await login({ sub: 'user-123', email: 'ada@example.com', name: 'Ada' });
    const [user] = await store.customerUsers.find().toArray();
    const now = new Date();
    await store.customerAccounts.insertMany([
      { _id: 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', displayName: 'Harrowgate Joinery', status: 'active', createdAt: now, updatedAt: now },
      { _id: 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', displayName: 'Disabled Co', status: 'disabled', createdAt: now, updatedAt: now },
      { _id: 'acct_cccccccccccccccccccccccccccccccc', displayName: 'Not Mine', status: 'active', createdAt: now, updatedAt: now },
    ]);
    await store.customerMemberships.insertMany([
      { _id: 'mem_1', accountId: 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', customerUserId: user!._id, role: 'editor', status: 'active', createdAt: now, updatedAt: now },
      { _id: 'mem_2', accountId: 'acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', customerUserId: user!._id, role: 'owner', status: 'active', createdAt: now, updatedAt: now },
    ]);

    const me = await handleCustomerMe(withCookie(`${APP}/api/auth/me`, `statx_customer_session=${sessionCookieOf(response)}`), deps);
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(await me.json()).toEqual({
      customerUserId: user!._id,
      email: 'ada@example.com',
      displayName: 'Ada',
      accounts: [{ accountId: 'acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', displayName: 'Harrowgate Joinery', role: 'editor' }],
    });

    const anonymous = await handleCustomerMe(new Request(`${APP}/api/auth/me`), deps);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'unauthenticated' });
  });
});
