/**
 * `buildFromPlan`'s cancellation checkpoints — and, since Phase 5f, the
 * prepare/publish split itself: `prepareBuildFromPlan` computes and writes
 * nothing durable; `publishBuildDirectly` makes everything durable that
 * `buildFromPlan` always made; `buildFromPlan` is still exactly
 * project-state update, scaffold, prepare, publish, in that order, so the
 * direct delivery loop's behaviour is unchanged.
 *
 * Every collaborator is a fake here (no Mongo, no filesystem, no network):
 * this is a unit test of the checkpoints themselves, one at a time, isolated
 * from everything else `buildFromPlan` does. `frontend-backend-job-handler
 * .integration.test.ts` covers the end-to-end property — a real handler,
 * under a real JobRunner, against a real store and a real Git workspace —
 * this file exists because that test can only prove the *outermost* gap is
 * closed (the one right around the model call it happens to exercise), and
 * a mutation check found exactly that: removing the pre-model check inside
 * `executeOneShot` broke nothing there, because a *later* checkpoint in the
 * same call happened to cover the one scenario under test. Each checkpoint
 * gets its own proof here instead.
 *
 * Note what moved with the split: `route-decision` used to be persisted
 * *before* Terra was ever asked to build (right after Sol's routing call
 * returned). Deferring all durable writes to `publishBuildDirectly` means it
 * is now persisted *after* — the direct path's final state (which artifacts
 * exist, with what content, in what versions; which files are written;
 * that a commit happens) is unchanged, but the relative order of "model
 * call" versus "durable write" during generation is exactly what this split
 * exists to change, for the job path's sake. The characterisation test below
 * pins the new order deliberately, not by oversight.
 */
import { describe, expect, it, vi } from 'vitest';
import { ModelClient, type Provider, type ProviderRequest, type ProviderResponse } from '@statxai/agents';
import type { SitePlan } from '@statxai/contracts';
import type { FixedContext, RunDeps, RunFacts } from '../src/run-context.js';
import { buildFromPlan, prepareBuildFromPlan, publishBuildDirectly } from '../src/phases/build.js';

const plan = (): SitePlan =>
  ({
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
  }) as unknown as SitePlan;

const facts: RunFacts = {
  projectId: 'proj_build_unit',
  profile: { services: [] } as unknown as RunFacts['profile'],
  autonomyMode: 'full_autonomous',
  budgetLimits: { reviewRejections: 3, repairsPerDefect: 2, totalRepairJobs: 5, fullRebuilds: 1, replans: 1, failedDeployments: 2 },
};

class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly schemaDialect = 'standard' as const;
  constructor(private readonly respond: (request: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>) {}
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    return this.respond(request);
  }
}

const solRouteOneShot = (): ProviderResponse => ({
  text: JSON.stringify({ action: 'one_shot', reason: 'single page', confidence: 0.9, workstreams: null }),
  model: 'fake-sol',
  inputTokens: 1,
  outputTokens: 1,
  stopReason: 'complete',
});

const buildOutput = (contents: string): ProviderResponse => ({
  text: JSON.stringify({ files: [{ path: 'app/page.tsx', contents }], notes: 'n' }),
  model: 'fake-terra',
  inputTokens: 1,
  outputTokens: 1,
  stopReason: 'complete',
});

interface Rig {
  ctx: FixedContext;
  calls: string[];
  writeSiteFiles: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  registryPut: ReturnType<typeof vi.fn>;
  projectStateUpdated: () => boolean;
}

/**
 * `onSolRoute` / `onTerraBuild` / `onRecordRoute` / `onWriteSiteFiles` are
 * side-effect hooks fired from inside the collaborator they name — the only
 * way to move an AbortController's `.abort()` to a precise point *between*
 * two checkpoints without depending on real async I/O timing.
 */
function rig(options: {
  onSolRoute?: () => void;
  onTerraBuild?: () => void;
  onRecordRoute?: () => void;
  onWriteSiteFiles?: () => void;
} = {}): Rig {
  const calls: string[] = [];
  let projectStateUpdated = false;

  const model = new ModelClient(
    new FakeProvider((request) => {
      if (request.schemaName.startsWith('sol_route')) {
        calls.push('model:sol-route');
        options.onSolRoute?.();
        return solRouteOneShot();
      }
      if (request.schemaName.startsWith('terra_build')) {
        calls.push('model:terra-build');
        options.onTerraBuild?.();
        return buildOutput('built');
      }
      throw new Error(`unexpected model call: ${request.schemaName}`);
    }),
  );

  const registryPut = vi.fn(async (_projectId: string, name: string, _data: unknown) => {
    calls.push(`registry.put:${name}`);
    if (name === 'route-decision') options.onRecordRoute?.();
    return { name, version: 1 };
  });

  const writeSiteFiles = vi.fn(async (_files: unknown) => {
    calls.push('workspace.writeSiteFiles');
    options.onWriteSiteFiles?.();
    return [];
  });

  const commit = vi.fn(async (_message: string) => {
    calls.push('workspace.commit');
    return 'deadbeef';
  });

  const deps: RunDeps = {
    store: {
      projects: {
        updateOne: vi.fn(async () => {
          projectStateUpdated = true;
        }),
      },
    } as unknown as RunDeps['store'],
    registry: {
      put: registryPut,
      accept: vi.fn(async () => {}),
    } as unknown as RunDeps['registry'],
    workspace: {
      siteRoot: '/tmp/does-not-matter',
      writeSiteFiles,
      materialiseArtifact: vi.fn(async () => {}),
      commit,
    } as unknown as RunDeps['workspace'],
    model,
    say: () => {},
    track: () => {},
  };

  return {
    ctx: { deps, facts },
    calls,
    writeSiteFiles,
    commit,
    registryPut,
    projectStateUpdated: () => projectStateUpdated,
  };
}

