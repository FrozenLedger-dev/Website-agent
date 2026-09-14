/**
 * The initial-draft worker: its bounded configuration offline, and its
 * authority structurally.
 *
 * Creation is separate from execution; the worker is a standalone process over
 * `initial_draft_requests`, not a queue and not a Next promise; it continues
 * generation only by calling `runProject` with `completionTarget: 'draft'`;
 * its execution lease is liveness, never draft or project authority; a stuck
 * `frontend_backend` job lease is reclaimed exactly, and only once expired;
 * and nothing here reaches release, customer sessions, or a customer route.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INITIAL_DRAFT_WORKER_DEFAULTS, InitialDraftWorkerConfigInvalid, resolveInitialDraftWorkerLimits } from '../src/initial-draft/worker.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));
const WORKER = 'packages/orchestrator/src/initial-draft/worker.ts';
const EXECUTION = 'packages/orchestrator/src/initial-draft/execution.ts';
const GENERATE = 'packages/orchestrator/src/initial-draft/generate.ts';
const SCRIPT = 'scripts/initial-draft-worker.ts';

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', 'test', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}
function body(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return code.slice(from, to);
}

describe('worker configuration', () => {
  it('defaults conservatively', () => {
    expect(INITIAL_DRAFT_WORKER_DEFAULTS).toEqual({ concurrency: 1, pollMs: 5_000, leaseMs: 120_000, heartbeatMs: 30_000, maxExecutionFailures: 3 });
    expect(resolveInitialDraftWorkerLimits()).toEqual(INITIAL_DRAFT_WORKER_DEFAULTS);
  });

  it.each([
    [{ concurrency: 0 }],
    [{ concurrency: 17 }],
    [{ concurrency: 1.5 }],
    [{ pollMs: 10 }],
    [{ leaseMs: 500 }],
    [{ heartbeatMs: 60_001, leaseMs: 120_000 }],
    [{ maxExecutionFailures: 0 }],
  ])('refuses %j', (limits) => {
    expect(() => resolveInitialDraftWorkerLimits(limits)).toThrow(InitialDraftWorkerConfigInvalid);
  });
});

describe('creation is distinct from execution', () => {
  it('creating mints a project, binds it and records one durable request — nothing plans, builds or evaluates', async () => {
    const generate = await src(GENERATE);
    const create = body(generate, 'export async function createInitialDraftRequest(', '\n}\n');
    expect(create).not.toMatch(/runProject\(|discoverProject\(|evaluateSite|createFrontendBackendLifecycleCoordinator/);
    expect(create).toMatch(/await store\.initialDraftRequests\.insertOne\(document\);/);
    expect(create).toMatch(/await store\.projectAccountBindings\.insertOne\(/);
  });

  it('a create request never runs synchronously and never fires the run in the background: no launch-and-forget pattern', async () => {
    for (const file of [GENERATE, EXECUTION, 'packages/customer-editor/src/creation.ts', 'packages/customer-editor/src/http.ts']) {
      const code = await src(file);
      if (file === GENERATE) continue; // resumeInitialDraftGeneration legitimately calls runProject — only the worker calls it.
      expect(code, file).not.toMatch(/runProject\(/);
      expect(code, file).not.toMatch(/void runProject|setTimeout\(|setImmediate\(|queueMicrotask\(|new Promise\(/);
    }
    // The one and only place `runProject` is called for initial generation.
    expect((await src(GENERATE)).match(/runProject\(\{/g)).toHaveLength(1);
  });
});

describe('the worker is a standalone process over initial_draft_requests', () => {
  it('has a real entrypoint and script, and no app starts it', async () => {
    const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['worker:initial-draft']).toBe('node --env-file=.env.local --import tsx scripts/initial-draft-worker.ts');
    const script = await src(SCRIPT);
    expect(script).toMatch(/new InitialDraftWorker\(/);
    expect(script).toMatch(/process\.on\('SIGTERM', shutdown\)/);
    expect(script).toMatch(/process\.on\('SIGINT', shutdown\)/);
    expect(script).toMatch(/await StateStore\.connect\(\)/);
    expect(script).not.toMatch(/next|createServer|listen\(/);
    for (const file of [...(await productionFiles('apps/customer')), ...(await productionFiles('apps/console'))]) {
      expect(await src(file), file).not.toMatch(/InitialDraftWorker|resumeInitialDraftGeneration|claimInitialDraftGeneration/);
    }
  });

  it('discovers work only in initial_draft_requests, with no second queue', async () => {
    const execution = await src(EXECUTION);
    expect(execution).toMatch(/store\.initialDraftRequests\.findOneAndUpdate\(/);
    expect(execution).not.toMatch(/store\.jobs|frontendBackendBuildBindings|canonicalDrafts|artifacts|semanticEditIntents/);
    const worker = await src(WORKER);
    expect(worker).not.toMatch(/store\.jobs\.find\(|jobs\.find\(\{ state/);
    const deps = JSON.stringify(JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')));
    expect(deps).not.toMatch(/redis|bullmq|amqplib|kafkajs|agenda|bee-queue/i);
    for (const file of await productionFiles('packages')) expect(await src(file), file).not.toMatch(/from '(ioredis|redis|bullmq|amqplib|kafkajs)'/);
  });

  it('reclaims only the request\'s own frontend_backend job, and only once its lease has truly expired', async () => {
    const generate = await src(GENERATE);
    expect(generate.match(/reclaimExpiredJobLease\(/g)).toHaveLength(1);
    const reclaim = body(generate, 'const binding = await findActivePreparedBinding(store, lease.projectId);', '\n  }\n');
    expect(reclaim).toMatch(/store\.jobs\.findOne\(\{ _id: binding\.jobId, projectId: lease\.projectId \}\)/);
    expect(reclaim).toMatch(/job\.lease\.expiresAt\.getTime\(\) <= now\.getTime\(\)/);
    expect(reclaim).toMatch(/engine\.reclaimExpiredJobLease\(job\._id,/);
    const engine = await src('packages/job-engine/src/engine.ts');
    const exact = body(engine, 'async reclaimExpiredJobLease(', '\n  }\n');
    expect(exact).toMatch(/\{ _id: jobId, state: 'running', attempt: job\.attempt, 'lease\.expiresAt': \{ \$lte: now \} \}/);
  });

  it('resuming checks for an already-concluded draft first — a crash between runProject returning and this module recording it can never wedge the request', async () => {
    const generate = await src(GENERATE);
    const resume = body(generate, 'export async function resumeInitialDraftGeneration(', '\n}\n');
    expect(resume.indexOf('resolveCanonicalDraftAuthority(store, lease.projectId)')).toBeGreaterThan(-1);
    expect(resume.indexOf("authority?.state === 'concluded'")).toBeLessThan(resume.indexOf('findActivePreparedBinding'));
    expect(resume.indexOf('findActivePreparedBinding')).toBeLessThan(resume.indexOf('runProject({'));
  });

  it('a worker lease is liveness only: nothing in execution or the worker touches project state, tenancy or the canonical draft claim', async () => {
    for (const file of [WORKER, EXECUTION, SCRIPT]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/releaseCanonicalDraftClaim|claimCanonicalDraft|handOffCanonicalDraft|activeLineage|projectAccountBindings\.|customerMemberships\.|customerAccounts\./);
    }
    const execution = await src(EXECUTION);
    for (const fn of ['heartbeatInitialDraftGeneration', 'releaseInitialDraftGeneration', 'recordInitialDraftDisposition', 'completeInitialDraftGeneration']) {
      expect(body(execution, `export async function ${fn}(`, '\n}\n')).toMatch(/'execution\.token': lease\.token/);
    }
    expect(body(execution, 'const runnable = ', '});')).toMatch(/\{ 'execution\.expiresAt': \{ \$lte: now \} \}/);
  });

  it('holds no customer identity and no release authority', async () => {
    for (const file of [WORKER, EXECUTION, SCRIPT]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/@statxai\/customer-auth|cookie|session(Id|Token)|oidc|authorization/i);
      expect(code, file).not.toMatch(/seekRelease|publishRelease|releasePublications|deploySite|recommendApproval|release-publication|phases\/(publish|release)|from '\.\.\/release\.js'/);
    }
  });

  it('bounds concurrency, polls instead of spinning, and stops claiming on shutdown', async () => {
    const worker = await src(WORKER);
    expect(body(worker, 'async claimOne(): Promise<boolean> {', '\n  }\n')).toMatch(/if \(this\.stopping\.signal\.aborted \|\| this\.active\.size >= this\.limits\.concurrency\) return false;/);
    expect(body(worker, 'private async run(): Promise<void> {', '\n  }\n')).toMatch(/await abortableSleep\(this\.limits\.pollMs, this\.stopping\.signal\);/);
    expect(body(worker, 'async stop(graceMs = 30_000): Promise<void> {', '\n  }\n')).toMatch(/this\.stopping\.abort\(\);[\s\S]*controller\.abort\(\)/);
  });

  it('never targets release: completionTarget is always the literal "draft", never forwarded from a caller', async () => {
    const generate = await src(GENERATE);
    expect(generate).toMatch(/completionTarget: 'draft',/);
    expect(generate).not.toMatch(/completionTarget: options|completionTarget: input|completionTarget: request/);
    expect(generate).toMatch(/frontendBackendExecutionMode: 'job_lifecycle',/);
  });

  it('is a separate process from the semantic-edit worker: no shared collection, no shared class', async () => {
    const worker = await src(WORKER);
    expect(worker).not.toMatch(/SemanticEditWorker|semanticEditIntents|semantic-edit/);
    const semanticWorker = await src('packages/orchestrator/src/semantic-edit/worker.ts');
    expect(semanticWorker).not.toMatch(/InitialDraftWorker|initialDraftRequests|initial-draft/);
  });
});
