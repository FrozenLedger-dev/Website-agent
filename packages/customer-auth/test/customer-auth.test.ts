/**
 * Customer authentication primitives, offline: configuration that fails
 * closed, cookie policy, cookie parsing, return paths and the same-origin
 * mutation rule.
 */
import { describe, expect, it } from 'vitest';
import {
  CustomerAuthConfigInvalid,
  customerAuthConfigFromEnv,
  customerCookieName,
  isSameOriginCustomerMutation,
  readCustomerCookie,
  requireCustomerPrincipal,
  safeReturnTo,
  serializeCustomerCookie,
  type CustomerAuthEnv,
} from '../src/index.js';

const PROD: CustomerAuthEnv = {
  NODE_ENV: 'production',
  CUSTOMER_OIDC_ISSUER: 'https://idp.example.com',
  CUSTOMER_OIDC_CLIENT_ID: 'statxai',
  CUSTOMER_OIDC_CLIENT_SECRET: 'server-only-secret',
  CUSTOMER_APP_ORIGIN: 'https://app.statxai.example',
};

describe('configuration fails closed', () => {
  it('a complete production configuration uses Secure cookies, the exact issuer and origin, and a bounded session', () => {
    expect(customerAuthConfigFromEnv(PROD)).toEqual({
      issuer: 'https://idp.example.com',
      clientId: 'statxai',
      clientSecret: 'server-only-secret',
      appOrigin: 'https://app.statxai.example',
      secureCookies: true,
      sessionTtlSeconds: 43_200,
    });
  });

  it.each([
    ['no issuer', { CUSTOMER_OIDC_ISSUER: undefined }],
    ['an http issuer in production', { CUSTOMER_OIDC_ISSUER: 'http://idp.example.com' }],
    ['an http localhost issuer in production', { CUSTOMER_OIDC_ISSUER: 'http://localhost:9000' }],
    ['an issuer with a query', { CUSTOMER_OIDC_ISSUER: 'https://idp.example.com/?x=1' }],
    ['no client id', { CUSTOMER_OIDC_CLIENT_ID: '' }],
    ['no app origin', { CUSTOMER_APP_ORIGIN: undefined }],
    ['an app origin with a path', { CUSTOMER_APP_ORIGIN: 'https://app.statxai.example/customer' }],
    ['an http app origin in production', { CUSTOMER_APP_ORIGIN: 'http://app.statxai.example' }],
    ['an http localhost app origin in production', { CUSTOMER_APP_ORIGIN: 'http://localhost:3200' }],
    ['a session lifetime beyond a week', { CUSTOMER_SESSION_TTL_SECONDS: String(8 * 24 * 3600) }],
    ['a non-integer session lifetime', { CUSTOMER_SESSION_TTL_SECONDS: 'forever' }],
  ])('refuses %s', (_label, change) => {
    expect(() => customerAuthConfigFromEnv({ ...PROD, ...change })).toThrow(CustomerAuthConfigInvalid);
  });

  it('only a non-production app on localhost over http may have non-Secure cookies; anything else remote must be https', () => {
    expect(customerAuthConfigFromEnv({ ...PROD, NODE_ENV: 'development', CUSTOMER_APP_ORIGIN: 'http://localhost:3200' }).secureCookies).toBe(false);
    expect(customerAuthConfigFromEnv({ ...PROD, NODE_ENV: 'development' }).secureCookies).toBe(true);
    expect(() => customerAuthConfigFromEnv({ ...PROD, NODE_ENV: 'development', CUSTOMER_APP_ORIGIN: 'http://app.statxai.example' })).toThrow(CustomerAuthConfigInvalid);
    expect(customerAuthConfigFromEnv({ ...PROD, CUSTOMER_OIDC_CLIENT_SECRET: undefined }).clientSecret).toBeNull();
  });
});

