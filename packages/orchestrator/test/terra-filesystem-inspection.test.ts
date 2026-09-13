/**
 * Terra read-only scaffold inspection, end to end through the real
 * `frontend_backend` handler.
 *
 * Real: the handler, the build phase, the model runtime, the bounded loop, the
 * tool gateway and the scaffold filesystem adapter reading `templates/site`.
 * Faked: only the provider and the registry — so what is proven is that a
 * claimed job's own `allowedTools` is what decides, and that the gateway is the
 * only way a read happens.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { ArtifactRef, JobSpec } from '@statxai/contracts';
import { ModelRuntime, type Provider, type ProviderRequest, type ProviderResponse } from '@statxai/agents';
import type { JobDocument } from '@statxai/state';
import { defaultTemplateRoot } from '@statxai/workspace';
import { createTerraFrontendBackendHandler } from '../src/job-handlers/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import { ToolGateway, ToolPermissionDenied, type ToolAdapter, type ToolEvidence } from '../src/tool-gateway/gateway.js';
import { FilesystemPathRefused, createScaffoldFilesystemAdapter } from '../src/tool-gateway/filesystem.js';

const PROJECT = 'proj_terra_inspect';
const profileRef: ArtifactRef = { name: 'business-profile', version: 1 };
const planRef: ArtifactRef = { name: 'site-plan', version: 1 };
const PROFILE = { businessName: 'Acme Joinery', services: [] };
const PLAN = {
  strategy: 's',
  valueProposition: 'v',
  brandSystem: {
    palette: { background: '#fff', surface: '#fff', text: '#111', muted: '#ccc', accent: '#0a0', accentText: '#fff', border: '#ddd' },
    typography: { headingFamily: 'Inter', bodyFamily: 'Inter', baseSize: '16px', scale: '1.2' },
    artDirection: 'd',
    radius: 'square',
    rationale: 'r',
  },
  sitemap: { pages: [{ route: '/', title: 'Home', metaDescription: 'd', goal: 'g', primaryAction: 'call', sections: [{ id: 'hero', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }] }] },
  acceptanceCriteria: ['a', 'b', 'c'],
};
const FILES = [{ path: 'app/page.tsx', contents: 'export default function Home(){return null}' }];

const respond = (value: unknown, model = 'fake'): ProviderResponse => ({
  text: JSON.stringify(value), model, inputTokens: 1, outputTokens: 1, stopReason: 'complete',
});

/** A provider that routes one-shot, then plays Terra's scripted build turns in order. */
function terra(buildTurns: unknown[]) {
  const requests: ProviderRequest[] = [];
  let turn = 0;
  const provider: Provider = {
    name: 'fake',
    schemaDialect: 'strict',
    async complete(request) {
      requests.push(request);
      if (request.schemaName.startsWith('sol_route')) {
        return respond({ action: 'one_shot', reason: 'single page', confidence: 0.9, workstreams: null });
      }
      return respond(buildTurns[Math.min(turn++, buildTurns.length - 1)]);
    },
  };
  return { runtime: new ModelRuntime({ provider }), requests };
}

const read = (path: string, tool = 'filesystem', extra: Record<string, unknown> = {}) => ({ action: 'tool', tool, input: { path }, output: null, ...extra });
const final = () => ({ action: 'final', tool: null, input: null, output: { files: FILES, notes: 'n' } });

function job(allowedTools: JobSpec['allowedTools']): JobDocument {
  const spec = { ...createFrontendBackendJobSpec({ projectId: PROJECT, businessProfileRef: profileRef, sitePlanRef: planRef }), allowedTools };
  return { _id: spec.jobId, projectId: PROJECT, role: 'frontend_backend', spec, attempt: 1 } as unknown as JobDocument;
}

function registry() {
  const put = vi.fn(async (_projectId: string, name: string) => ({ name, version: 1 }));
  return {
    put,
    registry: {
      resolve: async (_projectId: string, ref: ArtifactRef) => (ref.name === 'site-plan' ? PLAN : PROFILE),
      put,
    } as never,
  };
}

const terraBuildRequests = (requests: ProviderRequest[]) => requests.filter((r) => r.schemaName.startsWith('terra_build'));

describe('the production frontend_backend grant', () => {
  it('lets Terra read an exact scaffold file through the gateway, then stages the ordinary BuildOutput', async () => {
    const { runtime, requests } = terra([read('components/ui/button.tsx'), final()]);
    const { registry: reg, put } = registry();
    const claimed = createFrontendBackendJobSpec({ projectId: PROJECT, businessProfileRef: profileRef, sitePlanRef: planRef });
    expect(claimed.allowedTools).toEqual(['filesystem', 'test_runner']);

    const handler = createTerraFrontendBackendHandler({ registry: reg, model: runtime });
    await handler(job(claimed.allowedTools), { signal: new AbortController().signal });

    const builds = terraBuildRequests(requests);
    expect(builds).toHaveLength(2);
    const button = await readFile(join(defaultTemplateRoot(), 'components/ui/button.tsx'), 'utf8');
    expect(builds[1]!.prompt).toContain(JSON.stringify(button).slice(1, 200));
    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0] as unknown[])[2]).toMatchObject({ files: FILES });
  });

  it('Sol routing is offered no tools', async () => {
    const { runtime, requests } = terra([final()]);
    await createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime })(job(['filesystem']), {
      signal: new AbortController().signal,
    });
    const route = requests.find((r) => r.schemaName.startsWith('sol_route'))!;
    expect(route.prompt).not.toContain('INSPECTING THE SCAFFOLD');
  });
});

