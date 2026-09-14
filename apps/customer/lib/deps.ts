/**
 * The customer app's server-side collaborators, built once per process.
 *
 * Configuration comes from server-only environment variables and is validated
 * before any route can use it; the OpenID provider is discovered once, and only
 * for the authentication routes. None of this is reachable from browser code:
 * route handlers and server components are the only importers.
 */
import { isAbsolute, resolve } from 'node:path';
import { StateStore } from '@statxai/state';
import {
  customerAuthConfigFromEnv,
  discoverCustomerOidc,
  type CustomerAuthConfig,
  type CustomerAuthHttpDeps,
} from '@statxai/customer-auth';
import type { CustomerEditorDeps } from '@statxai/customer-editor';

const cache = globalThis as unknown as {
  statxaiCustomerStore?: Promise<StateStore>;
  statxaiCustomerDeps?: Promise<CustomerAuthHttpDeps>;
};

function retryOnFailure<T>(key: 'statxaiCustomerStore' | 'statxaiCustomerDeps', start: () => Promise<T>): Promise<T> {
  const existing = cache[key] as Promise<T> | undefined;
  if (existing) return existing;
  const started = start().catch((error: unknown) => {
    // A failed start is retried on the next request rather than cached forever.
    delete cache[key];
    throw error;
  });
  (cache as Record<string, unknown>)[key] = started;
  return started;
}

function customerStore(): Promise<StateStore> {
  return retryOnFailure('statxaiCustomerStore', async () => {
    const store = await StateStore.connect();
    await store.ensureIndexes();
    return store;
  });
}

export function getCustomerAuthDeps(): Promise<CustomerAuthHttpDeps> {
  return retryOnFailure('statxaiCustomerDeps', async () => {
    const config: CustomerAuthConfig = customerAuthConfigFromEnv(process.env);
    const store = await customerStore();
    const oidc = await discoverCustomerOidc(config);
    return { store, config, oidc };
  });
}

/**
 * Workspace roots live at the monorepo root, but Next runs with its own package
 * directory as cwd: relative values are anchored to the repo root, absolute ones
 * respected — exactly as the operator console and the worker resolve them.
 */
const repoRooted = (name: string, fallback: string) => {
  const configured = process.env[name] ?? fallback;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), '../..', configured);
};

/** What editor routes and pages need: the store, customer configuration and the workspace roots submission reads. No OIDC discovery. */
export async function getCustomerEditorDeps(): Promise<CustomerEditorDeps> {
  const config = customerAuthConfigFromEnv(process.env);
  return {
    store: await customerStore(),
    config,
    workspacesRoot: repoRooted('WORKSPACES_ROOT', './workspaces'),
    validationWorkspacesRoot: repoRooted('VALIDATION_WORKSPACES_ROOT', './validation-workspaces'),
  };
}

/** When the app is not (or not safely) configured, customer auth is unavailable — never open. */
export function customerAuthUnavailableResponse(): Response {
  return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
}