describe('the direct build path is unchanged', () => {
  it('runs to completion exactly as before when no signal is passed', async () => {
    const { ctx, calls, writeSiteFiles, commit, projectStateUpdated } = rig();

    await buildFromPlan(ctx, plan());

    expect(projectStateUpdated()).toBe(true);
    // route-decision now persists after Terra generates, not before — see the
    // module doc comment on why the split moves this, deliberately, without
    // changing the direct path's final artifacts, files, or commit.
    expect(calls).toEqual([
      'model:sol-route',
      'model:terra-build',
      'registry.put:route-decision',
      'workspace.writeSiteFiles',
      'workspace.commit',
    ]);
    expect(writeSiteFiles).toHaveBeenCalledWith([{ path: 'app/page.tsx', contents: 'built' }]);
    expect(commit).toHaveBeenCalledWith('Terra: build');
  });

  it('composes exactly prepare then publish, with nothing else in between', async () => {
    const { ctx, calls } = rig();
    const candidate = await prepareBuildFromPlan(ctx, plan());

    // Prepare alone writes nothing durable at all.
    expect(calls).toEqual(['model:sol-route', 'model:terra-build']);
    expect(candidate.routeDecisions).toHaveLength(1);
    expect(candidate.routeDecisions[0]!.strategy).toBe('one_shot');
    expect(candidate.files).toEqual([{ path: 'app/page.tsx', contents: 'built' }]);

    await publishBuildDirectly(candidate, ctx);
    expect(calls).toEqual([
      'model:sol-route',
      'model:terra-build',
      'registry.put:route-decision',
      'workspace.writeSiteFiles',
      'workspace.commit',
    ]);
  });
});

describe('cancellation checkpoints, each isolated from the others', () => {
  it('checks before Sol is asked to route at all', async () => {
    const { ctx, calls } = rig();
    const controller = new AbortController();
    controller.abort();

    await expect(buildFromPlan(ctx, plan(), controller.signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('checks after Sol answers, before Terra is asked to build', async () => {
    const controller = new AbortController();
    const { ctx, calls } = rig({ onSolRoute: () => controller.abort() });

    await expect(buildFromPlan(ctx, plan(), controller.signal)).rejects.toThrow();
    expect(calls).toEqual(['model:sol-route']);
  });

  it('checks after Terra answers, before the candidate is even returned from prepare — the gap the mutation check found', async () => {
    const controller = new AbortController();
    const { ctx, calls, registryPut } = rig({ onTerraBuild: () => controller.abort() });

    await expect(buildFromPlan(ctx, plan(), controller.signal)).rejects.toThrow();
    expect(calls).toEqual(['model:sol-route', 'model:terra-build']);
    // Prepare itself throws, so publish — and therefore every durable write —
    // is never reached at all.
    expect(registryPut).not.toHaveBeenCalled();
  });

  it('checks before the route-decision artifact is published', async () => {
    const controller = new AbortController();
    const { ctx, calls, writeSiteFiles } = rig();
    const candidate = await prepareBuildFromPlan(ctx, plan());
    controller.abort();

    await expect(publishBuildDirectly(candidate, ctx, controller.signal)).rejects.toThrow();
    expect(calls).toEqual(['model:sol-route', 'model:terra-build']);
    expect(writeSiteFiles).not.toHaveBeenCalled();
  });

  it('checks after the route-decision is published, before the generated files are written', async () => {
    const controller = new AbortController();
    const { ctx, writeSiteFiles } = rig({ onRecordRoute: () => controller.abort() });
    const candidate = await prepareBuildFromPlan(ctx, plan());

    await expect(publishBuildDirectly(candidate, ctx, controller.signal)).rejects.toThrow();
    expect(writeSiteFiles).not.toHaveBeenCalled();
  });

  it('checks before the final commit, even after the files were written', async () => {
    const controller = new AbortController();
    const { ctx, commit } = rig({ onWriteSiteFiles: () => controller.abort() });
    const candidate = await prepareBuildFromPlan(ctx, plan());

    await expect(publishBuildDirectly(candidate, ctx, controller.signal)).rejects.toThrow();
    expect(commit).not.toHaveBeenCalled();
  });
});