describe('the claimed job’s allowedTools decides', () => {
  it('with allowedTools = [] the build is offered no tools and runs exactly as before', async () => {
    const { runtime, requests } = terra([{ files: FILES, notes: 'n' }]);
    await createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime })(job([]), {
      signal: new AbortController().signal,
    });
    const builds = terraBuildRequests(requests);
    expect(builds).toHaveLength(1);
    expect(builds[0]!.prompt).not.toContain('INSPECTING THE SCAFFOLD');
  });

  it('a spec that names a tool the handler does not support cannot make it run', async () => {
    const gitExecute = vi.fn(async () => ({ tool: 'filesystem', ok: false, path: 'x', error: 'not_found' }));
    const gitAdapter: ToolAdapter<{ path: string }, unknown> = { tool: 'git', input: z.object({ path: z.string() }), execute: gitExecute, describe: () => ({}) };
    const gateway = new ToolGateway({ adapters: [createScaffoldFilesystemAdapter({ root: defaultTemplateRoot() }), gitAdapter] });
    const { runtime } = terra([read('HEAD', 'git'), final()]);

    await expect(
      createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime, tools: gateway })(job(['filesystem', 'git']), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolPermissionDenied);
    expect(gitExecute).not.toHaveBeenCalled();
  });

  it('a model that claims extra permissions in its output gains none', async () => {
    const claimedJob = job(['filesystem']);
    const { runtime } = terra([read('.env', 'hosting_release_api', { allowedTools: ['hosting_release_api'] }), final()]);

    await expect(
      createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime })(claimedJob, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ToolPermissionDenied);
    expect(claimedJob.spec.allowedTools).toEqual(['filesystem']);
  });

  it('records tool evidence under the job’s own identity, without file contents', async () => {
    const evidence: ToolEvidence[] = [];
    const gateway = new ToolGateway({
      adapters: [createScaffoldFilesystemAdapter({ root: defaultTemplateRoot() })],
      onEvidence: (e) => evidence.push(e),
    });
    const { runtime } = terra([read('app/globals.css'), final()]);
    const claimedJob = job(['filesystem']);

    await createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime, tools: gateway })(claimedJob, {
      signal: new AbortController().signal,
    });

    expect(evidence).toEqual([
      expect.objectContaining({ projectId: PROJECT, jobId: claimedJob._id, skill: 'terra-build', role: 'frontend_backend', tool: 'filesystem', outcome: 'succeeded', detail: { path: 'app/globals.css' } }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain('@theme');
  });
});

describe('isolation', () => {
  it('a read aimed at a project workspace outside the scaffold is refused, and nothing there changes', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'statxai-canonical-'));
    try {
      const canonicalFile = join(outside, 'app', 'page.tsx');
      await writeFile(join(outside, 'marker.txt'), 'canonical');
      const { runtime } = terra([read(canonicalFile), final()]);

      await expect(
        createTerraFrontendBackendHandler({ registry: registry().registry, model: runtime })(job(['filesystem']), {
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(FilesystemPathRefused);
      expect(await readFile(join(outside, 'marker.txt'), 'utf8')).toBe('canonical');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a lease lost during the build stops it before any further turn or read', async () => {
    const controller = new AbortController();
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
      name: 'fake',
      schemaDialect: 'strict',
      async complete(request) {
        requests.push(request);
        if (request.schemaName.startsWith('sol_route')) return respond({ action: 'one_shot', reason: 'r', confidence: 0.9, workstreams: null });
        controller.abort(new Error('heartbeat lost'));
        return respond(read('app/layout.tsx'));
      },
    };
    const evidence: ToolEvidence[] = [];
    const gateway = new ToolGateway({ adapters: [createScaffoldFilesystemAdapter({ root: defaultTemplateRoot() })], onEvidence: (e) => evidence.push(e) });

    await expect(
      createTerraFrontendBackendHandler({ registry: registry().registry, model: new ModelRuntime({ provider }), tools: gateway })(job(['filesystem']), {
        signal: controller.signal,
      }),
    ).rejects.toThrow('heartbeat lost');
    expect(terraBuildRequests(requests)).toHaveLength(1);
    expect(evidence).toEqual([]);
  });
});
