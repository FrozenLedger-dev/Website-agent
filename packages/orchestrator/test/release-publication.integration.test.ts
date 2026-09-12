/**
 * Operator-reconciled durable release publication authority (Phase 5p) —
 * against a real Mongo replica set and a real canonical Git workspace.
 *
 * The provider is the one thing faked here, and deliberately so: the property
 * under test is what happens when a production deployment's outcome becomes
 * unknowable, which is exactly the state a real Vercel account cannot be asked
 * to reproduce. The fake counts every `createDeployment` it receives, so
 * "automation never deployed twice" is checked directly rather than inferred.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@statxai/state';
import type { ReleasePublicationDocument } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import type { ArtifactRef } from '@statxai/contracts';
import type { ReleaseAuthorization } from '@statxai/policy-engine';
import type { RunContext } from '../src/run-context.js';
import { publishRelease, type ReleaseDeploymentGateway } from '../src/phases/publish.js';
import {
  RELEASE_COMMIT_METADATA_KEY,
  RELEASE_METADATA_KEY,
  ReleasePublicationAdoptionConflict,
  ReleasePublicationAttemptConflict,
  ReleasePublicationBaseConflict,
  ReleasePublicationReconciliationRequired,
  ReleasePublicationTargetConflict,
  adoptReleaseDeployment,
  authorizeReleaseRepublication,
  computeReleaseId,
  ensureReleasePublicationPrepared,
  releaseMarker,
  resolveDeploymentTarget,
} from '../src/release-publication/publication.js';

let store: StateStore;
let registry: ArtifactRegistry;
let workspacesRoot: string;
let counter = 0;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-release-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.releasePublications.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  // A configured deployment is what Phase 5p's authority applies to.
  vi.stubEnv('VERCEL_TOKEN', 'test-token');
  vi.stubEnv('VERCEL_TEAM_ID', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTHORIZATION: ReleaseAuthorization = {
  authorized: true,
  action: 'release',
  reason: 'gates passed, no blocking defects',
  policyVersion: 'test-policy@1',
} as ReleaseAuthorization;

interface Fixture {
  projectId: string;
  workspace: ProjectWorkspace;
  authorizationRef: ArtifactRef;
  ctx: RunContext;
}

/** One project with a canonical workspace, one commit, and an authorisation. */
async function fixture(): Promise<Fixture> {
  const projectId = `proj_rel_${(counter += 1)}`;
  const workspace = await ProjectWorkspace.open(projectId, workspacesRoot);

  // Something to publish, and a canonical base commit to publish it from.
  await workspace.materialiseArtifact('site/index.json', { page: 'home' });
  await workspace.commit('Harness: accepted revision');

  await store.projects.insertOne({
    _id: projectId,
    state: 'validating',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);

  const authorizationRef = await registry.put(projectId, 'release-authorization', {
    authorized: true,
    action: 'release',
    reviewCycle: 0,
  });

  // `seekRelease` materialises its decision records without committing them,
  // so a real release reaches publication with an uncommitted tree — which is
  // what makes the release-authorized commit exist at all.
  await workspace.materialiseArtifact('decisions/release-authorization-00.json', { authorized: true });

  const ctx = {
    deps: {
      store,
      registry,
      workspace,
      model: {} as never,
      say: () => {},
      track: () => {},
    },
    facts: {
      projectId,
      profile: { businessName: 'Acme' } as never,
      autonomyMode: 'full_autonomous' as const,
      budgetLimits: {} as never,
    },
    progress: {
      qualityScore: 91,
      gatesCertified: ['build'],
      approvalModel: 'test-model',
      approvalArtifactVersion: 1,
      approvalDecision: 'accept' as const,
    } as never,
  } as unknown as RunContext;

  return { projectId, workspace, authorizationRef, ctx };
}

interface FakeProvider extends ReleaseDeploymentGateway {
  /** How many times automation asked the provider to create a deployment. */
  created: number;
  /** Deployments that exist provider-side, whatever the caller learned. */
  existing: Map<string, { deploymentId: string; url: string; meta: Record<string, string>; project: string | null; target: string | null }>;
  /** Runs at the instant `deploy` is entered, before anything is returned. */
  onDeploy?: (attempt: number) => Promise<void> | void;
  /** Simulates the provider accepting the deployment and the caller dying. */
  loseOutcome: boolean;
  /** Simulates a transport/provider failure after the request was sent. */
  failWith: Error | null;
}

function fakeProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  const provider: FakeProvider = {
    created: 0,
    existing: new Map(),
    loseOutcome: false,
    failWith: null,
    async deploy(input) {
      provider.created += 1;
      await provider.onDeploy?.(provider.created);

      // The provider does its work first — which is precisely why a failure
      // after this point is ambiguous rather than a proof of nothing.
      const deploymentId = `dpl_fake_${provider.created}`;
      const url = `https://${input.projectId}-${provider.created}.vercel.app`;
      provider.existing.set(deploymentId, {
        deploymentId,
        url,
        meta: { ...input.meta },
        project: input.projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        target: 'production',
      });

      if (provider.failWith) throw provider.failWith;
      if (provider.loseOutcome) throw new Error('connection reset before the response arrived');

      return {
        deploymentId,
        url,
        rollbackRef: input.previousDeploymentId,
        fileCount: 3,
        durationMs: 10,
        meta: { ...input.meta },
      };
    },
    async getDeploymentById(deploymentId) {
      const found = provider.existing.get(deploymentId);
      if (!found) throw new Error(`no such deployment: ${deploymentId}`);
      return found;
    },
    ...overrides,
  };
  return provider;
}

