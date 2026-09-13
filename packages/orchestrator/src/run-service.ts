/**
 * Launching runs.
 *
 * A run takes minutes, so the caller (CLI or console API route) gets an id back
 * immediately and reads progress from the database. Progress writes are chained
 * rather than fired in parallel: events carry a sequence number, and unordered
 * inserts would let the console render "released" above the repair that
 * preceded it.
 */
import { resolve } from 'node:path';
import { RunRecorder, type RunStatus, type StateStore } from '@statxai/state';
import { runProject, type FrontendBackendExecutionMode, type RunOptions } from './orchestrator.js';
import type { RunResult } from './phases/conclude.js';
import { findActiveLineageRoot, findActivePreparedBinding } from './run-binding/frontend-backend.js';

/**
 * `raw` named a real mode (`legacy_direct`/`job_lifecycle`) — never trusted
 * as arbitrary configuration, and never silently downgraded to a default: a
 * typo or stray value here would otherwise select the wrong build authority
 * for a production run without anyone deciding that (Phase 5l §7).
 * Case-sensitive and only whitespace-trimmed, matching the two literal
 * values `FrontendBackendExecutionMode` actually has — no normalisation
 * convention is established for this particular switch (unlike
 * `routing.ts`'s `BUILD_STRATEGY`, which is deliberately fail-*open*: an
 * unrecognised value there is ignored as "no override" rather than fatal,
 * because a developer override is optional in a way a production execution
 * mode is not).
 */
export class InvalidFrontendBackendExecutionModeConfig extends Error {
  constructor(raw: string) {
    super(
      `"${raw}" is not a valid frontend/backend execution mode; expected exactly "legacy_direct" or ` +
        `"job_lifecycle"`,
    );
    this.name = 'InvalidFrontendBackendExecutionModeConfig';
  }
}

export function parseFrontendBackendExecutionMode(raw: string): FrontendBackendExecutionMode {
  const value = raw.trim();
  if (value === 'legacy_direct' || value === 'job_lifecycle') return value;
  throw new InvalidFrontendBackendExecutionModeConfig(raw);
}

/**
 * Phase 5l's one production default: `job_lifecycle` when the operator has
 * not configured anything at all, `parseFrontendBackendExecutionMode(raw)`
 * — fail closed, never a silent fallback — when they have. Exported from
 * this shared module (rather than left as an inline expression in the
 * console's own config file) purely so it has one direct, unit-testable
 * definition; nothing here calls it; only the one activated production
 * entrypoint's own config module does (`apps/console/lib/store.ts`). The
 * production *choice* of `job_lifecycle` still lives at that config layer,
 * not inside `runProject`, `build.ts`, Phase 5i, or the job engine.
 */
export function resolveFrontendBackendExecutionMode(raw: string | undefined): FrontendBackendExecutionMode {
  return raw === undefined ? 'job_lifecycle' : parseFrontendBackendExecutionMode(raw);
}

/**
 * `workspacesRoot` and `validationWorkspacesRoot` resolve to the exact same
 * directory — two independent env vars with two independent defaults
 * (`WORKSPACES_ROOT`/`./workspaces` vs. `VALIDATION_WORKSPACES_ROOT`/
 * `./validation-workspaces`) do not, by themselves, stop an operator from
 * configuring one to equal the other. If they did collide, Phase 5g-1's
 * disposable per-validation directories would be created and torn down
 * *inside* the canonical, harness-owned Git tree `ProjectWorkspace` commits
 * from — the exact class of "two authorities writing the same tree" defect
 * `ActiveJobLifecycleRollbackConflict` exists to prevent for `legacy_direct`
 * vs. an active binding, reachable here by a config typo instead of a race.
 */
export class WorkspaceRootsCollide extends Error {
  constructor(canonical: string) {
    super(
      `workspacesRoot and validationWorkspacesRoot both resolve to "${canonical}" — Phase 5g-1's disposable ` +
        `validation directories must never live inside the canonical project workspace root`,
    );
    this.name = 'WorkspaceRootsCollide';
  }
}

