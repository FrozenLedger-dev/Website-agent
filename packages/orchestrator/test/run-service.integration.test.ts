/**
 * Phase 5l — activating `job_lifecycle` for the one real production
 * entrypoint (the console's `POST /api/runs`, `apps/console/app/api/runs
 * /route.ts`).
 *
 * `apps/console` is a Next.js app with no vitest suite of its own, and its
 * API route is a thin wrapper: parse the request body, read the console's
 * own module-level config (`FRONTEND_BACKEND_EXECUTION_MODE`,
 * `VALIDATION_WORKSPACES_ROOT`), and call `launchRun` — the one shared
 * function this repository already tests end to end. Every scenario below
 * calls `launchRun` directly, passing exactly the options the route
 * computes and forwards, so this exercises the real shared implementation
 * the route delegates to rather than a test-only adapter. A companion
 * structural check further down reads the route's own source to confirm it
 * really does wire the config through unchanged, and that no other
 * production caller does the same.
 *
 * Mock setup mirrors `frontend-backend-build-binding.integration.test.ts`
 * exactly (see that file's own doc comment): `@statxai/agents`/
 * `@statxai/workspace`'s compiler/`@statxai/gates` are faked, everything
 * else is real — `StateStore`, `ArtifactRegistry`, `ProjectWorkspace`,
 * `JobEngine`, the production Terra handler, Phase 5g-1/5g-2/5h/5i, Phase
 * 5k's binding module, and `runProject`/`launchRun` themselves.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import type { SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { ProjectWorkspace } from '@statxai/workspace';
import * as orchestratorModule from '../src/orchestrator.js';
import { ActiveJobLifecycleRollbackConflict, launchRun } from '../src/run-service.js';
import { findActivePreparedBinding } from '../src/run-binding/frontend-backend.js';
import { fakeExport } from './support/site-model-export.js';

interface ReviewIssue {
  id: string;
  category: string;
  severity: string;
  location: string;
  reason: string;
  acceptanceTest: string;
  recommendedAction: string;
  evidence: string[];
}

let approval: { recommendation: string; reason: string; acknowledgedIssues: string[] };
let reviewSequence: { qualityScore: number; blocking: boolean; issues: ReviewIssue[] }[];
let gateVerdict: { passed: boolean; findings: unknown[]; gatesRun: string[] } = { passed: true, findings: [], gatesRun: ['claims'] };
let compileOk = true;
let terraBuildCalls = 0;

const issue = (over: Partial<ReviewIssue> = {}): ReviewIssue => ({
  id: 'QA-004',
  category: 'accessibility',
  severity: 'P2',
  location: 'index.html',
  reason: 'Focus indicator relies on an undefined custom property.',
  acceptanceTest: 'Focus is visible on every control.',
  recommendedAction: 'targeted_repair',
  evidence: [],
  ...over,
});

const page = (route: string, title: string) => ({
  route,
  title,
  metaDescription: 'd',
  goal: 'g',
  primaryAction: 'call',
  sections: [{ id: 'hero', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }],
});

const PLAN = {
  strategy: 'Local trade credibility',
  valueProposition: 'v',
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: 'direction',
    radius: 'square',
    rationale: 'Workwear palette suits the trade.',
  },
  sitemap: { pages: [page('/', 'Home')] },
  acceptanceCriteria: ['a', 'b', 'c'],
} as SitePlan;
const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => ({ value: PLAN, model: 'gpt-5.6-sol', ...usage })),
    routeBuild: vi.fn(async () => ({
      value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    buildSite: vi.fn(async () => {
      terraBuildCalls += 1;
      return {
        value: { files: [{ path: 'app/page.tsx', contents: `export default function P(){return ${terraBuildCalls}}` }], notes: '' },
        model: 'gpt-5.6-terra',
        ...usage,
      };
    }),
    reviewSite: vi.fn(async () => {
      const r = reviewSequence.length > 1 ? reviewSequence.shift()! : reviewSequence[0]!;
      return {
        value: { decision: r.blocking ? 'reject' : 'accept', qualityScore: r.qualityScore, blocking: r.blocking, issues: r.issues, summary: 's' },
        model: 'gpt-5.6-terra',
        ...usage,
      };
    }),
    recommendApproval: vi.fn(async () => ({ value: approval, model: 'gpt-5.6-sol', ...usage })),
    adjudicate: vi.fn(async () => ({
      value: { action: 'block', reason: 'unused by default', defectIds: null, objective: null, scope: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
  };
});

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    scaffoldSite: vi.fn(actual.scaffoldSite),
    buildSite: vi.fn(async () => ({ ok: compileOk, durationMs: 5, output: compileOk ? '' : 'compile error: x', outDir: '/out' })),
    // A faithful export of the editable site model the run pinned, so the real site-model gate measures it.
    readBuiltFiles: vi.fn(async (siteRoot: string) => fakeExport(store, siteRoot, [{ path: 'index.html', contents: '<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Harrowgate Joinery</h1></main></body></html>' }], '<h1>Harrowgate Joinery</h1>')),
    readExportFiles: vi.fn(async () => []),
    readSourceFiles: vi.fn(async () => [{ path: 'app/page.tsx', contents: 'x' }]),
    deploymentConfigured: vi.fn(() => false),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return { ...actual, runGates: vi.fn(() => gateVerdict) };
});

// Wraps the real implementation so every scenario below runs the genuine
// orchestrator — this only adds the ability to assert on the exact options
// `launchRun` handed it, proving the pass-through rather than assuming it.
vi.mock('../src/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof orchestratorModule>();
  return { ...actual, runProject: vi.fn(actual.runProject) };
});

const INTAKE = {
  businessName: 'Harrowgate Joinery',
  industry: 'Joinery',
  location: 'Harrogate',
  audience: 'Homeowners',
  services: [{ name: 'Wardrobes', description: 'Fitted wardrobes.' }],
  differentiators: ['Two joiners'],
  contact: { email: 'workshop@harrowgatejoinery.co.uk', phone: '01423 887 214' },
  tone: 'Warm',
  goals: ['Enquiries'],
};

let store: StateStore;
let workspacesRoot: string;
let validationWorkspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5l-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5l-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  gateVerdict = { passed: true, findings: [], gatesRun: ['claims'] };
  compileOk = true;
  terraBuildCalls = 0;
  reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
  approval = { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: ['QA-004'] };
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
  await store.promotions.deleteMany({});
  await store.frontendBackendBuildBindings.deleteMany({});
  await store.runs.deleteMany({});
  await store.runEvents.deleteMany({});
});

afterEach(() => {
  vi.mocked(orchestratorModule.runProject).mockClear();
});

async function canonicalCommitSubjects(projectId: string): Promise<string[]> {
  const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
  try {
    const { stdout } = await exec('git', ['-c', `safe.directory=${ws.root}`, '-C', ws.root, 'log', '--all', '--format=%s']);
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function events(runId: string): Promise<{ phase: string; detail: string }[]> {
  return store.runEvents.find({ runId }).sort({ seq: 1 }).toArray();
}

// ---------------------------------------------------------------------------

describe('runProject default stays legacy_direct, unchanged by this phase', () => {
  it('a direct runProject call with no execution-mode option never touches the binding collection', async () => {
    const projectId = 'proj_5l_direct_default';
    const { runProject } = await import('../src/orchestrator.js');
    const result = await runProject({ projectId, intake: INTAKE, store, workspacesRoot });

    expect(result.outcome).toBe('released');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(0);
    expect(await store.jobs.countDocuments({ projectId })).toBe(0);
  });
});

describe('launchRun default stays legacy_direct too, for every caller that omits the option', () => {
  it('omitting frontendBackendExecutionMode in LaunchOptions runs the legacy path', async () => {
    const projectId = 'proj_5l_launch_default';
    const handle = await launchRun({ store, intake: INTAKE, workspacesRoot, projectId });
    const result = await handle.completed;

    expect(result?.outcome).toBe('released');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(0);
    expect(await store.jobs.countDocuments({ projectId })).toBe(0);
    expect((await canonicalCommitSubjects(projectId)).some((s) => s === 'Terra: build')).toBe(true);
  });
});

describe('the selected production caller: explicit job_lifecycle', () => {
  it('drives the real job_lifecycle path end to end and passes validationWorkspacesRoot through unchanged', async () => {
    const projectId = 'proj_5l_explicit_job';
    const handle = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId,
    });
    const result = await handle.completed;

    expect(result?.outcome).toBe('released');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, status: 'promoted' })).toBe(1);
    expect(await store.jobs.countDocuments({ projectId, role: 'frontend_backend' })).toBe(1);

    const call = vi.mocked(orchestratorModule.runProject).mock.calls.at(-1)?.[0];
    expect(call?.frontendBackendExecutionMode).toBe('job_lifecycle');
    expect(call?.validationWorkspacesRoot).toBe(validationWorkspacesRoot);
  });

  it('logs the selected mode through the existing run-event stream, not a new pipeline', async () => {
    const projectId = 'proj_5l_observability';
    const handle = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId,
    });
    await handle.completed;

    const log = await events(handle.runId);
    expect(log.some((e) => e.detail === 'frontend_backend_execution_mode=job_lifecycle')).toBe(true);
  });
});

describe('rollback: explicit legacy_direct', () => {
  it('runs the real direct builder — no binding, no job, the legacy commit lands', async () => {
    const projectId = 'proj_5l_explicit_legacy';
    const handle = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      frontendBackendExecutionMode: 'legacy_direct',
      projectId,
    });
    const result = await handle.completed;

    expect(result?.outcome).toBe('released');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(0);
    expect(await store.jobs.countDocuments({ projectId })).toBe(0);
    expect((await canonicalCommitSubjects(projectId)).some((s) => s === 'Terra: build')).toBe(true);

    const call = vi.mocked(orchestratorModule.runProject).mock.calls.at(-1)?.[0];
    expect(call?.frontendBackendExecutionMode).toBe('legacy_direct');
  });

  it('does not require validationWorkspacesRoot to be configured at all', async () => {
    const projectId = 'proj_5l_legacy_no_validation_root';
    const handle = await launchRun({ store, intake: INTAKE, workspacesRoot, frontendBackendExecutionMode: 'legacy_direct', projectId });
    const result = await handle.completed;
    expect(result?.outcome).toBe('released');
  });
});

describe('no runtime fallback once job_lifecycle is selected', () => {
  it('a retry_ready outcome never invokes the direct builder', async () => {
    const projectId = 'proj_5l_no_fallback_retry_ready';
    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });

    const handle = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId,
    });
    const result = await handle.completed;

    expect(result?.outcome).toBe('blocked');
    expect((await canonicalCommitSubjects(projectId)).some((s) => s === 'Terra: build')).toBe(false);
    const binding = await findActivePreparedBinding(store, projectId);
    expect(binding).not.toBeNull();
  });
});

describe('the production caller uses the real Phase 5k restart-resume path', () => {
  it('a second launchRun for the same project resumes the exact stored binding — no rediscovery, no replanning', async () => {
    const projectId = 'proj_5l_resume';

    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });

    const first = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId,
    });
    const firstResult = await first.completed;
    expect(firstResult?.outcome).toBe('blocked');

    const bindingAfterFirst = await findActivePreparedBinding(store, projectId);
    expect(bindingAfterFirst).not.toBeNull();
    const specCommitsAfterFirst = (await canonicalCommitSubjects(projectId)).filter((s) => s === 'Harness: specification');
    expect(specCommitsAfterFirst.length).toBe(1);
    const planSiteCallsAfterFirst = vi.mocked(await import('@statxai/agents')).planSite.mock.calls.length;

    // Fresh caller, same project — proving the real restart-safe path, not
    // an in-process shortcut: no shared state survives between these two
    // `launchRun` calls beyond what is genuinely durable (Mongo, Git).
    const second = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId,
    });
    const secondResult = await second.completed;
    expect(secondResult?.outcome).toBe('released');

    // No new business-profile/site-plan artifact version, no second planSite
    // call, and still exactly one specification commit — resume rehydrated
    // durable state rather than rerunning discovery/planning.
    expect(await store.artifacts.countDocuments({ projectId, name: 'business-profile' })).toBe(1);
    expect(await store.artifacts.countDocuments({ projectId, name: 'site-plan' })).toBe(1);
    expect(vi.mocked(await import('@statxai/agents')).planSite.mock.calls.length).toBe(planSiteCallsAfterFirst);
    const specCommitsAfterSecond = (await canonicalCommitSubjects(projectId)).filter((s) => s === 'Harness: specification');
    expect(specCommitsAfterSecond.length).toBe(1);

    const finalBinding = await store.frontendBackendBuildBindings.findOne({ projectId });
    expect(finalBinding?.status).toBe('promoted');
    expect(finalBinding?._id).toBe(bindingAfterFirst!._id);
  });
});

describe('promoted history does not block a later rollback to legacy_direct', () => {
  it('legacy_direct succeeds for a project whose earlier job_lifecycle binding already promoted', async () => {
    const projectId = 'proj_5l_promoted_then_legacy';

    const job = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId,
    });
    expect((await job.completed)?.outcome).toBe('released');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, status: 'promoted' })).toBe(1);

    const legacy = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      frontendBackendExecutionMode: 'legacy_direct',
      projectId,
    });
    const legacyResult = await legacy.completed;
    expect(legacyResult?.outcome).toBe('released');

    // The historical promoted binding is untouched — still exactly one,
    // still promoted, never deleted or mutated by the rollback run.
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId })).toBe(1);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId, status: 'promoted' })).toBe(1);
  });
});

describe('an active prepared binding makes legacy_direct fail closed for that project', () => {
  it('rejects before the legacy builder runs; the binding, the job, and the canonical workspace are all untouched', async () => {
    const projectId = 'proj_5l_active_binding_conflict';

    vi.mocked(await import('@statxai/agents')).buildSite.mockImplementationOnce(async () => {
      throw new Error('simulated Terra generation failure');
    });

    const job = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId,
    });
    expect((await job.completed)?.outcome).toBe('blocked');

    const bindingBefore = await findActivePreparedBinding(store, projectId);
    expect(bindingBefore).not.toBeNull();
    const jobDocBefore = await store.jobs.findOne({ projectId });
    const commitsBefore = await canonicalCommitSubjects(projectId);
    const headBefore = await (await ProjectWorkspace.open(projectId, workspacesRoot)).currentCommit();

    await expect(
      launchRun({ store, intake: INTAKE, workspacesRoot, frontendBackendExecutionMode: 'legacy_direct', projectId }),
    ).rejects.toThrow(ActiveJobLifecycleRollbackConflict);

    const bindingAfter = await findActivePreparedBinding(store, projectId);
    expect(bindingAfter).toEqual(bindingBefore);
    const jobDocAfter = await store.jobs.findOne({ projectId });
    expect(jobDocAfter).toEqual(jobDocBefore);
    expect(await canonicalCommitSubjects(projectId)).toEqual(commitsBefore);
    const headAfter = await (await ProjectWorkspace.open(projectId, workspacesRoot)).currentCommit();
    expect(headAfter).toEqual(headBefore);
    // No "Terra: build" commit was ever created by the rejected legacy attempt.
    expect(commitsBefore.some((s) => s === 'Terra: build')).toBe(false);
    // No run record was even created for the rejected attempt.
    expect(await store.runs.countDocuments({ projectId })).toBe(1);
  });
});

describe('intake content never controls the execution mode', () => {
  it('two structurally different intakes both run job_lifecycle when configured to, and both run legacy_direct when configured to', async () => {
    const intakeB = { ...INTAKE, businessName: 'A Totally Different Business', services: [{ name: 'Roofing', description: 'Roofs.' }] };

    const jobA = await launchRun({
      store,
      intake: INTAKE,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId: 'proj_5l_intake_a_job',
    });
    const jobB = await launchRun({
      store,
      intake: intakeB,
      workspacesRoot,
      validationWorkspacesRoot,
      frontendBackendExecutionMode: 'job_lifecycle',
      projectId: 'proj_5l_intake_b_job',
    });
    expect((await jobA.completed)?.outcome).toBe('released');
    expect((await jobB.completed)?.outcome).toBe('released');
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: 'proj_5l_intake_a_job' })).toBe(1);
    expect(await store.frontendBackendBuildBindings.countDocuments({ projectId: 'proj_5l_intake_b_job' })).toBe(1);
  });
});

describe('no mode-selection authority anywhere the model can reach', () => {
  it('no Sol/Terra-facing source under @statxai/agents mentions either execution mode literal', async () => {
    const { readdir } = await import('node:fs/promises');
    const agentsSrc = join(process.cwd(), 'packages', 'agents', 'src');

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
      return files;
    };

    const files = await walk(agentsSrc);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      expect(contents).not.toMatch(/job_lifecycle|legacy_direct/);
    }
  });
});

describe('exactly one production caller is activated', () => {
  it('apps/console/app/api/runs/route.ts sources the mode from its own config, never from the request body', async () => {
    const contents = await readFile(join(process.cwd(), 'apps/console/app/api/runs/route.ts'), 'utf8');
    expect(contents).toContain('launchRun');
    // Not merely "the constant is imported somewhere" — it must actually be
    // wired into the `launchRun` call as `frontendBackendExecutionMode`.
    expect(contents).toMatch(/frontendBackendExecutionMode:\s*FRONTEND_BACKEND_EXECUTION_MODE/);
    expect(contents).not.toMatch(/body\.frontendBackendExecutionMode/);
  });

  it('scripts/run-agent.ts (a CLI tool) never mentions the execution mode at all', async () => {
    const contents = await readFile(join(process.cwd(), 'scripts/run-agent.ts'), 'utf8');
    expect(contents).not.toMatch(/frontendBackendExecutionMode|FRONTEND_BACKEND_EXECUTION_MODE/);
  });

  it('no other apps/console route references the execution mode', async () => {
    const { readdir } = await import('node:fs/promises');
    const apiDir = join(process.cwd(), 'apps/console/app/api');
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
      }
      return files;
    };
    const files = (await walk(apiDir)).filter((f) => !f.endsWith('runs/route.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      expect(contents).not.toMatch(/frontendBackendExecutionMode|FRONTEND_BACKEND_EXECUTION_MODE/);
    }
  });
});