const publish = (f: Fixture, gateway: ReleaseDeploymentGateway) =>
  publishRelease(f.ctx, AUTHORIZATION, { releaseAuthorizationRef: f.authorizationRef, gateway });

const receiptOf = (releaseId: string): Promise<ReleasePublicationDocument | null> =>
  store.releasePublications.findOne({ _id: releaseId });

const releaseIdOf = (f: Fixture) =>
  computeReleaseId({ projectId: f.projectId, releaseAuthorization: f.authorizationRef });

const failed = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error);

// ---------------------------------------------------------------------------

describe('release identity', () => {
  it('is deterministic for one exact authorisation, and different for another', async () => {
    const f = await fixture();
    const again = computeReleaseId({ projectId: f.projectId, releaseAuthorization: f.authorizationRef });
    expect(again).toBe(releaseIdOf(f));

    // A second authorisation — a later review cycle, a later run — is a
    // different logical release.
    const second = await registry.put(f.projectId, 'release-authorization', { authorized: true, reviewCycle: 1 });
    expect(computeReleaseId({ projectId: f.projectId, releaseAuthorization: second })).not.toBe(again);

    // And the same authorisation under another project never collides.
    expect(
      computeReleaseId({ projectId: 'proj_other', releaseAuthorization: f.authorizationRef }),
    ).not.toBe(again);
  });
});

describe('the first publication attempt', () => {
  it('records publishing authority before the provider is ever called', async () => {
    const f = await fixture();
    const baseBefore = await f.workspace.currentCommit();
    let atCallTime: ReleasePublicationDocument | null = null;
    const provider = fakeProvider({
      onDeploy: async () => {
        atCallTime = await receiptOf(releaseIdOf(f));
      },
    });

    await publish(f, provider);

    expect(atCallTime).not.toBeNull();
    expect(atCallTime!.status).toBe('publishing');
    expect(atCallTime!.attempt).toBe(1);
    expect(atCallTime!.attempts).toHaveLength(1);
    // And the exact revision being published — the release-authorized commit
    // this attempt just made, not the base it started from — is already bound.
    expect(atCallTime!.releaseCommitSha).not.toBeNull();
    expect(atCallTime!.releaseCommitSha).not.toBe(baseBefore);
    expect(atCallTime!.baseCommit).toBe(baseBefore);
  });

  it('commits the release revision under its own marker and publishes it', async () => {
    const f = await fixture();
    const provider = fakeProvider();

    const result = await publish(f, provider);

    const receipt = (await receiptOf(releaseIdOf(f)))!;
    expect(receipt.status).toBe('committed');
    expect(receipt.deploymentId).toBe('dpl_fake_1');
    expect(result.manifest.url).toBe(receipt.deploymentUrl);
    expect(result.manifest.environment).toBe('production');

    // The deployment carries the release marker an operator reconciles against.
    const deployed = provider.existing.get('dpl_fake_1')!;
    expect(deployed.meta[RELEASE_METADATA_KEY]).toBe(receipt._id);
    expect(deployed.meta[RELEASE_COMMIT_METADATA_KEY]).toBe(receipt.releaseCommitSha);

    // Exactly one release-authorized commit exists for this release.
    expect(await f.workspace.findCommitsByMarker(releaseMarker(receipt._id))).toHaveLength(1);
    expect((await store.projects.findOne({ _id: f.projectId }))?.state).toBe('released');
  });
});

