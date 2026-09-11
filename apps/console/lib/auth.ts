/**
 * The console's one authenticated operator boundary (Phase 5o).
 *
 * Every protected console request — page, API route, preview asset —
 * converges here. `middleware.ts` applies it to the whole console; each
 * `app/api/**\/route.ts` handler calls it again as its own first statement,
 * so a route can never be served by an unauthenticated caller because a
 * matcher pattern was edited incorrectly. Both paths call the same function;
 * there is no second copy of the comparison, the configuration rules, or the
 * failure response.
 *
 * **Mechanism: HTTP Basic (RFC 7617), one configured operator.** The real
 * console is used from a browser: `launch-form.tsx` POSTs `/api/runs`,
 * `run-view.tsx` polls `/api/runs/<id>`, and the preview is an `<iframe>`
 * loading `/api/preview/<projectId>`. A bearer token would have to be handed
 * to that client-side JavaScript to make any of those work, which is exactly
 * what a server-side credential must never be. Basic is the one browser-safe
 * mechanism that needs no login page, no session store, no cookie signing and
 * no new dependency: the browser holds the credential in its own credential
 * cache, attaches it to same-origin subresources (the preview iframe included)
 * and never exposes it to page scripts. `curl -u` works for an operator at a
 * terminal for the same reason. There is no user database, no role, and no
 * identity provider — Phase 5o has exactly one authority, the console operator.
 *
 * **Runtime-agnostic on purpose.** Next middleware runs on the Edge runtime by
 * default, so nothing here may import `node:crypto` or any other Node builtin:
 * `atob`, `TextDecoder` and Web Crypto are available in both runtimes, and the
 * comparison below is built from those alone.
 */

/** The trusted identity a successful authentication produces. Never a secret. */
export interface ConsoleOperatorPrincipal {
  /** The configured operator id — the authority for any future audit actor. */
  readonly id: string;
  /** How the identity was established. Useful in audit, safe to expose. */
  readonly authMethod: 'basic';
}

/** Shown by the browser's credential prompt. Not secret, not an identifier. */
export const CONSOLE_AUTH_REALM = 'STATXAI console';

/**
 * Why a request was refused. Deliberately more granular than the response:
 * every one of the three credential failures produces the *same* 401 below, so
 * this classification never reaches the caller.
 */
export type ConsoleAuthFailure =
  | 'not_configured'
  | 'no_credential'
  | 'malformed_credential'
  | 'invalid_credential'
  | 'cross_site_mutation';

export type ConsoleAuthOutcome =
  | { readonly ok: true; readonly principal: ConsoleOperatorPrincipal }
  | { readonly ok: false; readonly failure: ConsoleAuthFailure };

/** The two server-side configuration keys. Never `NEXT_PUBLIC_*`. */
export interface ConsoleAuthEnv {
  readonly CONSOLE_OPERATOR_USER?: string | undefined;
  readonly CONSOLE_OPERATOR_PASSWORD?: string | undefined;
}

export interface OperatorCredential {
  readonly user: string;
  readonly password: string;
}

/**
 * Read live, per request, through explicit `process.env.X` references.
 *
 * Explicit rather than passing `process.env` itself: a bundler that inlines
 * server environment variables can only see literal member accesses, and a
 * credential that silently resolved to `undefined` inside the Edge middleware
 * bundle would fail closed (503 on every request) rather than open — but it
 * would still be an outage nobody could explain from the configuration.
 */
function processEnv(): ConsoleAuthEnv {
  return {
    CONSOLE_OPERATOR_USER: process.env.CONSOLE_OPERATOR_USER,
    CONSOLE_OPERATOR_PASSWORD: process.env.CONSOLE_OPERATOR_PASSWORD,
  };
}

/**
 * The configured operator credential, or `null` when the console is not
 * configured to authenticate anyone.
 *
 * `null` is never "authentication disabled": every caller turns it into a
 * refusal. There is no environment value, in any runtime, that makes the
 * console serve an anonymous request — a missing, empty, whitespace-only or
 * unrepresentable credential all fail closed identically.
 */
export function resolveOperatorCredential(env: ConsoleAuthEnv = processEnv()): OperatorCredential | null {
  const user = env.CONSOLE_OPERATOR_USER;
  const password = env.CONSOLE_OPERATOR_PASSWORD;

  if (typeof user !== 'string' || user.trim() === '') return null;
  if (typeof password !== 'string' || password.trim() === '') return null;

  // RFC 7617 encodes `user:password` and splits on the first colon, so a
  // configured user id containing one is not representable: it would silently
  // authenticate a different pair of strings than the operator configured.
  if (user.includes(':')) return null;

  return { user, password };
}

