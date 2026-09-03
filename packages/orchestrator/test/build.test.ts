/**
 * `buildFromPlan`'s cancellation checkpoints, and that the prepare/publish
 * split (Phase 5f) leaves the direct delivery loop behaviourally identical —
 * including on failure, not merely on the successful path.
 *
 * Every collaborator is a fake here (no Mongo, no filesystem, no network):
 * this is a unit test of the checkpoints and the call sequence themselves,
 * isolated from everything else `buildFromPlan` does.
 * `frontend-backend-job-handler.integration.test.ts` covers the end-to-end
 * property — a real handler, under a real JobRunner, against a real store
 * and a real Git workspace — this file exists because that test can only
 * prove the *outermost* gap is closed (the one right around the model call
 * it happens to exercise), and a mutation check found exactly that: removing
 * the pre-model check inside `executeOneShot` broke nothing there, because a
 * *later* checkpoint in the same call happened to cover the one scenario
 * under test. Each checkpoint gets its own proof here instead.
 *
 * `route-decision` persistence is the one write the split deliberately does
 * *not* defer to `publishBuildDirectly`, and the reason is failure, not the
 * happy path: pre-5f, a route decision was durable the moment Sol (or the
 * fallback) decided it, before Terra was ever asked to build — so a build
 * that failed after routing still left that decision on record. An earlier
 * version of this split moved the write into `publishBuildDirectly`, which
 * silently changed that: a build that failed after routing left *nothing*,
 * because publish is never reached on a thrown error. `prepareBuildFromPlan`
 * now takes an optional `onRouteDecision` hook, invoked at the exact moment
 * each record is decided, and `buildFromPlan` is the only caller that
 * supplies it — restoring the original timing exactly. The regression test
 * below is the one that would have caught the original mistake: it fails
 * against a version where route-decision persistence is deferred to publish,
 * and passes against this one.
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
 * two checkpoints without depending on real async I/O timing. `terraBuild`
 * lets a test make the fake Terra call itself fail, rather than merely abort.
 */
function rig(options: {
  onSolRoute?: () => void;
  onTerraBuild?: () => void;
  onRecordRoute?: () => void;
  onWriteSiteFiles?: () => void;
  terraBuild?: () => ProviderResponse;
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
        return (options.terraBuild ?? (() => buildOutput('built')))();
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
  it('runs to completion in exactly the pre-5f order: route decided and persisted before Terra ever builds', async () => {
    const { ctx, calls, writeSiteFiles, commit, projectStateUpdated } = rig();

    await buildFromPlan(ctx, plan());

    expect(projectStateUpdated()).toBe(true);
    expect(calls).toEqual([
      'model:sol-route',
      'registry.put:route-decision',
      'model:terra-build',
      'workspace.writeSiteFiles',
      'workspace.commit',
    ]);
    expect(writeSiteFiles).toHaveBeenCalledWith([{ path: 'app/page.tsx', contents: 'built' }]);
    expect(commit).toHaveBeenCalledWith('Terra: build');
  });

  it('the failure case: a route decision survives a Terra build that fails after it', async () => {
    // The regression this test exists for. Before the fix, deferring
    // route-decision persistence into publishBuildDirectly meant a build
    // that failed here left no record of the routing decision at all —
    // publish is never reached on a thrown error. This must fail against
    // that version and pass against the restored one.
    const { ctx, calls, registryPut, writeSiteFiles } = rig({
      terraBuild: () => {
        throw new Error('terra build rejected');
      },
    });

    await expect(buildFromPlan(ctx, plan())).rejects.toThrow('terra build rejected');

    expect(registryPut).toHaveBeenCalledTimes(1);
    expect(registryPut).toHaveBeenCalledWith(facts.projectId, 'route-decision', expect.objectContaining({ strategy: 'one_shot' }));
    expect(calls).toEqual(['model:sol-route', 'registry.put:route-decision', 'model:terra-build']);
    expect(writeSiteFiles).not.toHaveBeenCalled();
  });

  it('prepare alone, given no route-decision hook, persists nothing at all — the job path’s own shape', async () => {
    const { ctx, calls, registryPut } = rig();
    const candidate = await prepareBuildFromPlan(ctx, plan());

    expect(calls).toEqual(['model:sol-route', 'model:terra-build']);
    expect(registryPut).not.toHaveBeenCalled();
    expect(candidate.routeDecisions).toHaveLength(1);
    expect(candidate.routeDecisions[0]!.strategy).toBe('one_shot');
    expect(candidate.files).toEqual([{ path: 'app/page.tsx', contents: 'built' }]);

    // publishBuildDirectly only ever handles the files and the commit now —
    // route-decision persistence happens (or does not) at decide-time.
    await publishBuildDirectly(candidate, ctx);
    expect(calls).toEqual(['model:sol-route', 'model:terra-build', 'workspace.writeSiteFiles', 'workspace.commit']);
    expect(registryPut).not.toHaveBeenCalled();
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

  it('checks after Sol answers, before the route decision is persisted', async () => {
    const controller = new AbortController();
    const { ctx, calls, registryPut } = rig({ onSolRoute: () => controller.abort() });

    await expect(buildFromPlan(ctx, plan(), controller.signal)).rejects.toThrow();
    expect(calls).toEqual(['model:sol-route']);
    expect(registryPut).not.toHaveBeenCalled();
  });

  it('checks before Terra is asked to build, after the route decision is already persisted', async () => {
    const controller = new AbortController();
    const { ctx, calls } = rig({ onRecordRoute: () => controller.abort() });

    await expect(buildFromPlan(ctx, plan(), controller.signal)).rejects.toThrow();
    expect(calls).toEqual(['model:sol-route', 'registry.put:route-decision']);
  });

  it('checks after Terra answers, before the candidate is even returned from prepare — the gap the mutation check found', async () => {
    const controller = new AbortController();
    const { ctx, calls, writeSiteFiles } = rig({ onTerraBuild: () => controller.abort() });

    await expect(buildFromPlan(ctx, plan(), controller.signal)).rejects.toThrow();
    expect(calls).toEqual(['model:sol-route', 'registry.put:route-decision', 'model:terra-build']);
    expect(writeSiteFiles).not.toHaveBeenCalled();
  });

  it('checks before the generated files are written, once prepare has actually returned', async () => {
    const controller = new AbortController();
    const { ctx, writeSiteFiles } = rig();
    const candidate = await prepareBuildFromPlan(ctx, plan());
    controller.abort();

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
