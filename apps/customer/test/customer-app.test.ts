/**
 * The customer app and the operator console are separate authorities.
 *
 * A customer session never reaches an operator route; operator Basic
 * credentials never produce a customer; the customer app serves exactly its
 * authentication routes and the draft editor's pages and routes, each failing
 * closed when customer auth is not configured.
 */
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateConsoleOperator, requireConsoleOperator } from '../../console/lib/auth';

const CUSTOMER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OPERATOR_ENV = { CONSOLE_OPERATOR_USER: 'ops', CONSOLE_OPERATOR_PASSWORD: 'correct-horse-battery-staple' };
const SESSION_COOKIE = `__Host-statx_customer_session=${'A'.repeat(43)}`;

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
});
afterEach(() => {
  process.env = saved;
  vi.resetModules();
});

describe('operator and customer authority never cross', () => {
  it('a customer session cookie does not authenticate the operator console, at the middleware or a route', async () => {
    const outcome = await authenticateConsoleOperator(new Request('http://localhost:3100/api/runs', { headers: { cookie: SESSION_COOKIE } }), OPERATOR_ENV);
    expect(outcome).toEqual({ ok: false, failure: 'no_credential' });

    // The console middleware and every console route call exactly this boundary (pinned by the console's own suite).
    const response = await requireConsoleOperator(new Request('http://localhost:3100/', { headers: { cookie: SESSION_COOKIE } }), OPERATOR_ENV);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
  });

  it('operator Basic authentication still works on the operator console', async () => {
    const outcome = await authenticateConsoleOperator(
      new Request('http://localhost:3100/api/runs', { headers: { authorization: `Basic ${btoa('ops:correct-horse-battery-staple')}` } }),
      OPERATOR_ENV,
    );
    expect(outcome).toEqual({ ok: true, principal: { id: 'ops', authMethod: 'basic' } });
  });
});

describe('the customer app surface', () => {
  it('serves exactly the authentication routes, the projects page, and the draft editor — no publish, release, chat or source route', async () => {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (['node_modules', '.next', 'test'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else found.push(relative(CUSTOMER_ROOT, full).split(sep).join('/'));
      }
    };
    await walk(join(CUSTOMER_ROOT, 'app'));
    expect(found.sort()).toEqual([
      'app/api/auth/callback/route.ts',
      'app/api/auth/login/route.ts',
      'app/api/auth/logout/route.ts',
      'app/api/auth/me/route.ts',
      'app/api/projects/[projectId]/editor/route.ts',
      'app/api/projects/[projectId]/edits/[intentId]/route.ts',
      'app/api/projects/[projectId]/edits/route.ts',
      'app/api/projects/[projectId]/preview/[draftId]/[[...route]]/route.ts',
      'app/api/projects/route.ts',
      'app/error.tsx',
      'app/globals.css',
      'app/layout.tsx',
      'app/not-found.tsx',
      'app/page.tsx',
      'app/projects/[projectId]/editor/editor.tsx',
      'app/projects/[projectId]/editor/loading.tsx',
      'app/projects/[projectId]/editor/page.tsx',
      'app/projects/page.tsx',
    ]);
  });

  it.each([
    ['login', 'GET'],
    ['callback', 'GET'],
    ['logout', 'POST'],
    ['me', 'GET'],
  ])('%s fails closed as unavailable when customer auth is not configured — never open, never operator', async (route, method) => {
    for (const key of Object.keys(process.env)) if (key.startsWith('CUSTOMER_')) delete process.env[key];
    Object.assign(process.env, OPERATOR_ENV);
    const mod = (await import(`../app/api/auth/${route}/route.ts`)) as Record<string, (request: Request) => Promise<Response>>;
    const response = await mod[method]!(new Request(`https://app.statxai.example/api/auth/${route}`, { method, headers: { authorization: `Basic ${btoa('ops:correct-horse-battery-staple')}`, origin: 'https://app.statxai.example' } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });
});

describe('the customer editor routes fail closed without customer configuration', () => {
  it.each([
    ['projects', 'GET', '../app/api/projects/route.ts', {}],
    ['editor state', 'GET', '../app/api/projects/[projectId]/editor/route.ts', { projectId: 'proj_x' }],
    ['preview', 'GET', '../app/api/projects/[projectId]/preview/[draftId]/[[...route]]/route.ts', { projectId: 'proj_x', draftId: 'd', route: [] }],
    ['edit submission', 'POST', '../app/api/projects/[projectId]/edits/route.ts', { projectId: 'proj_x' }],
    ['edit status', 'GET', '../app/api/projects/[projectId]/edits/[intentId]/route.ts', { projectId: 'proj_x', intentId: 'i' }],
  ])('%s is unavailable — operator Basic credentials open nothing', async (_name, method, path, params) => {
    for (const key of Object.keys(process.env)) if (key.startsWith('CUSTOMER_')) delete process.env[key];
    Object.assign(process.env, OPERATOR_ENV);
    const mod = (await import(path)) as Record<string, (request: Request, context: { params: Promise<object> }) => Promise<Response>>;
    const response = await mod[method]!(
      new Request('https://app.statxai.example/api/projects', { method, headers: { authorization: `Basic ${btoa('ops:correct-horse-battery-staple')}`, origin: 'https://app.statxai.example' } }),
      { params: Promise.resolve(params) },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });
});