describe('an ambiguous external outcome', () => {
  it('leaves publishing behind when the provider accepted it but the answer was lost', async () => {
    const f = await fixture();
    const provider = fakeProvider({ loseOutcome: true });

    const error = await failed(publish(f, provider));

    expect(error).toBeInstanceOf(ReleasePublicationReconciliationRequired);
    // The deployment genuinely exists provider-side — this is the dangerous state.
    expect(provider.existing.size).toBe(1);
    expect(provider.created).toBe(1);

    const receipt = (await receiptOf(releaseIdOf(f)))!;
    expect(receipt.status).toBe('publishing');
    expect(receipt.attempt).toBe(1);
    expect(receipt.deploymentId).toBeNull();
  });

  it('refuses to deploy again on the next invocation, with the process rebuilt', async () => {
    const f = await fixture();
    await failed(publish(f, fakeProvider({ loseOutcome: true })));

    // A completely fresh provider and workspace handle: the restart case.
    const restarted = fakeProvider();
    const reopened = await ProjectWorkspace.open(f.projectId, workspacesRoot);
    const ctx = { ...f.ctx, deps: { ...f.ctx.deps, workspace: reopened } } as RunContext;

    const error = await failed(
      publishRelease(ctx, AUTHORIZATION, { releaseAuthorizationRef: f.authorizationRef, gateway: restarted }),
    );

    expect(error).toBeInstanceOf(ReleasePublicationReconciliationRequired);
    expect(restarted.created).toBe(0);
    const receipt = (await receiptOf(releaseIdOf(f)))!;
    expect(receipt.status).toBe('publishing');
    expect(receipt.attempt).toBe(1);
    // No second release commit was made either.
    expect(await reopened.findCommitsByMarker(releaseMarker(receipt._id))).toHaveLength(1);
  });

  it('stops the same way when the request itself failed', async () => {
    const f = await fixture();
    const provider = fakeProvider({ failWith: new Error('502 from the provider') });

    expect(await failed(publish(f, provider))).toBeInstanceOf(ReleasePublicationReconciliationRequired);

    const receipt = (await receiptOf(releaseIdOf(f)))!;
    // A failed request is not proof that nothing was created.
    expect(receipt.status).toBe('publishing');

    const next = fakeProvider();
    expect(await failed(publish(f, next))).toBeInstanceOf(ReleasePublicationReconciliationRequired);
    expect(next.created).toBe(0);
  });
});

