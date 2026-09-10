import { isAbsolute, resolve } from 'node:path';
import { StateStore } from '@statxai/state';
import {
  assertDistinctWorkspaceRoots,
  resolveFrontendBackendExecutionMode,
  type FrontendBackendExecutionMode,
} from '@statxai/orchestrator';

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

/**
 * Phase 5g-1's disposable validation workspace root — a real directory,
 * never the canonical `WORKSPACES_ROOT` above: 5g-1 creates and tears down a
 * fresh directory here for every validation, and doing that inside the
 * canonical project's own Git tree would leave temporary files in it. Same
 * relative-path anchoring as `WORKSPACES_ROOT`, for the same reason (Next's
 * cwd is `apps/console`, not the repo root). Always computed — legacy_direct
 * never reads it, so an unset/default value here never blocks rollback
 * (Phase 5l §19).
 */
export const VALIDATION_WORKSPACES_ROOT = (() => {
  const configured = process.env.VALIDATION_WORKSPACES_ROOT ?? './validation-workspaces';
  return isAbsolute(configured) ? configured : resolve(process.cwd(), '../..', configured);
})();

/**
 * Phase 5l's production default: `job_lifecycle` for this entrypoint (the
 * console's own launch route) unless an operator explicitly configures
 * `FRONTEND_BACKEND_EXECUTION_MODE=legacy_direct` for rollback. Resolved
 * once, at module load — like `WORKSPACES_ROOT` above — so a typo'd
 * environment value fails the console's startup/first import rather than
 * surfacing mid-run, deep inside a launch already in progress (§18). An
 * explicitly-present but invalid value is never silently treated as either
 * default: `parseFrontendBackendExecutionMode` throws, and that throw is
 * deliberately allowed to propagate out of this module.
 *
 * `runProject` itself still defaults to `'legacy_direct'` — untouched by
 * this constant, which exists one layer up, in this entrypoint's own
 * configuration, exactly where Phase 5l's brief places a production
 * default (never inside `runProject`, `build.ts`, Phase 5i, or the job
 * engine).
 */
export const FRONTEND_BACKEND_EXECUTION_MODE: FrontendBackendExecutionMode = resolveFrontendBackendExecutionMode(
  process.env.FRONTEND_BACKEND_EXECUTION_MODE,
);

/**
 * Neither `WORKSPACES_ROOT` nor `VALIDATION_WORKSPACES_ROOT` having its own
 * distinct env var and default (above) actually stops an operator from
 * configuring one to equal the other — that misconfiguration would put
 * Phase 5g-1's disposable validation directories inside the canonical Git
 * tree `ProjectWorkspace` commits from. Checked once at module load, and
 * only when `job_lifecycle` is the resolved mode: `legacy_direct` never
 * opens a validation workspace, so this must not turn a colliding-but-unused
 * `VALIDATION_WORKSPACES_ROOT` into a rollback blocker (§19). A collision
 * throws here, failing the console's startup/first import before any run
 * — never discovered only once a validation directory is actually created
 * inside the canonical tree.
 */
if (FRONTEND_BACKEND_EXECUTION_MODE === 'job_lifecycle') {
  assertDistinctWorkspaceRoots(WORKSPACES_ROOT, VALIDATION_WORKSPACES_ROOT);
}
