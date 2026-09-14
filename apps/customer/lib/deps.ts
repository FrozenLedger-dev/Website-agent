/**
 * The customer app's server-side collaborators, built once per process.
 *
 * Configuration comes from server-only environment variables and is validated
 * before any route can use it; the OpenID provider is discovered once. None of
 * this is reachable from browser code: route handlers are the only importers.
 */
import { StateStore } from '@statxai/state';
import {
  customerAuthConfigFromEnv,
  discoverCustomerOidc,
  type CustomerAuthConfig,
  type CustomerAuthHttpDeps,
} from '@statxai/customer-auth';

const cache = globalThis as unknown as { statxaiCustomerDeps?: Promise<CustomerAuthHttpDeps> };

export function getCustomerAuthDeps(): Promise<CustomerAuthHttpDeps> {
  cache.statxaiCustomerDeps ??= (async () => {
    const config: CustomerAuthConfig = customerAuthConfigFromEnv(process.env);
    const store = await StateStore.connect();
    await store.ensureIndexes();
    const oidc = await discoverCustomerOidc(config);
    return { store, config, oidc };
  })().catch((error: unknown) => {
    // A failed start is retried on the next request rather than cached forever.
    delete cache.statxaiCustomerDeps;
    throw error;
  });
  return cache.statxaiCustomerDeps;
}

/** When the app is not (or not safely) configured, customer auth is unavailable — never open. */
export function customerAuthUnavailableResponse(): Response {
  return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
}
