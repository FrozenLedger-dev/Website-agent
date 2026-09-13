/**
 * Terra's advisory test feedback, end to end through the real `frontend_backend`
 * handler.
 *
 * Real: the handler, the build phase, the model runtime, the bounded loop, the
 * tool gateway with both production adapters, and the test runner's
 * materialisation. Faked: the provider, the registry, and the compiler and
 * gates at the `@statxai/workspace` / `@statxai/gates` boundary.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { ArtifactRef, JobSpec } from '@statxai/contracts';
import { ModelRuntime, type ModelUsageEvent, type Provider, type ProviderRequest, type ProviderResponse } from '@statxai/agents';
import type { JobDocument } from '@statxai/state';
import { defaultTemplateRoot, type BuildResult } from '@statxai/workspace';
import type * as Workspace from '@statxai/workspace';
import type * as Gates from '@statxai/gates';
import { createTerraFrontendBackendHandler } from '../src/job-handlers/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import { ToolGateway, ToolPermissionDenied, type ToolEvidence } from '../src/tool-gateway/gateway.js';
import { createScaffoldFilesystemAdapter } from '../src/tool-gateway/filesystem.js';
import { createTestRunnerAdapter } from '../src/tool-gateway/test-runner.js';

const built: string[] = [];

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    buildSite: vi.fn(async (siteRoot: string): Promise<BuildResult> => {
      const page = await readFile(join(siteRoot, 'app', 'page.tsx'), 'utf8');
      built.push(page);
      const broken = page.includes('BROKEN');
      return {
        ok: !broken,
        durationMs: 1,
        output: broken ? "app/page.tsx(1,20): error TS2322: Type 'string' is not assignable to type 'number'." : 'compiled',
        outDir: join(siteRoot, 'out'),
      };
    }),
    readBuiltFiles: vi.fn(async () => [{ path: 'index.html', contents: '<html></html>' }]),
    readExportFiles: vi.fn(async () => []),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return { ...actual, runGates: vi.fn(() => ({ passed: true, findings: [], gatesRun: ['claims'] })) };
});

const PROJECT = 'proj_terra_test_feedback';
const profileRef: ArtifactRef = { name: 'business-profile', version: 1 };
const planRef: ArtifactRef = { name: 'site-plan', version: 1 };
const PROFILE = { businessName: 'Acme Joinery', services: [] };
const PLAN = { sitemap: { pages: [{ route: '/', title: 'Home', sections: [] }] }, brandSystem: { artDirection: 'd' }, acceptanceCriteria: [] };
const BROKEN = { files: [{ path: 'app/page.tsx', contents: 'const n: number = "BROKEN";' }], notes: 'broken' };
const FIXED = { files: [{ path: 'app/page.tsx', contents: 'export default function Home(){return null}' }], notes: 'fixed' };

let advisoryRoot: string;

beforeAll(async () => {
  advisoryRoot = await mkdtemp(join(tmpdir(), 'statxai-terra-test-feedback-'));
});

afterAll(async () => {
  if (advisoryRoot) await rm(advisoryRoot, { recursive: true, force: true });
});

beforeEach(() => {
  built.length = 0;
  vi.clearAllMocks();
});

const respond = (value: unknown): ProviderResponse => ({ text: JSON.stringify(value), model: 'fake', inputTokens: 1, outputTokens: 1, stopReason: 'complete' });
const test = (candidate: unknown) => ({ action: 'tool', tool: 'test_runner', input: { candidate }, output: null });
const read = (path: string) => ({ action: 'tool', tool: 'filesystem', input: { path }, output: null });
const final = (output: unknown) => ({ action: 'final', tool: null, input: null, output });

function terra(buildTurns: unknown[]) {
  const requests: ProviderRequest[] = [];
  const usage: ModelUsageEvent[] = [];
  let turn = 0;
  const provider: Provider = {
    name: 'fake',
    schemaDialect: 'strict',
    async complete(request) {
      requests.push(request);
      if (request.schemaName.startsWith('sol_route')) return respond({ action: 'one_shot', reason: 'single page', confidence: 0.9, workstreams: null });
      return respond(buildTurns[Math.min(turn++, buildTurns.length - 1)]);
    },
  };
  return { runtime: new ModelRuntime({ provider, onUsage: (e) => usage.push(e) }), requests, usage };
}

function job(allowedTools?: JobSpec['allowedTools']): JobDocument {
  const base = createFrontendBackendJobSpec({ projectId: PROJECT, businessProfileRef: profileRef, sitePlanRef: planRef });
  const spec = allowedTools ? { ...base, allowedTools } : base;
  return { _id: spec.jobId, projectId: PROJECT, role: 'frontend_backend', state: 'running', spec, attempt: 1 } as unknown as JobDocument;
}

function registry() {
  const put = vi.fn(async (_projectId: string, name: string) => ({ name, version: 1 }));
  return { put, registry: { resolve: async (_p: string, ref: ArtifactRef) => (ref.name === 'site-plan' ? PLAN : PROFILE), put } as never };
}

function productionGateway(evidence: ToolEvidence[]) {
  return new ToolGateway({
    adapters: [
      createScaffoldFilesystemAdapter({ root: defaultTemplateRoot() }),
      createTestRunnerAdapter({ profile: PROFILE as never, plan: PLAN as never, workspacesRoot: advisoryRoot }),
    ],
    onEvidence: (e) => evidence.push(e),
  });
}

const signal = () => new AbortController().signal;

describe('the production grant lets Terra test before answering', () => {
  it('filesystem → failed test → corrected test → final: the corrected BuildOutput is staged, nothing more', async () => {
    const { runtime, requests, usage } = terra([read('components/ui/button.tsx'), test(BROKEN), test(FIXED), final(FIXED)]);
    const { registry: reg, put } = registry();
    const evidence: ToolEvidence[] = [];
    const claimed = job();
    const before = structuredClone(claimed);

    const result = await createTerraFrontendBackendHandler({ registry: reg, model: runtime, tools: productionGateway(evidence) })(claimed, { signal: signal() });

    // Two advisory sandbox measurements, each of the exact candidate proposed.
    expect(built).toEqual([BROKEN.files[0]!.contents, FIXED.files[0]!.contents]);
    const builds = requests.filter((r) => r.schemaName.startsWith('terra_build'));
    expect(builds[2]!.prompt).toContain('error TS2322');
    expect(builds[3]!.prompt).toContain('"status":"passed"');

    // The handler's result is the staged BuildOutput only.
    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0] as unknown[])[2]).toMatchObject({ files: FIXED.files });
    expect(result).toEqual({ outputs: [expect.objectContaining({ version: 1 })] });

    // Four Terra turns and one Sol routing call create usage; the tools create none.
    expect(usage.filter((u) => u.skill === 'terra-build')).toHaveLength(4);
    expect(usage).toHaveLength(5);
    expect(evidence.map((e) => [e.tool, e.outcome])).toEqual([['filesystem', 'succeeded'], ['test_runner', 'succeeded'], ['test_runner', 'succeeded']]);
    expect(evidence.filter((e) => e.tool === 'test_runner').map((e) => e.detail.status)).toEqual(['failed', 'passed']);

    // The claimed job document is untouched, and every advisory workspace is gone.
    expect(claimed).toEqual(before);
    expect(await readdir(advisoryRoot)).toEqual([]);
  });

  it('an immediate BuildOutput uses zero tools', async () => {
    const { runtime, usage } = terra([final(FIXED)]);
    const evidence: ToolEvidence[] = [];
    await createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime, tools: productionGateway(evidence) })(job(), { signal: signal() });
    expect(evidence).toEqual([]);
    expect(built).toEqual([]);
    expect(usage.filter((u) => u.skill === 'terra-build')).toHaveLength(1);
  });

  it('the default gateway the handler builds for a claimed job registers exactly filesystem and test_runner', async () => {
    const { runtime } = terra([test(FIXED), final(FIXED)]);
    await createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime, advisoryWorkspacesRoot: advisoryRoot })(job(), { signal: signal() });
    expect(built).toEqual([FIXED.files[0]!.contents]);
    expect(await readdir(advisoryRoot)).toEqual([]);
  });

  it('Sol routing is offered no test_runner', async () => {
    const { runtime, requests } = terra([final(FIXED)]);
    await createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime, tools: productionGateway([]) })(job(), { signal: signal() });
    const route = requests.find((r) => r.schemaName.startsWith('sol_route'))!;
    expect(route.prompt).not.toMatch(/TESTING A CANDIDATE|test_runner/);
  });
});

describe('the claimed job’s allowedTools decides', () => {
  it('a job granted only filesystem is never offered testing, and a test request is denied before any build', async () => {
    const offered = terra([final(FIXED)]);
    await createTerraFrontendBackendHandler({ registry: registry().registry, model: offered.runtime, tools: productionGateway([]) })(job(['filesystem']), { signal: signal() });
    expect(offered.requests.find((r) => r.schemaName.startsWith('terra_build'))!.prompt).not.toContain('TESTING A CANDIDATE');

    const { runtime } = terra([test(FIXED), final(FIXED)]);
    const evidence: ToolEvidence[] = [];
    await expect(
      createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime, tools: productionGateway(evidence) })(job(['filesystem']), { signal: signal() }),
    ).rejects.toBeInstanceOf(ToolPermissionDenied);
    expect(built).toEqual([]);
    expect(evidence.map((e) => [e.tool, e.outcome])).toEqual([['test_runner', 'denied']]);
  });

  it('a lease lost during an advisory test stops the build: no further turn, no staging', async () => {
    const controller = new AbortController();
    const { runtime, requests } = terra([test(FIXED), final(FIXED)]);
    const { registry: reg, put } = registry();
    const workspace = await import('@statxai/workspace');
    vi.mocked(workspace.buildSite).mockImplementationOnce(async () => {
      controller.abort(new Error('heartbeat lost'));
      throw new Error('heartbeat lost');
    });

    await expect(
      createTerraFrontendBackendHandler({ registry: reg, model: runtime, tools: productionGateway([]) })(job(), { signal: controller.signal }),
    ).rejects.toThrow('heartbeat lost');
    expect(requests.filter((r) => r.schemaName.startsWith('terra_build'))).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(advisoryRoot)).toEqual([]);
  });
});
