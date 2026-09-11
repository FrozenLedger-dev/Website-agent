/**
 * Phase 5o — the console's authenticated operator boundary.
 *
 * Deliberately one file: the property under test is a single boundary, and
 * splitting it per route would multiply fixtures without adding a property.
 * No Mongo, no filesystem writes, no model calls — `getStore` and `launchRun`
 * are the two doors out of a route handler, and both are mocked, so "the
 * request was rejected before anything happened" is checkable directly rather
 * than inferred.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFrontendBackendExecutionMode } from '@statxai/orchestrator';
import type * as OrchestratorModule from '@statxai/orchestrator';
import type * as StoreModule from '../lib/store';
import {
  authenticateConsoleOperator,
  consoleAuthFailureResponse,
  isCrossSiteMutation,
  resolveOperatorCredential,
} from '../lib/auth';

const CONSOLE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The console API routes that may be served without an authenticated
 * operator. Empty, and that is the point: this console has no health,
 * readiness or liveness endpoint, so Phase 5o has no exception to make.
 * Adding a route here is an explicit decision to serve it anonymously.
 */
const PUBLIC_API_ROUTES: readonly string[] = [];

const OPERATOR = 'ops';
/** A known value, so "the secret never appears in X" is actually checkable. */
const SECRET = 'correct-horse-battery-staple';

const mocks = vi.hoisted(() => ({
  launchRun: vi.fn(),
  getStore: vi.fn(),
}));

vi.mock('@statxai/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestratorModule>();
  return { ...actual, launchRun: mocks.launchRun };
});

// `importOriginal`, not a stub: `FRONTEND_BACKEND_EXECUTION_MODE` has to stay
// the real Phase 5l configuration for the execution-mode assertions below to
// mean anything. Only the Mongo connection is replaced.
vi.mock('@/lib/store', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>();
  return { ...actual, getStore: mocks.getStore };
});

const { GET: listRuns, POST: startRun } = await import('../app/api/runs/route');
const { GET: readRun } = await import('../app/api/runs/[runId]/route');
const { GET: readPreview } = await import('../app/api/preview/[projectId]/[[...path]]/route');
const { middleware } = await import('../middleware');

const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;
const VALID = basic(OPERATOR, SECRET);

function consoleRequest(
  path: string,
  { credential, headers, ...init }: RequestInit & { credential?: string } = {},
): Request {
  const merged = new Headers(headers);
  if (credential !== undefined) merged.set('authorization', credential);
  return new Request(`http://localhost:3100${path}`, { ...init, headers: merged });
}

const launchBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ intake: { businessName: 'Acme' }, ...extra });

function startRunRequest(init: RequestInit & { credential?: string } = {}): Request {
  return consoleRequest('/api/runs', {
    method: 'POST',
    body: launchBody(),
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}

/** Every console API route file, found on disk rather than listed here. */
async function routeFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'route.ts') found.push(full);
    }
  };
  await walk(join(CONSOLE_ROOT, 'app', 'api'));
  return found.sort();
}

/** Every console source file, excluding build output and this suite. */
async function consoleSources(): Promise<{ path: string; source: string }[]> {
  const found: { path: string; source: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'test') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        found.push({ path: relative(CONSOLE_ROOT, full).split(sep).join('/'), source: await readFile(full, 'utf8') });
      }
    }
  };
  await walk(CONSOLE_ROOT);
  return found;
}

