/**
 * Customer authentication configuration — server-only, provider-configurable.
 *
 * Any standards-compliant OpenID Connect provider works: the platform needs its
 * issuer URL, a client registered for the customer app's exact callback, and
 * (for a confidential client) its secret. Nothing here is `NEXT_PUBLIC_*`, and
 * none of it is ever sent to a browser, written to an artifact or passed to a
 * generated website.
 *
 * Fails closed: a missing or unsafe value is a configuration error, never a
 * default. In production the issuer and the app origin must be https, and
 * session cookies are always Secure.
 */

export const CUSTOMER_CALLBACK_PATH = '/api/auth/callback';
export const DEFAULT_CUSTOMER_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const MAX_CUSTOMER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const CUSTOMER_LOGIN_TTL_SECONDS = 10 * 60;

export interface CustomerAuthConfig {
  /** The OpenID provider's exact issuer identifier. */
  readonly issuer: string;
  readonly clientId: string;
  /** Present for a confidential client; absent for a public client, which PKCE still protects. */
  readonly clientSecret: string | null;
  /** The customer app's own origin, e.g. `https://app.statxai.com`. The redirect URI and origin checks derive from it. */
  readonly appOrigin: string;
  /** False only for a non-production app served from localhost over http. */
  readonly secureCookies: boolean;
  readonly sessionTtlSeconds: number;
}

export interface CustomerAuthEnv {
  readonly NODE_ENV?: string | undefined;
  readonly CUSTOMER_OIDC_ISSUER?: string | undefined;
  readonly CUSTOMER_OIDC_CLIENT_ID?: string | undefined;
  readonly CUSTOMER_OIDC_CLIENT_SECRET?: string | undefined;
  readonly CUSTOMER_APP_ORIGIN?: string | undefined;
  readonly CUSTOMER_SESSION_TTL_SECONDS?: string | undefined;
}

export class CustomerAuthConfigInvalid extends Error {
  constructor(detail: string) {
    super(`customer authentication is not safely configured: ${detail}`);
    this.name = 'CustomerAuthConfigInvalid';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(name: string, value: string | undefined): URL {
  if (!value) throw new CustomerAuthConfigInvalid(`${name} is not set`);
  try {
    return new URL(value);
  } catch {
    throw new CustomerAuthConfigInvalid(`${name} is not a URL`);
  }
}

/**
 * The one way configuration is built from the environment.
 *
 * `http` is accepted only outside production and only for a local host — the
 * developer's own machine — and only there are cookies not Secure.
 */
export function customerAuthConfigFromEnv(env: CustomerAuthEnv): CustomerAuthConfig {
  const production = env.NODE_ENV === 'production';

  const issuer = parseUrl('CUSTOMER_OIDC_ISSUER', env.CUSTOMER_OIDC_ISSUER);
  if (issuer.protocol !== 'https:' && (production || !LOCAL_HOSTS.has(issuer.hostname))) {
    throw new CustomerAuthConfigInvalid('CUSTOMER_OIDC_ISSUER must be https');
  }
  if (issuer.search || issuer.hash || issuer.username || issuer.password) {
    throw new CustomerAuthConfigInvalid('CUSTOMER_OIDC_ISSUER must be a bare issuer identifier');
  }

  const clientId = env.CUSTOMER_OIDC_CLIENT_ID?.trim();
  if (!clientId) throw new CustomerAuthConfigInvalid('CUSTOMER_OIDC_CLIENT_ID is not set');
  const clientSecret = env.CUSTOMER_OIDC_CLIENT_SECRET?.length ? env.CUSTOMER_OIDC_CLIENT_SECRET : null;

  const app = parseUrl('CUSTOMER_APP_ORIGIN', env.CUSTOMER_APP_ORIGIN);
  if (app.origin !== env.CUSTOMER_APP_ORIGIN?.replace(/\/$/, '')) {
    throw new CustomerAuthConfigInvalid('CUSTOMER_APP_ORIGIN must be an origin, with no path, query or credentials');
  }
  const localHttp = app.protocol === 'http:' && LOCAL_HOSTS.has(app.hostname);
  if (app.protocol !== 'https:' && (production || !localHttp)) {
    throw new CustomerAuthConfigInvalid('CUSTOMER_APP_ORIGIN must be https');
  }

  let sessionTtlSeconds = DEFAULT_CUSTOMER_SESSION_TTL_SECONDS;
  if (env.CUSTOMER_SESSION_TTL_SECONDS !== undefined) {
    sessionTtlSeconds = Number(env.CUSTOMER_SESSION_TTL_SECONDS);
    if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > MAX_CUSTOMER_SESSION_TTL_SECONDS) {
      throw new CustomerAuthConfigInvalid(`CUSTOMER_SESSION_TTL_SECONDS must be an integer between 60 and ${MAX_CUSTOMER_SESSION_TTL_SECONDS}`);
    }
  }

  return {
    // Exactly as configured: an ID token's `iss` must equal this string, not a normalised form of it.
    issuer: env.CUSTOMER_OIDC_ISSUER!,
    clientId,
    clientSecret,
    appOrigin: app.origin,
    secureCookies: production || !localHttp,
    sessionTtlSeconds,
  };
}
