/**
 * The initial-draft worker process.
 *
 *   pnpm worker:initial-draft
 *   (or, where the environment is provided by the host: node --import tsx scripts/initial-draft-worker.ts)
 *
 * A long-running process, separate from the customer app, the operator console
 * and the semantic-edit worker, that continues every customer-submitted
 * initial-draft generation request until it concludes a canonical draft or
 * reaches a known terminal failure. A submitted request makes progress only
 * while at least one of these is running: a customer route that records the
 * request durably and returns 202 is relying on it.
 *
 * Environment:
 *   MONGODB_URI, MONGODB_DB                   durable state (as every entrypoint)
 *   WORKSPACES_ROOT                            canonical project workspaces
 *   VALIDATION_WORKSPACES_ROOT                 disposable validation workspaces
 *   INITIAL_DRAFT_WORKER_CONCURRENCY           requests executed at once (default 1)
 *   INITIAL_DRAFT_WORKER_POLL_MS               idle poll interval (default 5000)
 *   INITIAL_DRAFT_WORKER_LEASE_MS              execution lease lifetime (default 120000)
 *   INITIAL_DRAFT_WORKER_HEARTBEAT_MS          lease renewal interval (default 30000)
 *   INITIAL_DRAFT_WORKER_SHUTDOWN_GRACE_MS     how long SIGTERM waits for running work (default 30000)
 *
 * SIGTERM/SIGINT: stop claiming, abort running generations between their
 * steps, wait at most the grace period, close the store, exit. Unreleased
 * execution leases simply expire; another worker continues those requests.
 *
 * Logs are one JSON object per line: events and ids only — never provider
 * output, source or prompts.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { StateStore } from '@statxai/state';
import { assertDistinctWorkspaceRoots, InitialDraftWorker, type InitialDraftWorkerLimits } from '@statxai/orchestrator';

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

  const limits: Partial<InitialDraftWorkerLimits> = {};
  for (const [key, env] of [
    ['concurrency', 'INITIAL_DRAFT_WORKER_CONCURRENCY'],
    ['pollMs', 'INITIAL_DRAFT_WORKER_POLL_MS'],
    ['leaseMs', 'INITIAL_DRAFT_WORKER_LEASE_MS'],
    ['heartbeatMs', 'INITIAL_DRAFT_WORKER_HEARTBEAT_MS'],
  ] as const) {
    const value = integer(env);
    if (value !== undefined) (limits as Record<string, number>)[key] = value;
  }
  const graceMs = integer('INITIAL_DRAFT_WORKER_SHUTDOWN_GRACE_MS') ?? 30_000;

  const store = await StateStore.connect();
  await store.ensureIndexes();

  const worker = new InitialDraftWorker({
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