/**
 * Constant-time string comparison, on digests so that inputs of different
 * lengths compare over a fixed 32 bytes rather than short-circuiting.
 *
 * SHA-256 of each side, then a branchless XOR fold: the attacker already knows
 * the digest of the value they submitted, and never observes the digest of the
 * configured one, so hashing costs nothing in secrecy and buys length safety.
 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);

  const left = new Uint8Array(digestA);
  const right = new Uint8Array(digestB);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

/**
 * Decode one `Authorization: Basic <base64>` header.
 *
 * Returns `null` for everything malformed — a different scheme, padding that
 * is not base64, a payload with no colon. It never throws: a throw here would
 * escape as a 500 and hand a caller a distinguishable response for a malformed
 * credential.
 */
function parseBasicCredential(header: string): OperatorCredential | null {
  const match = /^\s*Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(header);
  if (!match) return null;

  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(match[1]!), (character) => character.charCodeAt(0));
    decoded = new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }

  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Secondary, never authentication (§25).
 *
 * Basic credentials are ambient browser authority in the same way a cookie is:
 * once cached for this origin the browser attaches them to a cross-site form
 * POST too, and a form can send `text/plain` that `request.json()` parses
 * happily. So state-changing methods additionally require a same-origin
 * signal. `Sec-Fetch-Site` is sent by every browser that can mount the attack;
 * `Origin` is the fallback. A client that sends neither is not a browser — an
 * operator's `curl`, which no attacker page can make anyone's browser become —
 * and is allowed through to the credential check that actually decides.
 */
export function isCrossSiteMutation(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null) return fetchSite !== 'same-origin' && fetchSite !== 'none';

  const origin = request.headers.get('origin');
  if (origin === null) return false;

  try {
    const host = request.headers.get('host') ?? new URL(request.url).host;
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/**
 * Authenticate one request. The single authority — nothing else in the console
 * decides whether a caller is an operator.
 *
 * The principal's id is read from the *configuration*, never from the
 * submitted credential: no byte of request content can reach
 * `ConsoleOperatorPrincipal`, even if the comparison above were ever weakened.
 */
export async function authenticateConsoleOperator(
  request: Request,
  env: ConsoleAuthEnv = processEnv(),
): Promise<ConsoleAuthOutcome> {
  if (isCrossSiteMutation(request)) return { ok: false, failure: 'cross_site_mutation' };

  const configured = resolveOperatorCredential(env);
  if (!configured) return { ok: false, failure: 'not_configured' };

  const header = request.headers.get('authorization');
  if (header === null) return { ok: false, failure: 'no_credential' };

  const presented = parseBasicCredential(header);
  if (!presented) return { ok: false, failure: 'malformed_credential' };

  // Both halves are always compared, so the response time does not reveal
  // whether the user id alone was right.
  const [userMatches, passwordMatches] = await Promise.all([
    constantTimeEquals(presented.user, configured.user),
    constantTimeEquals(presented.password, configured.password),
  ]);
  if (!userMatches || !passwordMatches) return { ok: false, failure: 'invalid_credential' };

  return { ok: true, principal: { id: configured.user, authMethod: 'basic' } };
}

/**
 * The refusal. Minimal by design: no token, no configured user id, no length,
 * no hash, and no hint about which of the three credential failures occurred —
 * "not sent", "unreadable" and "wrong" are one identical response.
 */
export function consoleAuthFailureResponse(failure: ConsoleAuthFailure): Response {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };

  if (failure === 'not_configured') {
    // Fails closed, loudly: the console is misconfigured, not unprotected. No
    // `WWW-Authenticate` — there is nothing a credential could satisfy.
    return new Response(JSON.stringify({ error: 'Console operator authentication is not configured.' }), {
      status: 503,
      headers,
    });
  }

  if (failure === 'cross_site_mutation') {
    return new Response(JSON.stringify({ error: 'Cross-site request rejected.' }), { status: 403, headers });
  }

  return new Response(JSON.stringify({ error: 'Authentication required.' }), {
    status: 401,
    headers: { ...headers, 'www-authenticate': `Basic realm="${CONSOLE_AUTH_REALM}", charset="UTF-8"` },
  });
}

/**
 * What every protected route and the middleware call.
 *
 *   const auth = await requireConsoleOperator(request);
 *   if (auth instanceof Response) return auth;
 *
 * Returning the refusal rather than throwing keeps the failure path impossible
 * to forget: the value a caller needs is the principal, and the only way to
 * reach it is to have handled the `Response` first.
 */
export async function requireConsoleOperator(
  request: Request,
  env: ConsoleAuthEnv = processEnv(),
): Promise<ConsoleOperatorPrincipal | Response> {
  const outcome = await authenticateConsoleOperator(request, env);
  return outcome.ok ? outcome.principal : consoleAuthFailureResponse(outcome.failure);
}