describe('cookies', () => {
  const secure = { secureCookies: true };
  const local = { secureCookies: false };

  it('production session and login cookies are __Host-, HttpOnly, SameSite=Lax, Path=/, finite and Secure', () => {
    expect(customerCookieName('session', secure)).toBe('__Host-statx_customer_session');
    expect(serializeCustomerCookie('session', 'a'.repeat(43), 43_200, secure)).toBe(`__Host-statx_customer_session=${'a'.repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure`);
    expect(serializeCustomerCookie('login', 'b'.repeat(43), 600, secure)).toBe(`__Host-statx_customer_login=${'b'.repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`);
    expect(serializeCustomerCookie('session', null, 0, secure)).toBe('__Host-statx_customer_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    // No Domain: host-only, never shared with sibling subdomains.
    expect(serializeCustomerCookie('session', 'a'.repeat(43), 60, secure)).not.toMatch(/Domain=/i);
  });

  it('local development cookies keep every protection except Secure', () => {
    expect(serializeCustomerCookie('session', 'a'.repeat(43), 60, local)).toBe(`statx_customer_session=${'a'.repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
  });

  it('reads exactly one well-formed token under the exact name, and refuses duplicates, malformed values and look-alike names', () => {
    const req = (cookie: string) => new Request('https://app.statxai.example/', { headers: { cookie } });
    const token = 'A'.repeat(43);
    expect(readCustomerCookie(req(`__Host-statx_customer_session=${token}`), 'session', secure)).toBe(token);
    expect(readCustomerCookie(req(`statx_customer_session=${token}`), 'session', secure)).toBeNull();
    expect(readCustomerCookie(req(`__Host-statx_customer_session=${token}; __Host-statx_customer_session=${'B'.repeat(43)}`), 'session', secure)).toBeNull();
    expect(readCustomerCookie(req('__Host-statx_customer_session=cu_1234'), 'session', secure)).toBeNull();
    expect(readCustomerCookie(req(`x__Host-statx_customer_session=${token}`), 'session', secure)).toBeNull();
    expect(readCustomerCookie(req(`__Host-statx_customer_login=${token}`), 'session', secure)).toBeNull();
  });
});

describe('request safety', () => {
  it('return paths are same-site absolute paths or nothing', () => {
    expect(safeReturnTo('/projects?tab=1')).toBe('/projects?tab=1');
    for (const unsafe of [null, '', 'projects', '//evil.example', '/\\evil.example', 'https://evil.example', '/x\ny', `/${'a'.repeat(600)}`]) expect(safeReturnTo(unsafe)).toBe('/');
  });

  it('a mutation is same-origin only when the Origin is exactly the app, or, with no Origin, the browser says same-origin', () => {
    const config = { appOrigin: 'https://app.statxai.example' };
    const post = (headers: Record<string, string>) => new Request('https://app.statxai.example/api/auth/logout', { method: 'POST', headers });
    expect(isSameOriginCustomerMutation(post({ origin: 'https://app.statxai.example' }), config)).toBe(true);
    expect(isSameOriginCustomerMutation(post({ 'sec-fetch-site': 'same-origin' }), config)).toBe(true);
    expect(isSameOriginCustomerMutation(post({ origin: 'https://evil.example' }), config)).toBe(false);
    expect(isSameOriginCustomerMutation(post({ origin: 'null' }), config)).toBe(false);
    expect(isSameOriginCustomerMutation(post({ origin: 'https://app.statxai.example.evil.example' }), config)).toBe(false);
    expect(isSameOriginCustomerMutation(post({ 'sec-fetch-site': 'cross-site' }), config)).toBe(false);
    expect(isSameOriginCustomerMutation(post({}), config)).toBe(false);
  });

  it('a request with no customer session cookie is refused before any state is read — operator Basic credentials included', async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error('the store must not be touched'); } });
    const outcome = await requireCustomerPrincipal(
      new Request('https://app.statxai.example/api/auth/me', { headers: { authorization: `Basic ${btoa('ops:secret')}`, cookie: 'statx_customer_session=nope' } }),
      { store: untouchable as never, config: { secureCookies: true } },
    );
    expect(outcome).toEqual({ ok: false, failure: 'no_session' });
  });
});
