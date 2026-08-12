import { StateStore } from '@statxai/state';

/**
 * One Mongo connection per process, cached across hot reloads.
 *
 * Next's dev server re-evaluates modules on every edit; without the global
 * cache each reload would open another connection pool and eventually exhaust
 * the server's connection limit.
 */
const globalForStore = globalThis as unknown as { statxaiStore?: Promise<StateStore> };

export function getStore(): Promise<StateStore> {
  globalForStore.statxaiStore ??= StateStore.connect().then(async (store) => {
    await store.ensureIndexes();
    return store;
  });
  return globalForStore.statxaiStore;
}

export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? './workspaces';