beforeEach(() => {
  mocks.launchRun.mockReset();
  mocks.launchRun.mockResolvedValue({ runId: 'run_test', projectId: 'proj_test', completed: Promise.resolve() });
  mocks.getStore.mockReset();
  // A marker, not a store: a rejected request must never call this at all,
  // which each rejection test asserts directly.
  mocks.getStore.mockResolvedValue({ marker: 'console-auth-test-store' });
  vi.stubEnv('CONSOLE_OPERATOR_USER', OPERATOR);
  vi.stubEnv('CONSOLE_OPERATOR_PASSWORD', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the configured operator credential', () => {
  it('resolves when both keys are set', () => {
    expect(resolveOperatorCredential({ CONSOLE_OPERATOR_USER: 'a', CONSOLE_OPERATOR_PASSWORD: 'b' })).toEqual({
      user: 'a',
      password: 'b',
    });
  });

  it('fails closed on a missing, empty, whitespace-only or unrepresentable credential', () => {
    expect(resolveOperatorCredential({})).toBeNull();
    expect(resolveOperatorCredential({ CONSOLE_OPERATOR_USER: 'a' })).toBeNull();
    expect(resolveOperatorCredential({ CONSOLE_OPERATOR_PASSWORD: 'b' })).toBeNull();
    expect(resolveOperatorCredential({ CONSOLE_OPERATOR_USER: '', CONSOLE_OPERATOR_PASSWORD: 'b' })).toBeNull();
    expect(resolveOperatorCredential({ CONSOLE_OPERATOR_USER: 'a', CONSOLE_OPERATOR_PASSWORD: '' })).toBeNull();
    expect(resolveOperatorCredential({ CONSOLE_OPERATOR_USER: '  ', CONSOLE_OPERATOR_PASSWORD: 'b' })).toBeNull();
    expect(resolveOperatorCredential({ CONSOLE_OPERATOR_USER: 'a', CONSOLE_OPERATOR_PASSWORD: '\t \n' })).toBeNull();
    // `user:password`: a colon in the user half would authenticate a different
    // pair of strings than the operator configured.
    expect(resolveOperatorCredential({ CONSOLE_OPERATOR_USER: 'a:b', CONSOLE_OPERATOR_PASSWORD: 'b' })).toBeNull();
  });

  it('never treats absent configuration as anonymous access to the production entrypoint', async () => {
    vi.stubEnv('CONSOLE_OPERATOR_USER', undefined);
    vi.stubEnv('CONSOLE_OPERATOR_PASSWORD', undefined);

    const response = await startRun(startRunRequest({ credential: VALID }));

    expect(response.status).toBe(503);
    expect(mocks.launchRun).not.toHaveBeenCalled();
    expect(mocks.getStore).not.toHaveBeenCalled();
    // No challenge: there is no credential that could satisfy an unconfigured
    // console, and a 401 would invite an operator to keep trying.
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('fails closed the same way when the configured password is whitespace-only', async () => {
    vi.stubEnv('CONSOLE_OPERATOR_PASSWORD', '   ');

    const response = await startRun(startRunRequest({ credential: basic(OPERATOR, '   ') }));

    expect(response.status).toBe(503);
    expect(mocks.launchRun).not.toHaveBeenCalled();
  });
});

describe('POST /api/runs — the production website-generation entrypoint', () => {
  it('rejects an unauthenticated run start before anything happens', async () => {
    const response = await startRun(startRunRequest());

    expect(response.status).toBe(401);
    // `launchRun` is the only door to a run document, a project, a job or a
    // model call, and `getStore` the only door to Mongo. Neither was opened.
    expect(mocks.launchRun).not.toHaveBeenCalled();
    expect(mocks.getStore).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: 'Authentication required.' });
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="STATXAI console", charset="UTF-8"');
  });

  it('rejects a wrong credential with the identical response an absent one gets', async () => {
    const absent = await startRun(startRunRequest());
    const wrongPassword = await startRun(startRunRequest({ credential: basic(OPERATOR, 'nope') }));
    const wrongUser = await startRun(startRunRequest({ credential: basic('someone-else', SECRET) }));

    for (const response of [wrongPassword, wrongUser]) {
      expect(response.status).toBe(absent.status);
      expect(await response.clone().text()).toBe(await absent.clone().text());
      expect(response.headers.get('www-authenticate')).toBe(absent.headers.get('www-authenticate'));
    }
    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it('rejects a malformed Basic credential without throwing', async () => {
    const malformed = [
      'Bearer ' + btoa(`${OPERATOR}:${SECRET}`), // wrong scheme
      'Basic', // no payload
      'Basic !!!not-base64!!!', // rejected by shape, before decoding
      'Basic QUJD=', // base64 alphabet, invalid padding: `atob` itself throws
      'Basic A', // base64 alphabet, impossible length
      `Basic ${btoa('no-colon-at-all')}`,
      '',
    ];

    for (const credential of malformed) {
      const response = await startRun(startRunRequest({ credential }));
      expect(response.status, credential).toBe(401);
    }
    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it('lets an authenticated operator start a run, still on the Phase 5l job_lifecycle default', async () => {
    const response = await startRun(startRunRequest({ credential: VALID }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runId: 'run_test', projectId: 'proj_test' });
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);
    expect(mocks.launchRun.mock.calls[0]![0]).toMatchObject({
      frontendBackendExecutionMode: 'job_lifecycle',
      intake: { businessName: 'Acme' },
    });
  });

  it('still honours the Phase 5l legacy_direct rollback for an authenticated operator', async () => {
    // The operator rollback is resolved once, at module load, from
    // `FRONTEND_BACKEND_EXECUTION_MODE` — so the console is re-instantiated
    // with that configuration rather than having it patched afterwards. The
    // mode still comes from Phase 5l's own parser, not from this test.
    vi.resetModules();
    vi.doMock('@/lib/store', async (importOriginal) => {
      const actual = await importOriginal<typeof StoreModule>();
      return {
        ...actual,
        getStore: mocks.getStore,
        FRONTEND_BACKEND_EXECUTION_MODE: resolveFrontendBackendExecutionMode('legacy_direct'),
      };
    });

    try {
      const { POST: rolledBack } = await import('../app/api/runs/route');

      // Authentication is unchanged by the rollback, and the rollback is
      // unchanged by authentication.
      expect((await rolledBack(startRunRequest())).status).toBe(401);
      expect(mocks.launchRun).not.toHaveBeenCalled();

      const response = await rolledBack(startRunRequest({ credential: VALID }));

      expect(response.status).toBe(200);
      expect(mocks.launchRun.mock.calls[0]![0]).toMatchObject({ frontendBackendExecutionMode: 'legacy_direct' });
    } finally {
      vi.doUnmock('@/lib/store');
      vi.resetModules();
    }
  });

  it('takes the operator identity from authentication, never from the request', async () => {
    const spoofed = startRunRequest({
      credential: VALID,
      body: launchBody({ actor: 'root', userId: 'root', operator: 'root' }),
      headers: {
        'content-type': 'application/json',
        'x-operator': 'root',
        'x-user': 'root',
        'x-forwarded-user': 'root',
      },
    });

    const outcome = await authenticateConsoleOperator(spoofed.clone());
    expect(outcome).toEqual({ ok: true, principal: { id: OPERATOR, authMethod: 'basic' } });

    // And the spoofing content reaches no authority: the route never consults
    // it for identity, and `launchRun` is handed the intake alone.
    const response = await startRun(spoofed);
    expect(response.status).toBe(200);
    expect(JSON.stringify(mocks.launchRun.mock.calls[0]![0])).not.toContain('root');
  });

  it('rejects a cross-site mutation carrying valid ambient credentials', async () => {
    const response = await startRun(
      startRunRequest({ credential: VALID, headers: { 'sec-fetch-site': 'cross-site' } }),
    );

    expect(response.status).toBe(403);
    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it('treats same-origin, same-site-none and non-browser callers as mutable', () => {
    const site = (value: string | null, origin?: string) =>
      isCrossSiteMutation(
        consoleRequest('/api/runs', {
          method: 'POST',
          headers: {
            ...(value === null ? {} : { 'sec-fetch-site': value }),
            ...(origin === undefined ? {} : { origin }),
          },
        }),
      );

    expect(site('same-origin')).toBe(false);
    expect(site('none')).toBe(false);
    expect(site('same-site')).toBe(true);
    expect(site('cross-site')).toBe(true);
    expect(site(null)).toBe(false); // curl: no browser headers at all
    expect(site(null, 'http://localhost:3100')).toBe(false);
    expect(site(null, 'https://evil.example')).toBe(true);
    // A safe method is never a mutation, whatever a browser says about it.
    expect(isCrossSiteMutation(consoleRequest('/api/runs', { headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(
      false,
    );
  });
});

describe('the console read routes', () => {
  it('rejects an unauthenticated run listing', async () => {
    const response = await listRuns(consoleRequest('/api/runs'));

    expect(response.status).toBe(401);
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated read of one run', async () => {
    const response = await readRun(consoleRequest('/api/runs/run_1'), { params: Promise.resolve({ runId: 'run_1' }) });

    expect(response.status).toBe(401);
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it('preserves the existing behaviour of a run read once authenticated', async () => {
    mocks.getStore.mockResolvedValue({ runs: { findOne: async () => null } });

    const response = await readRun(consoleRequest('/api/runs/run_1', { credential: VALID }), {
      params: Promise.resolve({ runId: 'run_1' }),
    });

    expect(mocks.getStore).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Run not found' });
  });
});

describe('the preview route', () => {
  it('rejects an unauthenticated request for generated site content', async () => {
    const response = await readPreview(consoleRequest('/api/preview/proj_x'), {
      params: Promise.resolve({ projectId: 'proj_x' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic');
  });

  it('preserves the existing behaviour once authenticated', async () => {
    const response = await readPreview(consoleRequest('/api/preview/not-a-project', { credential: VALID }), {
      params: Promise.resolve({ projectId: 'not-a-project' }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Bad project id');
  });
});

describe('the middleware boundary', () => {
  it('challenges an unauthenticated page request', async () => {
    const response = await middleware(consoleRequest('/'));

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic');
  });

  it('passes an authenticated request through', async () => {
    const response = await middleware(consoleRequest('/runs/run_1', { credential: VALID }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('matches every console path except the framework’s own static output', async () => {
    const { config } = await import('../middleware');
    const pattern = new RegExp(`^${config.matcher[0]}$`);

    expect(pattern.test('/')).toBe(true);
    expect(pattern.test('/api/runs')).toBe(true);
    expect(pattern.test('/api/runs/run_1')).toBe(true);
    expect(pattern.test('/api/preview/proj_1/index.html')).toBe(true);
    expect(pattern.test('/runs/run_1')).toBe(true);
    expect(pattern.test('/_next/static/chunks/main.js')).toBe(false);
  });
});

describe('the authenticated principal and the refusal', () => {
  it('carries safe identity only — never the credential', async () => {
    const outcome = await authenticateConsoleOperator(consoleRequest('/api/runs', { credential: VALID }));

    expect(outcome.ok).toBe(true);
    const principal = (outcome as { principal: { id: string; authMethod: string } }).principal;
    expect(Object.keys(principal).sort()).toEqual(['authMethod', 'id']);
    expect(principal.id).toBe(OPERATOR);
    expect(JSON.stringify(principal)).not.toContain(SECRET);
  });

  it('never puts the secret in the refusal — body or headers', async () => {
    const response = await startRun(startRunRequest({ credential: basic(OPERATOR, 'wrong') }));

    const body = await response.text();
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(OPERATOR);
    expect(String(body.length)).not.toBe(String(SECRET.length));
    for (const [, value] of response.headers) expect(value).not.toContain(SECRET);
    // The realm is a prompt label, not the configured identity.
    expect(response.headers.get('www-authenticate')).not.toContain(OPERATOR);
  });

  it('distinguishes failure categories internally but never in the response', async () => {
    const categories = ['no_credential', 'malformed_credential', 'invalid_credential'] as const;
    const responses = categories.map((failure) => consoleAuthFailureResponse(failure));

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(JSON.stringify({ error: 'Authentication required.' }));
    }
  });
});

describe('the boundary covers the console structurally', () => {
  it('guards every console API route through the one central primitive', async () => {
    const files = await routeFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const route = relative(CONSOLE_ROOT, file).split(sep).join('/');
      if (PUBLIC_API_ROUTES.includes(route)) continue;

      const source = await readFile(file, 'utf8');
      expect(source, route).toContain("from '@/lib/auth'");

      // Every exported HTTP handler, and the guard as its first statement —
      // not merely present somewhere in the file.
      const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)];
      expect(handlers.length, route).toBeGreaterThan(0);
      for (const handler of handlers) {
        const body = source.slice(source.indexOf('{', handler.index), source.indexOf('{', handler.index) + 600);
        const guard = body.indexOf('await requireConsoleOperator(request)');
        expect(guard, `${route} ${handler[1]}`).toBeGreaterThan(-1);
        expect(body.slice(0, guard), `${route} ${handler[1]}`).not.toMatch(/\bawait\b|getStore|launchRun/);
      }
    }
  });

  it('declares no anonymous console API route', async () => {
    expect(PUBLIC_API_ROUTES).toEqual([]);
  });

  it('keeps the credential out of anything the browser is handed', async () => {
    const sources = await consoleSources();

    for (const { path, source } of sources) {
      // The one mechanism that would put a server value into the browser
      // bundle by design.
      expect(source, path).not.toMatch(/process\.env\.NEXT_PUBLIC/);
      if (path === 'lib/auth.ts') continue;
      expect(source, path).not.toContain('CONSOLE_OPERATOR_PASSWORD');
    }

    // No client component reaches the server-only primitive, so no bundler can
    // follow an import from browser code to the credential.
    for (const { path, source } of sources) {
      if (!source.includes("'use client'")) continue;
      expect(source, path).not.toContain('@/lib/auth');
    }

    // And nothing in the console imports a Node builtin into the primitive —
    // Next middleware runs on the Edge runtime.
    const auth = sources.find((file) => file.path === 'lib/auth.ts')!;
    expect(auth.source).not.toMatch(/from 'node:/);
  });

  it('adds no HTTP build-abandonment endpoint', async () => {
    const files = await routeFiles();
    expect(files.filter((file) => /abandon/i.test(file))).toEqual([]);

    for (const { path, source } of await consoleSources()) {
      expect(source, path).not.toContain('abandonFrontendBackendBuild');
      expect(source, path).not.toContain('supersede');
    }
  });
});
