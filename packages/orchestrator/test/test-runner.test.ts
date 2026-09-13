/**
 * The `test_runner` tool through the real gateway and the real adapter.
 *
 * Faked: only the compiler and gate runner, at the same `@statxai/workspace` /
 * `@statxai/gates` boundary the validator suites fake — so what is proven here
 * is the tool's contract (permission, strict input, result projection, bounds,
 * sanitization, evidence, cancellation, cleanup) and that a measurement goes
 * through `runDeterministicGates`. `test-runner.integration.test.ts` runs the
 * same adapter against the real sandbox.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildOutput, SitePlan, TestRunnerResult } from '@statxai/contracts';
import { SandboxUnavailable, contentHash, type BuildResult } from '@statxai/workspace';
import type * as Workspace from '@statxai/workspace';
import type * as Gates from '@statxai/gates';
import { FRONTEND_BACKEND_SUPPORTED_TOOLS } from '../src/job-handlers/frontend-backend.js';
import {
  ToolGateway,
  ToolInputInvalid,
  ToolPermissionDenied,
  type ToolCallContext,
  type ToolEvidence,
} from '../src/tool-gateway/gateway.js';
import {
  TEST_RUNNER_MAX_DIAGNOSTIC_CHARS,
  TEST_RUNNER_MAX_FINDINGS,
  TEST_RUNNER_MAX_MESSAGE_CHARS,
  TEST_RUNNER_MAX_RESULT_BYTES,
  createTestRunnerAdapter,
} from '../src/tool-gateway/test-runner.js';

const FAKE_SECRET = 'sk-test-runner-secret-7788aa';

let build: (siteRoot: string, options: { signal?: AbortSignal }) => Promise<BuildResult>;
let gates: { passed: boolean; findings: Gates.GateRun['findings']; gatesRun: string[] };
const builtFrom: string[] = [];
let concurrent = 0;
let maxConcurrent = 0;

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async (siteRoot: string, options: { signal?: AbortSignal } = {}) => {
      builtFrom.push(await readFile(join(siteRoot, 'app', 'page.tsx'), 'utf8').catch(() => '<none>'));
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        return await build(siteRoot, options);
      } finally {
        concurrent -= 1;
      }
    }),
    readBuiltFiles: vi.fn(async () => [{ path: 'index.html', contents: '<html></html>' }]),
    readExportFiles: vi.fn(async () => []),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return { ...actual, runGates: vi.fn(() => gates) };
});

const workspace = await import('@statxai/workspace');

let root: string;
const profile = { businessName: 'Acme Joinery' } as never;
const plan = { sitemap: { pages: [] } } as unknown as SitePlan;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'statxai-test-runner-'));
  process.env.OPENAI_API_KEY = FAKE_SECRET;
});

afterAll(async () => {
  delete process.env.OPENAI_API_KEY;
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  builtFrom.length = 0;
  concurrent = 0;
  maxConcurrent = 0;
  build = async (siteRoot) => ({ ok: true, durationMs: 1, output: 'compiled', outDir: join(siteRoot, 'out') });
  gates = { passed: true, findings: [], gatesRun: ['claims'] };
});

afterEach(() => {
  vi.clearAllMocks();
});

const CANDIDATE: BuildOutput = { files: [{ path: 'app/page.tsx', contents: 'export default function Home(){return null}' }], notes: 'n' };

function context(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    projectId: 'proj_test_runner',
    jobId: 'job_test_runner',
    skill: 'terra-build',
    role: 'frontend_backend',
    allowedTools: ['filesystem', 'test_runner'],
    supportedTools: FRONTEND_BACKEND_SUPPORTED_TOOLS,
    ...overrides,
  };
}

function gateway(evidence: ToolEvidence[] = []) {
  const workspacesRoot = join(root, `advisory-${Math.random().toString(36).slice(2)}`);
  const tools = new ToolGateway({ adapters: [createTestRunnerAdapter({ profile, plan, workspacesRoot })], onEvidence: (e) => evidence.push(e) });
  const run = (input: unknown, extra: { context?: Partial<ToolCallContext>; signal?: AbortSignal } = {}) =>
    tools.execute<TestRunnerResult>({
      tool: 'test_runner',
      input,
      context: context(extra.context),
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
  const leftovers = () => readdir(workspacesRoot).catch(() => []);
  return { run, leftovers, workspacesRoot };
}

describe('permission', () => {
  it('a job whose allowedTools omits test_runner is denied before anything is built', async () => {
    const { run } = gateway();
    await expect(run({ candidate: CANDIDATE }, { context: { allowedTools: ['filesystem'] } })).rejects.toBeInstanceOf(ToolPermissionDenied);
    expect(workspace.buildSite).not.toHaveBeenCalled();
  });

  it('a handler that does not support test_runner denies it despite the JobSpec', async () => {
    const { run } = gateway();
    await expect(run({ candidate: CANDIDATE }, { context: { supportedTools: ['filesystem'] } })).rejects.toBeInstanceOf(ToolPermissionDenied);
    expect(workspace.buildSite).not.toHaveBeenCalled();
  });
});

describe('strict input', () => {
  it.each([
    ['a malformed BuildOutput', { candidate: { files: [], notes: 'n' } }],
    ['no candidate', {}],
    ['a command', { candidate: CANDIDATE, command: ['pnpm', 'build'] }],
    ['a working directory', { candidate: CANDIDATE, cwd: '/' }],
    ['an environment', { candidate: CANDIDATE, env: { NODE_OPTIONS: '--require /tmp/x' } }],
    ['Docker options', { candidate: CANDIDATE, docker: { network: 'host', mounts: ['/:/host'] } }],
    ['resource limits', { candidate: CANDIDATE, limits: { timeoutMs: 1e9 } }],
  ])('refuses %s before any sandbox run', async (_label, input) => {
    const { run, leftovers } = gateway();
    await expect(run(input)).rejects.toBeInstanceOf(ToolInputInvalid);
    expect(workspace.buildSite).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual([]);
  });
});

describe('measurement', () => {
  it('a valid candidate is materialised onto the scaffold, measured through the sandboxed build, and passes', async () => {
    const { run, leftovers } = gateway();

    const result = await run({ candidate: CANDIDATE });

    expect(result).toEqual({
      tool: 'test_runner',
      status: 'passed',
      passed: true,
      candidateHash: contentHash(CANDIDATE),
      compile: { ok: true, diagnostics: '' },
      findings: [],
      findingCount: 0,
      refusedPaths: [],
      truncated: false,
    });
    expect(builtFrom).toEqual([CANDIDATE.files[0]!.contents]);
    expect(await leftovers()).toEqual([]);
  });

  it('a compile failure is a successful tool call reporting passed:false, with sanitized, bounded diagnostics', async () => {
    const evidence: ToolEvidence[] = [];
    const { run, workspacesRoot } = gateway(evidence);
    build = async (siteRoot) => ({
      ok: false,
      durationMs: 1,
      output: `${'noise\n'.repeat(2000)}${siteRoot}/app/page.tsx(2,9): error TS2322: Type 'string' is not assignable to type 'number'.\nkey=${FAKE_SECRET}\nFailed to type check.`,
      outDir: join(siteRoot, 'out'),
    });

    const result = await run({ candidate: CANDIDATE });

    expect(result.status).toBe('failed');
    expect(result.passed).toBe(false);
    expect(result.compile?.ok).toBe(false);
    expect(result.compile?.diagnostics).toContain('error TS2322');
    expect(result.compile!.diagnostics.length).toBeLessThanOrEqual(TEST_RUNNER_MAX_DIAGNOSTIC_CHARS);
    expect(result.compile?.diagnostics).not.toContain(FAKE_SECRET);
    expect(result.compile?.diagnostics).not.toContain(workspacesRoot);
    expect(result.compile?.diagnostics).not.toContain(tmpdir() + '/');
    expect(evidence.map((e) => e.outcome)).toEqual(['succeeded']);
  });

  it('gate findings come back structured, most severe first, bounded in count, length and size', async () => {
    const { run } = gateway();
    gates = {
      passed: false,
      gatesRun: ['claims', 'a11y'],
      findings: [
        ...Array.from({ length: 40 }, (_, i) => ({ gate: 'a11y', severity: 'P3' as const, location: `index.html#${i}`, message: `minor ${i}`, acceptanceTest: 't' })),
        { gate: 'claims', severity: 'P0' as const, location: `${root}/out/index.html`, message: `Unsupported claim ${'x'.repeat(2000)}`, acceptanceTest: 't' },
      ],
    };

    const result = await run({ candidate: CANDIDATE });

    expect(result.status).toBe('failed');
    expect(result.compile).toEqual({ ok: true, diagnostics: '' });
    expect(result.findingCount).toBe(41);
    expect(result.findings.length).toBeLessThanOrEqual(TEST_RUNNER_MAX_FINDINGS);
    expect(result.truncated).toBe(true);
    expect(result.findings[0]).toMatchObject({ gate: 'claims', severity: 'P0' });
    expect(result.findings[0]!.message.length).toBeLessThanOrEqual(TEST_RUNNER_MAX_MESSAGE_CHARS);
    expect(result.findings[0]!.location).not.toContain(root);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(TEST_RUNNER_MAX_RESULT_BYTES);
    expect(result.findings[0]).not.toHaveProperty('acceptanceTest');
  });

  it('a build that hit the time limit is reported distinctly as timed_out', async () => {
    const { run } = gateway();
    build = async (siteRoot) => ({ ok: false, durationMs: 1, output: 'Build terminated: it exceeded the 600s time limit.', outDir: join(siteRoot, 'out'), limit: 'time' });

    const result = await run({ candidate: CANDIDATE });
    expect(result).toMatchObject({ status: 'timed_out', passed: false, compile: { ok: false } });
  });

  it('an unavailable sandbox is reported distinctly, not as a candidate failure or a crash', async () => {
    const evidence: ToolEvidence[] = [];
    const { run, leftovers } = gateway(evidence);
    build = async () => {
      throw new SandboxUnavailable('Docker is unavailable');
    };

    const result = await run({ candidate: CANDIDATE });

    expect(result).toMatchObject({ status: 'unavailable', passed: false, compile: null, findings: [] });
    expect(evidence[0]).toMatchObject({ outcome: 'succeeded', detail: { status: 'unavailable' } });
    expect(await leftovers()).toEqual([]);
  });

  it('any other infrastructure failure is a failed tool call, never a candidate verdict', async () => {
    const evidence: ToolEvidence[] = [];
    const { run, leftovers } = gateway(evidence);
    build = async () => {
      throw new Error('disk full');
    };

    await expect(run({ candidate: CANDIDATE })).rejects.toThrow('disk full');
    expect(evidence[0]).toMatchObject({ outcome: 'failed' });
    expect(await leftovers()).toEqual([]);
  });

  it('a candidate replacing the dependency manifest or config is refused without building', async () => {
    const { run, leftovers } = gateway();

    const result = await run({
      candidate: { files: [...CANDIDATE.files, { path: 'package.json', contents: '{}' }, { path: 'next.config.ts', contents: 'x' }], notes: 'n' },
    });

    expect(result).toMatchObject({ status: 'refused', passed: false, compile: null, refusedPaths: ['package.json', 'next.config.ts'] });
    expect(workspace.buildSite).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual([]);
  });

  it('cancellation reaches the sandboxed build, runs no gates after it, and cleans up', async () => {
    const evidence: ToolEvidence[] = [];
    const { run, leftovers } = gateway(evidence);
    const gatesModule = await import('@statxai/gates');
    const controller = new AbortController();
    const reason = new Error('lease lost');
    let signalSeen: AbortSignal | undefined;
    build = async (_siteRoot, options) => {
      signalSeen = options.signal;
      controller.abort(reason);
      throw reason;
    };

    await expect(run({ candidate: CANDIDATE }, { signal: controller.signal })).rejects.toBe(reason);

    expect(signalSeen).toBe(controller.signal);
    expect(gatesModule.runGates).not.toHaveBeenCalled();
    expect(evidence[0]).toMatchObject({ outcome: 'cancelled' });
    expect(await leftovers()).toEqual([]);
  });

  it('every test gets its own disposable workspace, and they run one at a time', async () => {
    const { run, leftovers } = gateway();
    const roots: string[] = [];
    build = async (siteRoot) => {
      roots.push(siteRoot);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, durationMs: 1, output: '', outDir: join(siteRoot, 'out') };
    };

    const other = { files: [{ path: 'app/page.tsx', contents: 'other' }], notes: 'other' };
    await Promise.all([run({ candidate: CANDIDATE }), run({ candidate: other })]);

    expect(new Set(roots).size).toBe(2);
    expect(maxConcurrent).toBe(1);
    expect(await leftovers()).toEqual([]);
  });
});

describe('evidence', () => {
  it('records safe metadata only — identity, size and verdict, never the candidate source', async () => {
    const evidence: ToolEvidence[] = [];
    const { run } = gateway(evidence);
    const secretSource = { files: [{ path: 'app/page.tsx', contents: 'const marker = "SOURCE-TEXT-MUST-NOT-PERSIST";' }], notes: 'n' };

    await run({ candidate: secretSource });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ projectId: 'proj_test_runner', jobId: 'job_test_runner', skill: 'terra-build', tool: 'test_runner', outcome: 'succeeded' });
    expect(Object.keys(evidence[0]!.detail).sort()).toEqual(['candidateHash', 'files', 'findings', 'passed', 'status']);
    expect(evidence[0]!.detail).toMatchObject({ candidateHash: contentHash(secretSource), files: '1', passed: 'true', status: 'passed', findings: '0' });
    expect(JSON.stringify(evidence)).not.toContain('SOURCE-TEXT-MUST-NOT-PERSIST');
  });
});
