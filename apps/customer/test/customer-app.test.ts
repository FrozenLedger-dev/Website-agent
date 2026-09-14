/**
 * The customer app and the operator console are separate authorities.
 *
 * A customer session never reaches an operator route; operator Basic
 * credentials never produce a customer; the customer app serves only its four
 * authentication routes, each failing closed when customer auth is not
 * configured.
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
  it('serves exactly the four customer authentication routes, and no page, editor or project route', async () => {
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
    expect(found.sort()).toEqual(['app/api/auth/callback/route.ts', 'app/api/auth/login/route.ts', 'app/api/auth/logout/route.ts', 'app/api/auth/me/route.ts']);
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
