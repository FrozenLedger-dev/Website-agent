/**
 * Launching runs.
 *
 * A run takes minutes, so the caller (CLI or console API route) gets an id back
 * immediately and reads progress from the database. Progress writes are chained
 * rather than fired in parallel: events carry a sequence number, and unordered
 * inserts would let the console render "released" above the repair that
 * preceded it.
 */
import { RunRecorder, type RunStatus, type StateStore } from '@statxai/state';
import { runProject, type RunOptions, type RunResult } from './orchestrator.js';

export interface LaunchOptions {
  store: StateStore;
  intake: unknown;
  workspacesRoot: string;
  autonomyMode?: RunOptions['autonomyMode'];
  projectId?: string;
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

  const recorder = await RunRecorder.start(options.store, {
    runId,
    projectId,
    businessName,
    autonomyMode,
  });

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
        usage: result.usage,
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
