/**
 * The semantic-edit worker: its bounded configuration offline, and its authority
 * structurally.
 *
 * Submission is separate from execution; the worker is a standalone process
 * over `semantic_edit_intents`, not a queue and not a Next promise; it continues
 * edits only through the one semantic-edit continuation; its lease is liveness,
 * never draft authority; job reclamation is exact and bounded; and nothing here
 * reaches release, customer sessions, or a customer route.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEMANTIC_EDIT_WORKER_DEFAULTS, SemanticEditWorkerConfigInvalid, resolveSemanticEditWorkerLimits } from '../src/semantic-edit/worker.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));
const WORKER = 'packages/orchestrator/src/semantic-edit/worker.ts';
const EXECUTION = 'packages/orchestrator/src/semantic-edit/execution.ts';
const APPLY = 'packages/orchestrator/src/semantic-edit/apply.ts';
const SCRIPT = 'scripts/semantic-edit-worker.ts';

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
    expect(SEMANTIC_EDIT_WORKER_DEFAULTS).toEqual({ concurrency: 1, pollMs: 5_000, leaseMs: 120_000, heartbeatMs: 30_000, maxExecutionFailures: 3 });
    expect(resolveSemanticEditWorkerLimits()).toEqual(SEMANTIC_EDIT_WORKER_DEFAULTS);
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
    expect(() => resolveSemanticEditWorkerLimits(limits)).toThrow(SemanticEditWorkerConfigInvalid);
  });
});

describe('submission is distinct from execution', () => {
  it('submitting prepares and returns; the synchronous form is the same preparation plus the one continuation', async () => {
    const apply = await src(APPLY);
    const submit = body(apply, 'export async function submitSemanticEdit(', '\n}\n');
    expect(submit).not.toMatch(/continueSemanticEdit|coordinator|evaluateSite|concludeCanonicalDraft/);
    expect(body(apply, 'async function prepareSemanticEdit(', '\n}\n')).not.toMatch(/continueSemanticEdit|createFrontendBackendLifecycleCoordinator|editSiteSemantically|evaluateSite/);
    expect(apply.match(/continueSemanticEdit\(/g)).toHaveLength(4);
    expect(apply.match(/async function prepareSemanticEdit\(/g)).toHaveLength(1);
  });

  it('every intent write a leased continuation makes is fenced on the lease token', async () => {
    const apply = await src(APPLY);
    const advance = body(apply, 'async function advanceIntent(', '\n}\n');
    expect(advance).toMatch(/const fence = execution\.leaseToken !== undefined \? \{ 'execution\.token': execution\.leaseToken \} : \{\};/);
    expect(advance).toMatch(/status: from, \.\.\.fence \}/);
    expect(advance).toMatch(/throw new SemanticEditExecutionLeaseLost/);
    expect(apply).toMatch(/status: 'evaluated', \.\.\.\(execution\.leaseToken !== undefined \? \{ 'execution\.token': execution\.leaseToken \} : \{\}\) \}/);
    const calls = apply.match(/await advanceIntent\([^;]*;/gs) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatch(/execution\);$/);
  });
});

describe('the worker is a standalone process over semantic_edit_intents', () => {
  it('has a real entrypoint and script, and no app starts it', async () => {
    const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['worker:semantic-edit']).toBe('node --env-file=.env.local --import tsx scripts/semantic-edit-worker.ts');
    const script = await src(SCRIPT);
    expect(script).toMatch(/new SemanticEditWorker\(/);
    expect(script).toMatch(/process\.on\('SIGTERM', shutdown\)/);
    expect(script).toMatch(/process\.on\('SIGINT', shutdown\)/);
    expect(script).toMatch(/await StateStore\.connect\(\)/);
    expect(script).not.toMatch(/next|createServer|listen\(/);
    for (const file of [...(await productionFiles('apps/customer')), ...(await productionFiles('apps/console'))]) {
      expect(await src(file), file).not.toMatch(/SemanticEditWorker|resumeSemanticEdit|submitSemanticEdit|applySemanticEdit|claimSemanticEditExecution/);
    }
  });

  it('discovers work only in semantic_edit_intents, with no second queue', async () => {
    const execution = await src(EXECUTION);
    expect(execution).toMatch(/store\.semanticEditIntents\.findOneAndUpdate\(/);
    expect(execution).not.toMatch(/store\.jobs|frontendBackendBuildBindings|canonicalDrafts|artifacts/);
    const worker = await src(WORKER);
    expect(worker).not.toMatch(/store\.jobs\.find\(|jobs\.find\(\{ state/);
    const deps = JSON.stringify(JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')));
    expect(deps).not.toMatch(/redis|bullmq|amqplib|kafkajs|agenda|bee-queue/i);
    for (const file of await productionFiles('packages')) expect(await src(file), file).not.toMatch(/from '(ioredis|redis|bullmq|amqplib|kafkajs)'/);
  });

  it('continues edits only through the semantic-edit continuation, and reclaims only the edit\'s own job', async () => {
    const worker = await src(WORKER);
    expect(worker.match(/resumeSemanticEditIntent\(/g)).toHaveLength(1);
    expect(worker).not.toMatch(/createFrontendBackendLifecycleCoordinator|prepareFrontendBackendBuildBinding|promoteAccepted|acceptValidated|editSiteSemantically|evaluateSite|concludeCanonicalDraft|handOffCanonicalDraft/);
    expect(worker).not.toMatch(/reclaimExpiredLeases\(/);
    const reclaim = body(worker, 'if (lease.status === \'building\') {', '\n      }\n');
    expect(reclaim).toMatch(/store\.jobs\.findOne\(\{ _id: lease\.jobId, projectId: lease\.projectId \}\)/);
    expect(reclaim).toMatch(/job\.lease\.expiresAt\.getTime\(\) <= this\.now\(\)\.getTime\(\)/);
    expect(reclaim).toMatch(/this\.engine\.reclaimExpiredJobLease\(job\._id,/);
    const engine = await src('packages/job-engine/src/engine.ts');
    const exact = body(engine, 'async reclaimExpiredJobLease(', '\n  }\n');
    expect(exact).toMatch(/\{ _id: jobId, state: 'running', attempt: job\.attempt, 'lease\.expiresAt': \{ \$lte: now \} \}/);
    expect(exact).toMatch(/const exhausted = job\.attempt >= job\.maxAttempts;/);
  });

  it('a worker lease is liveness only: nothing in execution or the worker touches the draft claim', async () => {
    for (const file of [WORKER, EXECUTION, SCRIPT]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/releaseCanonicalDraftClaim|claimCanonicalDraft|handOffCanonicalDraft|canonicalDrafts\.|activeLineage/);
    }
    const execution = await src(EXECUTION);
    for (const fn of ['heartbeatSemanticEditExecution', 'releaseSemanticEditExecution', 'recordSemanticEditDisposition']) {
      expect(body(execution, `export async function ${fn}(`, '\n}\n')).toMatch(/'execution\.token': lease\.token/);
    }
    expect(body(execution, 'const runnable = ', '});')).toMatch(/\{ 'execution\.expiresAt': \{ \$lte: now \} \}/);
  });

  it('holds no customer identity, no latest lookup and no release authority', async () => {
    for (const file of [WORKER, EXECUTION, SCRIPT]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/@statxai\/customer-auth|cookie|session(Id|Token)|oidc|authorization/i);
      expect(code, file).not.toMatch(/'editable-site-model'|'site-export-snapshot'|EDITABLE_SITE_MODEL_ARTIFACT|SITE_EXPORT_SNAPSHOT_ARTIFACT|registry\.get\(|artifacts\.find|latest/i);
      expect(code, file).not.toMatch(/seekRelease|publishRelease|releasePublications|deploySite|recommendApproval|release-publication|phases\/(publish|release)|from '\.\.\/release\.js'/);
      for (const specifier of code.match(/from '[^']+'/g) ?? []) {
        expect(specifier, file).toMatch(/^from '(node:(crypto|os|path)|@statxai\/(state|job-engine|contracts|orchestrator)|\.\.\/canonical-draft\/authority\.js|\.\.\/job-lifecycle\/frontend-backend\.js|\.\/(apply|execution)\.js)'$/);
      }
    }
  });

  it('bounds concurrency, polls instead of spinning, and stops claiming on shutdown', async () => {
    const worker = await src(WORKER);
    expect(body(worker, 'async claimOne(): Promise<boolean> {', '\n  }\n')).toMatch(/if \(this\.stopping\.signal\.aborted \|\| this\.active\.size >= this\.limits\.concurrency\) return false;/);
    expect(body(worker, 'private async run(): Promise<void> {', '\n  }\n')).toMatch(/await abortableSleep\(this\.limits\.pollMs, this\.stopping\.signal\);/);
    expect(body(worker, 'async stop(graceMs = 30_000): Promise<void> {', '\n  }\n')).toMatch(/this\.stopping\.abort\(\);[\s\S]*controller\.abort\(\)/);
  });

  it('the customer app only submits and reads status: its routes are exactly authentication and the editor, and none runs the worker', async () => {
    const routes = (await productionFiles('apps/customer/app')).filter((f) => /route\.ts$|page\.tsx$/.test(f)).sort();
    expect(routes).toEqual([
      'apps/customer/app/api/auth/callback/route.ts',
      'apps/customer/app/api/auth/login/route.ts',
      'apps/customer/app/api/auth/logout/route.ts',
      'apps/customer/app/api/auth/me/route.ts',
      'apps/customer/app/api/projects/[projectId]/editor/route.ts',
      'apps/customer/app/api/projects/[projectId]/edits/[intentId]/route.ts',
      'apps/customer/app/api/projects/[projectId]/edits/route.ts',
      'apps/customer/app/api/projects/[projectId]/preview/[draftId]/[[...route]]/route.ts',
      'apps/customer/app/api/projects/route.ts',
      'apps/customer/app/page.tsx',
      'apps/customer/app/projects/[projectId]/editor/page.tsx',
      'apps/customer/app/projects/page.tsx',
    ]);
    for (const file of await productionFiles('packages/customer-editor/src')) {
      expect(await src(file), file).not.toMatch(/SemanticEditWorker|claimSemanticEditExecution|resumeSemanticEditIntent/);
    }
  });
});
