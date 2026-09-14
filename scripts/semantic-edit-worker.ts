/**
 * The semantic-edit worker process.
 *
 *   pnpm worker:semantic-edit
 *   (or, where the environment is provided by the host: node --import tsx scripts/semantic-edit-worker.ts)
 *
 * A long-running process, separate from the customer app and the operator
 * console, that continues every submitted semantic edit until it concludes a new
 * draft or reaches a known terminal failure. A submitted edit makes progress
 * only while at least one of these is running: a request that submits an edit
 * durably and returns is relying on it.
 *
 * Environment:
 *   MONGODB_URI, MONGODB_DB                 durable state (as every entrypoint)
 *   WORKSPACES_ROOT                          canonical project workspaces
 *   VALIDATION_WORKSPACES_ROOT               disposable validation workspaces
 *   SEMANTIC_EDIT_WORKER_CONCURRENCY         edits executed at once (default 1)
 *   SEMANTIC_EDIT_WORKER_POLL_MS             idle poll interval (default 5000)
 *   SEMANTIC_EDIT_WORKER_LEASE_MS            execution lease lifetime (default 120000)
 *   SEMANTIC_EDIT_WORKER_HEARTBEAT_MS        lease renewal interval (default 30000)
 *   SEMANTIC_EDIT_WORKER_SHUTDOWN_GRACE_MS   how long SIGTERM waits for running work (default 30000)
 *
 * SIGTERM/SIGINT: stop claiming, abort running edits between steps, wait at most
 * the grace period, close the store, exit. Draft claims are never released;
 * unreleased execution leases expire and another worker continues those edits.
 *
 * Logs are one JSON object per line: events and ids only — never tokens,
 * source, prompts or provider output.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { StateStore } from '@statxai/state';
import { SemanticEditWorker, assertDistinctWorkspaceRoots, type SemanticEditWorkerLimits } from '@statxai/orchestrator';

const root = (name: string, fallback: string) => {
  const configured = process.env[name] ?? fallback;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
};
const integer = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, not ${JSON.stringify(raw)}`);
  return Number(raw);
};

const logLine = (event: object) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

async function main(): Promise<void> {
  const workspacesRoot = root('WORKSPACES_ROOT', './workspaces');
  const validationWorkspacesRoot = root('VALIDATION_WORKSPACES_ROOT', './validation-workspaces');
  assertDistinctWorkspaceRoots(workspacesRoot, validationWorkspacesRoot);

  const limits: Partial<SemanticEditWorkerLimits> = {};
  for (const [key, env] of [
    ['concurrency', 'SEMANTIC_EDIT_WORKER_CONCURRENCY'],
    ['pollMs', 'SEMANTIC_EDIT_WORKER_POLL_MS'],
    ['leaseMs', 'SEMANTIC_EDIT_WORKER_LEASE_MS'],
    ['heartbeatMs', 'SEMANTIC_EDIT_WORKER_HEARTBEAT_MS'],
  ] as const) {
    const value = integer(env);
    if (value !== undefined) (limits as Record<string, number>)[key] = value;
  }
  const graceMs = integer('SEMANTIC_EDIT_WORKER_SHUTDOWN_GRACE_MS') ?? 30_000;

  const store = await StateStore.connect();
  await store.ensureIndexes();

  const worker = new SemanticEditWorker({
    store,
    workspacesRoot,
    validationWorkspacesRoot,
    owner: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    limits,
    log: logLine,
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logLine({ event: 'signal', signal });
    void worker
      .stop(graceMs)
      .then(() => store.close())
      .then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await worker.start();
}

main().catch((error: unknown) => {
  logLine({ event: 'worker_crashed', error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