describe('operator reconciliation', () => {
  it('adopts one exact deployment, without creating another', async () => {
    const f = await fixture();
    const provider = fakeProvider({ loseOutcome: true });
    await failed(publish(f, provider));

    const receipt = await adoptReleaseDeployment(store, provider, {
      projectId: f.projectId,
      releaseId: releaseIdOf(f),
      attempt: 1,
      deploymentId: 'dpl_fake_1',
      actor: 'operator:tester',
      reason: 'found it live in the dashboard',
    });

    expect(receipt.status).toBe('committed');
    expect(receipt.deploymentId).toBe('dpl_fake_1');
    expect(receipt.active).toBeUndefined();
    expect(provider.created).toBe(1);

    // The ambiguous attempt is preserved, now with who resolved it and why.
    expect(receipt.attempts).toHaveLength(1);
    expect(receipt.attempts[0]).toMatchObject({
      attempt: 1,
      status: 'adopted',
      resolution: { actor: 'operator:tester', reason: 'found it live in the dashboard' },
    });
  });

  it('refuses a deployment that does not carry this release’s marker', async () => {
    const f = await fixture();
    const provider = fakeProvider({ loseOutcome: true });
    await failed(publish(f, provider));

    provider.existing.set('dpl_someone_else', {
      deploymentId: 'dpl_someone_else',
      url: 'https://elsewhere.vercel.app',
      meta: { [RELEASE_METADATA_KEY]: 'a-different-release' },
      project: null,
      target: 'production',
    });

    const error = await failed(
      adoptReleaseDeployment(store, provider, {
        projectId: f.projectId,
        releaseId: releaseIdOf(f),
        attempt: 1,
        deploymentId: 'dpl_someone_else',
        actor: 'operator:tester',
        reason: 'looked about right',
      }),
    );

    expect(error).toBeInstanceOf(ReleasePublicationAdoptionConflict);
    expect((await receiptOf(releaseIdOf(f)))!.status).toBe('publishing');
  });

  it('refuses a deployment belonging to another project or target', async () => {
    const f = await fixture();
    const provider = fakeProvider({ loseOutcome: true });
    await failed(publish(f, provider));
    const releaseId = releaseIdOf(f);

    const foreign = { ...provider.existing.get('dpl_fake_1')!, project: 'some-other-project' };
    provider.existing.set('dpl_foreign', { ...foreign, deploymentId: 'dpl_foreign' });
    provider.existing.set('dpl_staging', {
      ...provider.existing.get('dpl_fake_1')!,
      deploymentId: 'dpl_staging',
      target: 'staging',
    });

    for (const deploymentId of ['dpl_foreign', 'dpl_staging']) {
      const error = await failed(
        adoptReleaseDeployment(store, provider, {
          projectId: f.projectId,
          releaseId,
          attempt: 1,
          deploymentId,
          actor: 'operator:tester',
          reason: 'test',
        }),
      );
      expect(error, deploymentId).toBeInstanceOf(ReleasePublicationAdoptionConflict);
    }
    expect((await receiptOf(releaseId))!.status).toBe('publishing');
  });

  it('authorises exactly one further attempt, keeping the ambiguous one on record', async () => {
    const f = await fixture();
    await failed(publish(f, fakeProvider({ loseOutcome: true })));
    const releaseId = releaseIdOf(f);

    const authorized = await authorizeReleaseRepublication(store, {
      projectId: f.projectId,
      releaseId,
      attempt: 1,
      actor: 'operator:tester',
      reason: 'dashboard shows no deployment for this release',
    });

    expect(authorized.status).toBe('retry_authorized');
    expect(authorized.attempts).toHaveLength(1);
    expect(authorized.attempts[0]!.status).toBe('retry_authorized');
    expect(authorized.attempts[0]!.resolution).toMatchObject({ actor: 'operator:tester' });

    // One more attempt happens, and only one.
    const provider = fakeProvider();
    await publish(f, provider);
    expect(provider.created).toBe(1);

    const receipt = (await receiptOf(releaseId))!;
    expect(receipt.status).toBe('committed');
    expect(receipt.attempt).toBe(2);
    // Attempt 1 is still there — it may correspond to a real deployment.
    expect(receipt.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(receipt.attempts[0]!.status).toBe('retry_authorized');
  });

  it('stops again when the authorised attempt is itself ambiguous', async () => {
    const f = await fixture();
    await failed(publish(f, fakeProvider({ loseOutcome: true })));
    const releaseId = releaseIdOf(f);
    await authorizeReleaseRepublication(store, {
      projectId: f.projectId,
      releaseId,
      attempt: 1,
      actor: 'operator:tester',
      reason: 'first reconciliation',
    });

    const second = fakeProvider({ loseOutcome: true });
    expect(await failed(publish(f, second))).toBeInstanceOf(ReleasePublicationReconciliationRequired);

    const receipt = (await receiptOf(releaseId))!;
    expect(receipt.status).toBe('publishing');
    expect(receipt.attempt).toBe(2);

    // No third attempt without a second human decision.
    const third = fakeProvider();
    expect(await failed(publish(f, third))).toBeInstanceOf(ReleasePublicationReconciliationRequired);
    expect(third.created).toBe(0);
  });

  it('refuses a stale reconciliation naming an attempt that has moved on', async () => {
    const f = await fixture();
    await failed(publish(f, fakeProvider({ loseOutcome: true })));
    const releaseId = releaseIdOf(f);
    await authorizeReleaseRepublication(store, {
      projectId: f.projectId,
      releaseId,
      attempt: 1,
      actor: 'operator:tester',
      reason: 'first',
    });
    await failed(publish(f, fakeProvider({ loseOutcome: true })));

    // The receipt is now at attempt 2; a command written for attempt 1 must
    // never resolve it.
    for (const stale of [
      adoptReleaseDeployment(store, fakeProvider(), {
        projectId: f.projectId,
        releaseId,
        attempt: 1,
        deploymentId: 'dpl_fake_1',
        actor: 'operator:tester',
        reason: 'stale adopt',
      }),
      authorizeReleaseRepublication(store, {
        projectId: f.projectId,
        releaseId,
        attempt: 1,
        actor: 'operator:tester',
        reason: 'stale retry',
      }),
    ]) {
      expect(await failed(stale)).toBeInstanceOf(ReleasePublicationAttemptConflict);
    }

    const receipt = (await receiptOf(releaseId))!;
    expect(receipt.attempt).toBe(2);
    expect(receipt.status).toBe('publishing');
  });
});

describe('concurrency', () => {
  it('lets exactly one of two concurrent publishers deploy', async () => {
    const f = await fixture();
    const provider = fakeProvider();
    // Both publishers share one provider, so the count is the real external
    // effect rather than two independent fakes each seeing one call.
    const outcomes = await Promise.allSettled([publish(f, provider), publish(f, provider)]);

    expect(provider.created).toBe(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

    const receipt = (await receiptOf(releaseIdOf(f)))!;
    expect(receipt.status).toBe('committed');
    expect(receipt.attempt).toBe(1);
    expect(receipt.attempts).toHaveLength(1);
  });

  it('lets exactly one of two publishers consume a single retry authorisation', async () => {
    const f = await fixture();
    await failed(publish(f, fakeProvider({ loseOutcome: true })));
    const releaseId = releaseIdOf(f);
    await authorizeReleaseRepublication(store, {
      projectId: f.projectId,
      releaseId,
      attempt: 1,
      actor: 'operator:tester',
      reason: 'reconciled',
    });

    const provider = fakeProvider();
    await Promise.allSettled([publish(f, provider), publish(f, provider)]);

    expect(provider.created).toBe(1);
    const receipt = (await receiptOf(releaseId))!;
    expect(receipt.attempt).toBe(2);
    expect(receipt.attempts).toHaveLength(2);
  });

  it('refuses a second, different release while one is unfinished', async () => {
    const f = await fixture();
    await failed(publish(f, fakeProvider({ loseOutcome: true })));

    // A later authorisation for the same project — a different logical release.
    const laterRef = await registry.put(f.projectId, 'release-authorization', { authorized: true, reviewCycle: 9 });
    const provider = fakeProvider();
    const error = await failed(
      publishRelease(f.ctx, AUTHORIZATION, { releaseAuthorizationRef: laterRef, gateway: provider }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ReleasePublicationConflict');
    expect(provider.created).toBe(0);
  });
});

describe('replay of a committed release', () => {
  it('reuses the exact deployment without calling the provider or committing again', async () => {
    const f = await fixture();
    const first = await publish(f, fakeProvider());
    const releaseId = releaseIdOf(f);
    const headAfterFirst = await f.workspace.currentCommit();

    const provider = fakeProvider();
    const second = await publish(f, provider);

    expect(provider.created).toBe(0);
    expect(second.manifest.url).toBe(first.manifest.url);
    expect(second.manifest.deploymentId).toBe(first.manifest.deploymentId);
    expect(second.manifest.commit).toBe(first.manifest.commit);
    // Still exactly one release-authorized commit for this release.
    expect(await f.workspace.findCommitsByMarker(releaseMarker(releaseId))).toHaveLength(1);
    // The manifest commit is the only new history.
    expect(await f.workspace.currentCommit()).not.toBe(headAfterFirst);
  });

  it('writes the manifest from the receipt when the first attempt crashed before it', async () => {
    const f = await fixture();
    const provider = fakeProvider();

    // Publish, then delete the manifest artifact: the exact state left behind
    // by a crash between the deployment being recorded and the manifest write.
    await publish(f, provider);
    await store.artifacts.deleteMany({ projectId: f.projectId, name: 'deployment-manifest' });
    await store.projects.updateOne({ _id: f.projectId }, { $set: { state: 'releasing' } });

    const result = await publish(f, provider);

    expect(provider.created).toBe(1);
    expect(result.manifest.deploymentId).toBe('dpl_fake_1');
    expect(result.manifest.url).toBe(provider.existing.get('dpl_fake_1')!.url);
    const manifests = await store.artifacts.find({ projectId: f.projectId, name: 'deployment-manifest' }).toArray();
    expect(manifests).toHaveLength(1);
    expect((await store.projects.findOne({ _id: f.projectId }))?.state).toBe('released');
  });

  it('adds no deployment when the manifest exists but the project never reached released', async () => {
    const f = await fixture();
    const provider = fakeProvider();
    await publish(f, provider);
    await store.projects.updateOne({ _id: f.projectId }, { $set: { state: 'releasing' } });

    await publish(f, provider);

    expect(provider.created).toBe(1);
    expect((await store.projects.findOne({ _id: f.projectId }))?.state).toBe('released');
    // The replayed manifest never makes the release its own rollback target.
    const manifests = await store.artifacts
      .find({ projectId: f.projectId, name: 'deployment-manifest' })
      .sort({ version: -1 })
      .toArray();
    expect((manifests[0]!.data as { rollbackRef: string | null }).rollbackRef).toBeNull();
  });
});

describe('canonical and target drift', () => {
  it('fails closed when HEAD moved and nothing was published yet', async () => {
    const f = await fixture();
    const base = await f.workspace.currentCommit();

    // A prepared release, authorised against base — then canonical HEAD moves
    // underneath it before anything was published.
    const prepared = await ensureReleasePublicationPrepared(store, {
      releaseId: releaseIdOf(f),
      projectId: f.projectId,
      releaseAuthorization: f.authorizationRef,
      baseCommit: base,
      deploymentTarget: resolveDeploymentTarget(f.projectId),
    });
    // An unfinished release owns the project's publication slot from the
    // moment its authority exists, not only once it has sent something.
    expect(prepared.status).toBe('prepared');
    expect(prepared.active).toBe(true);
    await f.workspace.materialiseArtifact('site/unrelated.json', { changed: true });
    const moved = await f.workspace.commit('Something else entirely');

    const next = fakeProvider();
    const error = await failed(publish(f, next));

    expect(error).toBeInstanceOf(ReleasePublicationBaseConflict);
    expect(next.created).toBe(0);
    // HEAD is untouched: no reset, no rebase.
    expect(await f.workspace.currentCommit()).toBe(moved);
    expect((await receiptOf(releaseIdOf(f)))!.baseCommit).not.toBe(moved);
  });

  it('fails closed before publishing when the deployment target changed', async () => {
    const f = await fixture();
    await failed(publish(f, fakeProvider({ loseOutcome: true })));
    await authorizeReleaseRepublication(store, {
      projectId: f.projectId,
      releaseId: releaseIdOf(f),
      attempt: 1,
      actor: 'operator:tester',
      reason: 'reconciled',
    });

    // The process is reconfigured for another Vercel team.
    vi.stubEnv('VERCEL_TEAM_ID', 'team_somewhere_else');

    const provider = fakeProvider();
    const error = await failed(publish(f, provider));

    expect(error).toBeInstanceOf(ReleasePublicationTargetConflict);
    expect(provider.created).toBe(0);
    expect((await receiptOf(releaseIdOf(f)))!.deploymentTarget.team).toBeNull();
  });
});

describe('legacy releases and release policy', () => {
  it('does not treat a pre-Phase-5p manifest as an unresolved publication', async () => {
    const f = await fixture();
    // A historical release: a manifest and a live deployment, no receipt.
    await registry.put(f.projectId, 'deployment-manifest', {
      projectId: f.projectId,
      deploymentId: 'dpl_legacy',
      url: 'https://legacy.vercel.app',
    });

    expect(await store.releasePublications.countDocuments({ projectId: f.projectId })).toBe(0);

    // The next release publishes normally, and treats the legacy deployment as
    // its rollback target rather than as its own unfinished attempt.
    const provider = fakeProvider();
    const result = await publish(f, provider);

    expect(provider.created).toBe(1);
    expect(result.manifest.rollbackRef).toBe('dpl_legacy');
    expect((await receiptOf(releaseIdOf(f)))!.status).toBe('committed');
  });

  it('never grants release permission — the receipt only proves publication identity', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: joinPath } = await import('node:path');
    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');

    const publishSource = await readFile(joinPath(src, 'phases/publish.ts'), 'utf8');
    const publicationSource = await readFile(joinPath(src, 'release-publication/publication.ts'), 'utf8');
    const orchestrator = await readFile(joinPath(src, 'orchestrator.ts'), 'utf8');

    // Neither module decides whether a release may happen.
    for (const source of [publishSource, publicationSource]) {
      expect(source).not.toContain('authorizeRelease(');
      expect(source).not.toContain('recommendApproval(');
    }
    // And the harness guard still stands in front of publication — not merely
    // earlier in the file, but actually returning before it can be reached.
    const guard = orchestrator.indexOf('if (!progress.authorization?.authorized)');
    const publish = orchestrator.indexOf('publishRelease(ctx()');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(publish);
    expect(orchestrator.slice(guard, publish)).toContain('return concluded(');

    // The release-authorized commit subject is the same on both paths.
    expect(publishSource).toContain("commit('Harness: release-authorized revision')");
    expect(publicationSource).toContain('Harness: release-authorized revision');
  });
});

/**
 * The two lifecycle properties the authority rests on, proven through the
 * production paths rather than against the helpers in isolation: who owns the
 * project's publication slot, and what happens when a superseded attempt
 * finally answers.
 */
describe('the active publication slot', () => {
  it('is released on commit, so a later release for the same project can own it', async () => {
    const f = await fixture();
    const first = fakeProvider();
    await publish(f, first);

    const a = (await receiptOf(releaseIdOf(f)))!;
    expect(a.status).toBe('committed');
    expect(a.active).toBeUndefined();

    // A genuinely different logical release: a later authorisation artifact.
    const laterRef = await registry.put(f.projectId, 'release-authorization', { authorized: true, reviewCycle: 4 });
    const bId = computeReleaseId({ projectId: f.projectId, releaseAuthorization: laterRef });
    expect(bId).not.toBe(a._id);

    // Its own uncommitted decision record, as `seekRelease` would have left.
    await f.workspace.materialiseArtifact('decisions/release-authorization-01.json', { authorized: true });

    const second = fakeProvider();
    await publishRelease(f.ctx, AUTHORIZATION, { releaseAuthorizationRef: laterRef, gateway: second });

    expect(second.created).toBe(1);
    const b = (await receiptOf(bId))!;
    expect(b.status).toBe('committed');
    expect(b.active).toBeUndefined();
    // Release A is untouched history, not reopened to make room for B.
    const aAfter = (await receiptOf(a._id))!;
    expect(aAfter.deploymentId).toBe(a.deploymentId);
    expect(aAfter.committedAt).toEqual(a.committedAt);
  });

  it('is retained through retry_authorized, still blocking a different release', async () => {
    const f = await fixture();
    await failed(publish(f, fakeProvider({ loseOutcome: true })));
    const releaseId = releaseIdOf(f);

    // Ambiguous: the slot is held.
    expect((await receiptOf(releaseId))!.active).toBe(true);

    await authorizeReleaseRepublication(store, {
      projectId: f.projectId,
      releaseId,
      attempt: 1,
      actor: 'operator:tester',
      reason: 'reconciled',
    });

    const authorized = (await receiptOf(releaseId))!;
    expect(authorized.status).toBe('retry_authorized');
    expect(authorized.active).toBe(true);

    // An operator authorising a retry has not finished the release, so a
    // different one still cannot start publishing alongside it.
    const otherRef = await registry.put(f.projectId, 'release-authorization', { authorized: true, reviewCycle: 7 });
    const blocked = fakeProvider();
    const error = await failed(
      publishRelease(f.ctx, AUTHORIZATION, { releaseAuthorizationRef: otherRef, gateway: blocked }),
    );

    expect((error as Error).name).toBe('ReleasePublicationConflict');
    expect(blocked.created).toBe(0);
  });
});

describe('a late result from a superseded attempt', () => {
  /** Polls durable state rather than guessing at timing. */
  async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /** Attempt 1, held inside the provider call with its outcome undecided. */
  async function attemptOneInFlight(f: Fixture) {
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const provider = fakeProvider({ onDeploy: async () => void (await held) });
    const settled = publish(f, provider).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    await waitFor(async () => {
      const receipt = await receiptOf(releaseIdOf(f));
      return receipt?.status === 'publishing' && receipt.attempt === 1;
    }, 'attempt 1 to become publishing');

    return { provider, settled, open };
  }

  it('cannot commit over the newer attempt an operator authorised', async () => {
    const f = await fixture();
    const releaseId = releaseIdOf(f);
    const first = await attemptOneInFlight(f);

    await authorizeReleaseRepublication(store, {
      projectId: f.projectId,
      releaseId,
      attempt: 1,
      actor: 'operator:tester',
      reason: 'dashboard shows nothing for attempt 1',
    });

    // Attempt 2 runs to completion while attempt 1 is still in flight.
    const second = fakeProvider();
    await publish(f, second);
    const afterTwo = (await receiptOf(releaseId))!;
    expect(afterTwo.status).toBe('committed');
    expect(afterTwo.attempt).toBe(2);

    // Attempt 1 finally succeeds at the provider — far too late to matter.
    first.open();
    await first.settled;

    const final = (await receiptOf(releaseId))!;
    expect(final.attempt).toBe(2);
    expect(final.deploymentId).toBe(afterTwo.deploymentId);
    expect(final.deploymentUrl).toBe(afterTwo.deploymentUrl);
    expect(final.committedAt).toEqual(afterTwo.committedAt);
    // Attempt 1 never became a success and never gained a deployment.
    expect(final.attempts).toHaveLength(2);
    expect(final.attempts[0]!.status).toBe('retry_authorized');
    expect(final.attempts[0]!.deploymentId).toBeUndefined();
    // And no manifest records the stale caller's own deployment.
    const manifests = await store.artifacts
      .find({ projectId: f.projectId, name: 'deployment-manifest' })
      .toArray();
    for (const manifest of manifests) {
      expect((manifest.data as { deploymentId: string }).deploymentId).toBe(afterTwo.deploymentId);
    }
  });

  it('cannot replace a deployment an operator adopted for that same attempt', async () => {
    const f = await fixture();
    const releaseId = releaseIdOf(f);
    const first = await attemptOneInFlight(f);
    const publishing = (await receiptOf(releaseId))!;

    // The operator finds the real deployment in the dashboard and adopts it.
    const reader = fakeProvider();
    reader.existing.set('dpl_operator_found', {
      deploymentId: 'dpl_operator_found',
      url: 'https://adopted.vercel.app',
      meta: {
        [RELEASE_METADATA_KEY]: releaseId,
        [RELEASE_COMMIT_METADATA_KEY]: publishing.releaseCommitSha!,
      },
      project: publishing.deploymentTarget.project,
      target: 'production',
    });

    const adopted = await adoptReleaseDeployment(store, reader, {
      projectId: f.projectId,
      releaseId,
      attempt: 1,
      deploymentId: 'dpl_operator_found',
      actor: 'operator:tester',
      reason: 'found in the dashboard',
    });
    expect(adopted.status).toBe('committed');
    expect(adopted.active).toBeUndefined();

    // The original request finally returns its own, different deployment.
    first.open();
    await first.settled;

    const final = (await receiptOf(releaseId))!;
    expect(final.deploymentId).toBe('dpl_operator_found');
    expect(final.deploymentUrl).toBe('https://adopted.vercel.app');
    expect(final.attempt).toBe(1);
    expect(final.committedAt).toEqual(adopted.committedAt);
    // One attempt, still marked adopted, with the operator's evidence intact.
    expect(final.attempts).toHaveLength(1);
    expect(final.attempts[0]!.status).toBe('adopted');
    expect(final.attempts[0]!.resolution).toMatchObject({ actor: 'operator:tester' });
  });
});
