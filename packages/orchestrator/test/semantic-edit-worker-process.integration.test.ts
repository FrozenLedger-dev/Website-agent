/**
 * The semantic-edit worker as a real standalone process: started without Next,
 * connected to real durable state, idle-polling, and stopping on SIGTERM.
 *
 * Integration: needs the Mongo replica set. Uses its own database so the process
 * never sees another suite's work.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '@statxai/state';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0';
const DB = 'statxai_worker_process_test';
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('the standalone semantic-edit worker process', () => {
  it('starts outside Next, connects to durable state, polls, and stops cleanly on SIGTERM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statxai-worker-process-'));
    roots.push(root);
    const child = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'scripts', 'semantic-edit-worker.ts')], {
      cwd: REPO,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? root,
        MONGODB_URI: URI,
        MONGODB_DB: DB,
        WORKSPACES_ROOT: join(root, 'workspaces'),
        VALIDATION_WORKSPACES_ROOT: join(root, 'validation'),
        SEMANTIC_EDIT_WORKER_POLL_MS: '100',
        SEMANTIC_EDIT_WORKER_LEASE_MS: '10000',
        SEMANTIC_EDIT_WORKER_HEARTBEAT_MS: '1000',
        SEMANTIC_EDIT_WORKER_SHUTDOWN_GRACE_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: Record<string, unknown>[] = [];
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          lines.push({ raw: line });
        }
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

    const started = Date.now();
    while (!lines.some((l) => l.event === 'worker_started')) {
      if (Date.now() - started > 60_000) throw new Error(`worker did not start: ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const startedEvent = lines.find((l) => l.event === 'worker_started')!;
    expect(startedEvent).toMatchObject({ limits: { concurrency: 1, pollMs: 100, leaseMs: 10_000, heartbeatMs: 1_000 } });
    expect(String(startedEvent.owner)).toMatch(/:\d+:[a-f0-9]{8}$/);

    // It really connected: its indexes exist in its own database.
    const store = await StateStore.connect({ uri: URI, dbName: DB });
    try {
      const indexes = await store.semanticEditIntents.indexes();
      expect(indexes.map((i) => i.name)).toContain('status_1_createdAt_1');
    } finally {
      await store.close();
    }

    await new Promise((r) => setTimeout(r, 400));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(lines.map((l) => l.event)).toEqual(expect.arrayContaining(['worker_started', 'signal', 'worker_stopping', 'worker_stopped']));
    expect(lines.findIndex((l) => l.event === 'worker_stopped')).toBeGreaterThan(lines.findIndex((l) => l.event === 'signal'));
    expect(JSON.stringify(lines)).not.toMatch(/token|password|secret/i);
  }, 90_000);

  it('refuses invalid configuration before connecting', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'scripts', 'semantic-edit-worker.ts')], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? '', MONGODB_URI: URI, MONGODB_DB: DB, SEMANTIC_EDIT_WORKER_CONCURRENCY: 'many' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code).toBe(1);
    expect(out).toContain('worker_crashed');
    expect(out).toContain('SEMANTIC_EDIT_WORKER_CONCURRENCY must be a whole number');
  }, 60_000);
});
