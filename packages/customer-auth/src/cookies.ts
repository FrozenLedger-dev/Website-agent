/**
 * The customer app's two cookies, and nothing else.
 *
 * Both hold only an opaque random token; the server stores its sha256 and every
 * fact about it. Both are HttpOnly, `SameSite=Lax` (so the provider's top-level
 * redirect back to the callback still carries the login cookie, while
 * cross-site subrequests and form posts do not carry the session), `Path=/`,
 * host-only, finite, and Secure — with the `__Host-` prefix, which browsers
 * refuse to accept without Secure, no Domain and Path=/ — everywhere except a
 * developer's own http://localhost.
 */
import type { CustomerAuthConfig } from './config.js';

export type CustomerCookie = 'session' | 'login';

export function customerCookieName(kind: CustomerCookie, config: Pick<CustomerAuthConfig, 'secureCookies'>): string {
  const base = kind === 'session' ? 'statx_customer_session' : 'statx_customer_login';
  return config.secureCookies ? `__Host-${base}` : base;
}

/** A Set-Cookie value for a token, or for clearing the cookie when `token` is null. */
export function serializeCustomerCookie(
  kind: CustomerCookie,
  token: string | null,
  maxAgeSeconds: number,
  config: Pick<CustomerAuthConfig, 'secureCookies'>,
): string {
  const parts = [
    `${customerCookieName(kind, config)}=${token ?? ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${token === null ? 0 : Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The token in exactly one cookie of this name, or null. Two cookies with the
 * same name — one of them planted by someone else — are ambiguous, and refused
 * rather than guessed between.
 */
export function readCustomerCookie(request: Request, kind: CustomerCookie, config: Pick<CustomerAuthConfig, 'secureCookies'>): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const name = customerCookieName(kind, config);
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1) return null;
  return TOKEN.test(values[0]!) ? values[0]! : null;
}
