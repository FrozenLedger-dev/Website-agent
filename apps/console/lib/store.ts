import { isAbsolute, resolve } from 'node:path';
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

/**
 * Project workspaces live at the monorepo root, but Next runs with its own
 * package directory as cwd — so a relative WORKSPACES_ROOT resolved to
 * `apps/console/workspaces`, which does not exist, and every preview 404'd.
 * Relative values are anchored to the repo root; absolute ones are respected.
 */
export const WORKSPACES_ROOT = (() => {
  const configured = process.env.WORKSPACES_ROOT ?? './workspaces';
  return isAbsolute(configured) ? configured : resolve(process.cwd(), '../..', configured);
})();