/**
 * Canonicalisation here means `path.resolve` — lexical normalisation
 * (`.`/`..`/repeated separators/relative-vs-absolute) to an absolute path,
 * not `fs.realpath`: both roots are typically created lazily
 * (`ProjectWorkspace.open`'s own `mkdir(..., { recursive: true })`), so a
 * symlink-resolving check would have to tolerate a directory that does not
 * exist yet, which defeats failing closed *before* any filesystem write.
 * Lexical resolution already catches the operationally realistic
 * misconfiguration — the same value, a relative path equal to an absolute
 * one, or a trailing-slash/redundant-segment difference — without requiring
 * either directory to exist first.
 *
 * Only meaningful, and only ever called, when `job_lifecycle` is the
 * resolved mode: `legacy_direct` never opens a validation workspace, so a
 * colliding `validationWorkspacesRoot` is inert for it — matching §19's
 * rule that rollback must never be made to depend on job-mode-only config.
 */
export function assertDistinctWorkspaceRoots(workspacesRoot: string, validationWorkspacesRoot: string): void {
  const canonicalWorkspaces = resolve(workspacesRoot);
  const canonicalValidation = resolve(validationWorkspacesRoot);
  if (canonicalWorkspaces === canonicalValidation) {
    throw new WorkspaceRootsCollide(canonicalWorkspaces);
  }
}

/**
 * A project already has an active, unfinished Phase 5k build binding, and
 * this launch resolved to `legacy_direct` for it. Refused before the legacy
 * builder ever runs: `legacy_direct`'s own commit (`workspace.commit('Terra:
 * build')`, unconditional `git add -A`) and Phase 5h's own promotion both
 * write to the same canonical Git tree with no awareness of each other, and
 * neither's base-commit guard protects every ordering — a promotion whose
 * *first* attempt happens to run after a legacy commit has already moved
 * HEAD simply adopts the new HEAD as its own base and commits on top of it,
 * silently interleaving two independent generations' files with no error
 * raised anywhere (inspected directly in `job-promotion/frontend-backend.ts`
 * before this guard was written — see docs/upgrade-status.md's Phase 5l
 * section for the full trace). So this is not solved by resuming the
 * binding automatically, and it is not solved by deleting or superseding
 * it — both are explicitly out of scope here. It is solved by never letting
 * the two authorities touch the same project at once: an active binding
 * makes `legacy_direct` fail closed for that project until the binding
 * promotes (or a future, separate abandonment capability retires it).
 */
export class ActiveJobLifecycleRollbackConflict extends Error {
  constructor(projectId: string, bindingId: string) {
    super(
      `project "${projectId}" has an active, unfinished job_lifecycle build binding ("${bindingId}"); ` +
        `refusing to start a legacy_direct run against it — legacy_direct and job_lifecycle must never write ` +
        `to the same project's canonical workspace while the other is still in flight`,
    );
    this.name = 'ActiveJobLifecycleRollbackConflict';
  }
}

export interface LaunchOptions {
  store: StateStore;
  intake: unknown;
  workspacesRoot: string;
  autonomyMode?: RunOptions['autonomyMode'];
  projectId?: string;
  /**
   * Harness-configured, never derived from intake or a model decision.
   * Defaults to `'legacy_direct'` — the same default `runProject` itself
   * has — so a caller that never mentions this (every non-activated caller,
   * by construction) behaves exactly as it always has. The one caller Phase
   * 5l activates resolves its own production default (`'job_lifecycle'`
   * when unset) *before* calling here, and always passes the result
   * explicitly — see `apps/console/lib/store.ts`.
   */
  frontendBackendExecutionMode?: FrontendBackendExecutionMode;
  /** Forwarded to `runProject` unchanged — required only when `frontendBackendExecutionMode` resolves to `'job_lifecycle'`. */
  validationWorkspacesRoot?: string;
}

export interface LaunchHandle {
  runId: string;
  projectId: string;
  /** Resolves when the run finishes. The console never awaits this. */
  completed: Promise<RunResult | null>;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'project';
}

export async function launchRun(options: LaunchOptions): Promise<LaunchHandle> {
  const businessName =
    typeof options.intake === 'object' && options.intake && 'businessName' in options.intake
      ? String((options.intake as { businessName: unknown }).businessName)
      : 'Untitled project';

  const suffix = Math.random().toString(36).slice(2, 8);
  const projectId = options.projectId ?? `proj_${slugify(businessName)}_${suffix}`;
  const runId = `run_${suffix}${Date.now().toString(36)}`;
  const autonomyMode = options.autonomyMode ?? 'full_autonomous';
  // Mirrors `runProject`'s own internal default exactly, so a caller that
  // never mentions this option (every caller Phase 5l does not activate)
  // gets identical behaviour to before this option existed.
  const frontendBackendExecutionMode: FrontendBackendExecutionMode =
    options.frontendBackendExecutionMode ?? 'legacy_direct';

  // Fails closed, before a run record is even created: two build
  // authorities must never write to the same project's canonical workspace
  // at once. This is a property of the *project*, not of which caller asked
  // — a rollback-configured production caller and an unmodified script
  // caller are guarded identically, since both would corrupt the same
  // workspace the same way. See `ActiveJobLifecycleRollbackConflict`'s own
  // doc comment.
  if (frontendBackendExecutionMode === 'legacy_direct') {
    const activeBinding = await findActivePreparedBinding(options.store, projectId);
    if (activeBinding) {
      throw new ActiveJobLifecycleRollbackConflict(projectId, activeBinding._id);
    }
    // Nothing is mid-build, but an unfinished *lineage* can still own the
    // project: its build promoted and its run never reached a durable terminal
    // state. A `legacy_direct` run would write that same canonical workspace,
    // so it fails closed on that too — the identical property, asked one
    // question later. A widening of this existing guard by one indexed read;
    // this slice adds no recovery of its own.
    const owningLineage = await findActiveLineageRoot(options.store, projectId);
    if (owningLineage) {
      throw new ActiveJobLifecycleRollbackConflict(projectId, owningLineage._id);
    }
  }

  const recorder = await RunRecorder.start(options.store, {
    runId,
    projectId,
    businessName,
    autonomyMode,
  });

  // Observability only — reuses the existing run-event stream, never a new
  // pipeline. No JobSpec, secret, artifact content or credential is ever in
  // scope here: the mode is one of exactly two literal strings.
  await recorder.event('discover', `frontend_backend_execution_mode=${frontendBackendExecutionMode}`, 'info');

  // Serialise progress writes so sequence numbers match causal order.
  let chain: Promise<unknown> = Promise.resolve();

  const completed = (async (): Promise<RunResult | null> => {
    try {
      const result = await runProject({
        projectId,
        intake: options.intake,
        store: options.store,
        workspacesRoot: options.workspacesRoot,
        autonomyMode,
        frontendBackendExecutionMode,
        ...(options.validationWorkspacesRoot !== undefined
          ? { validationWorkspacesRoot: options.validationWorkspacesRoot }
          : {}),
        onProgress: ({ phase, detail, level = 'info' }) => {
          chain = chain.then(() => recorder.event(phase, detail, level)).catch(() => {});
        },
      });

      await chain;
      await recorder.finish({
        status: result.outcome as RunStatus,
        qualityScore: result.qualityScore,
        reviewCycles: result.reviewCycles,
        repairsApplied: result.repairsApplied,
        commit: result.commit,
        liveUrl: result.manifest?.url ?? null,
        usage: result.usage,
        usageByTier: result.usageByTier,
        phaseMs: result.phaseMs,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await chain;
      await recorder.event('failed', message, 'fail').catch(() => {});
      await recorder.finish({ status: 'failed', error: message });
      return null;
    }
  })();

  return { runId, projectId, completed };
}
