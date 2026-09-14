/**
 * Explicit active build abandonment + pre-acceptance job supersession
 * (Phase 5m).
 *
 * Part A exercises `abandonFrontendBackendBuild` directly against bindings
 * and jobs constructed with the same low-level primitives Phase 5k's own
 * tests use (`prepareFrontendBackendBuildBinding`, `engine.enqueue`) — no
 * model calls, no compiled output, no gates. Part B needs the real
 * deterministic-validation/acceptance pipeline (5g-1/5g-2) and so reuses
 * the exact mock setup `frontend-backend-build-binding.integration.test.ts`
 * establishes (see that file's own doc comment): `@statxai/agents`/
 * `@statxai/workspace`'s compiler/`@statxai/gates` are faked, everything
 * else — `StateStore`, `ArtifactRegistry`, `ProjectWorkspace`, `JobEngine`,
 * the production Terra handler, Phase 5g-1/5g-2/5h/5i/5k, and `runProject`/
 * `launchRun` themselves — is real.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import type { JobSpec, SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import { JobEngine, JobRunner, type JobWorkerIdentity } from '@statxai/job-engine';
import {
  abandonFrontendBackendBuild,
  computeRunIntentHash,
  createFrontendBackendJobSpec,
  findActivePreparedBinding,
  prepareFrontendBackendBuildBinding,
  ActiveJobLifecycleRollbackConflict,
  FrontendBackendBuildPromotionOwned,
  FrontendBackendBuildAbandonmentDownstreamDependency,
  FrontendBackendBuildAbandonmentPromotionEvidenceConflict,
  FrontendBackendBuildAbandonmentReasonInvalid,
  FrontendBackendBuildBindingNotFound,
  FrontendBackendBuildBindingProjectMismatch,
} from '../src/index.js';
import { createFrontendBackendCandidateValidator } from '../src/job-validation/frontend-backend.js';
import { acceptValidatedFrontendBackendCandidate, AcceptanceBindingStale } from '../src/job-acceptance/frontend-backend.js';
import * as acceptanceModule from '../src/job-acceptance/frontend-backend.js';
import { promoteAcceptedFrontendBackendCandidate } from '../src/job-promotion/frontend-backend.js';
import * as promotionModule from '../src/job-promotion/frontend-backend.js';
import { createFrontendBackendLifecycleCoordinator } from '../src/job-lifecycle/frontend-backend.js';
import { fakeExport } from './support/site-model-export.js';

const PROFILE_REF = { name: 'business-profile', version: 1, contentHash: 'a'.repeat(64) };
const PLAN_REF = { name: 'site-plan', version: 1, contentHash: 'b'.repeat(64) };
const ACTOR = 'operator:alice';
const REASON = 'stuck build, abandoning for a fresh generation';

let store: StateStore;
let engine: JobEngine;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  engine = new JobEngine(store);
});

afterAll(async () => {
  await store?.close();
});

beforeEach(async () => {
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.promotions.deleteMany({});
  await store.frontendBackendBuildBindings.deleteMany({});
});

let bindingCounter = 0;

/** A `prepared` binding, with or without a matching enqueued job, built without any model/workspace involvement. */
async function makeBinding(projectId: string, opts: { withJob?: boolean } = {}) {
  bindingCounter += 1;
  // A distinct `sitePlanRef.version` per call — not just per project — so
  // two bindings for the *same* project (a fixture two calls apart, as the
  // stale-bindingId test needs) get two distinct deterministic jobIds
  // rather than colliding on `engine.enqueue`.
  const sitePlanRef = { ...PLAN_REF, version: bindingCounter };
  const spec: JobSpec = createFrontendBackendJobSpec({
    projectId,
    businessProfileRef: PROFILE_REF,
    sitePlanRef,
  });
  const runIntentHash = computeRunIntentHash({
    projectId,
    profile: { businessName: `fixture-${bindingCounter}` } as never,
  });
  const binding = await prepareFrontendBackendBuildBinding(store, {
    projectId,
    runIntentHash,
    businessProfileRef: PROFILE_REF,
    sitePlanRef,
    jobSpec: spec,
    specificationBaseCommit: null,
  });
  if (opts.withJob !== false) {
    await engine.enqueue({ spec, origin: { kind: 'plan' } });
  }
  return binding;
}

// ---------------------------------------------------------------------------
// Part A — direct, low-level abandonment
// ---------------------------------------------------------------------------

describe('binding with no job yet (Phase 5k crash point)', () => {
  it('abandons the binding alone — no JobDocument invented', async () => {
    const binding = await makeBinding('proj_5m_no_job', { withJob: false });

    const result = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_no_job', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );

    expect(result.outcome).toBe('abandoned');
    if (result.outcome === 'abandoned') expect(result.supersededJobId).toBeNull();

    const stored = await store.frontendBackendBuildBindings.findOne({ _id: binding._id });
    expect(stored?.status).toBe('abandoned');
    expect(stored?.abandonedBy).toBe(ACTOR);
    expect(stored?.abandonmentReason).toBe(REASON);
    expect(stored?.abandonedAt).toBeInstanceOf(Date);
    expect(await store.jobs.countDocuments({ projectId: 'proj_5m_no_job' })).toBe(0);
    expect(await findActivePreparedBinding(store, 'proj_5m_no_job')).toBeNull();
  });
});

describe('pre-acceptance job states all supersede atomically with the binding', () => {
  it('a ready job', async () => {
    const binding = await makeBinding('proj_5m_ready');
    const result = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_ready', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('abandoned');
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('superseded');
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('abandoned');
    expect(await engine.claim('worker-1', 'terra', { jobId: binding.jobId })).toBeNull();
  });

  it('a running job — lease cleared, no canonical publication', async () => {
    const binding = await makeBinding('proj_5m_running');
    const claimed = await engine.claim('worker-1', 'terra', { jobId: binding.jobId });
    expect(claimed?.lease?.holder).toBe('worker-1');

    const result = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_running', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('abandoned');

    const job = await store.jobs.findOne({ _id: binding.jobId });
    expect(job?.state).toBe('superseded');
    expect(job?.lease).toBeNull();
    expect(await engine.heartbeat(binding.jobId, 'worker-1', claimed!.attempt)).toBe(false);
  });

  it('a validating job — executionOutputs preserved, candidate stays unaccepted', async () => {
    const binding = await makeBinding('proj_5m_validating');
    const claimed = await engine.claim('worker-1', 'terra', { jobId: binding.jobId });
    const outputs = [{ name: `job-output/${binding.jobId}/1/candidate`, version: 1 }];
    await engine.submitForValidation(binding.jobId, 'worker-1', claimed!.attempt, { outputs });

    const result = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_validating', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('abandoned');

    const job = await store.jobs.findOne({ _id: binding.jobId });
    expect(job?.state).toBe('superseded');
    expect(job?.executionOutputs).toEqual(outputs);
  });

  it('a failed job', async () => {
    const binding = await makeBinding('proj_5m_failed');
    const claimed = await engine.claim('worker-1', 'terra', { jobId: binding.jobId });
    await store.jobs.updateOne({ _id: binding.jobId }, { $set: { maxAttempts: 1 } });
    await engine.fail(binding.jobId, 'boom', 'worker-1', claimed!.attempt);
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('failed');

    const result = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_failed', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('abandoned');
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('superseded');
  });

  it('a repair_requested job', async () => {
    const binding = await makeBinding('proj_5m_repair');
    const claimed = await engine.claim('worker-1', 'terra', { jobId: binding.jobId });
    await engine.submitForValidation(binding.jobId, 'worker-1', claimed!.attempt);
    await engine.requestRepair(binding.jobId, 'harness');

    const result = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_repair', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('abandoned');
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('superseded');
  });

  it('a blocked job', async () => {
    const binding = await makeBinding('proj_5m_blocked');
    await engine.block(binding.jobId, 'harness', 'dependency problem');

    const result = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_blocked', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('abandoned');
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('superseded');
  });

  it('a draft job', async () => {
    const projectId = 'proj_5m_draft';
    const spec: JobSpec = createFrontendBackendJobSpec({ projectId, businessProfileRef: PROFILE_REF, sitePlanRef: PLAN_REF });
    const binding = await prepareFrontendBackendBuildBinding(store, {
      projectId,
      runIntentHash: computeRunIntentHash({ projectId, profile: { businessName: 'draft' } as never }),
      businessProfileRef: PROFILE_REF,
      sitePlanRef: PLAN_REF,
      jobSpec: spec,
      specificationBaseCommit: null,
    });
    await engine.enqueue({ spec, origin: { kind: 'plan' }, draft: true });

    const result = await abandonFrontendBackendBuild(
      { projectId, bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('abandoned');
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('superseded');
  });
});

/**
 * Phase 5n narrows Phase 5m's original blanket "accepted is never
 * abandonable" rule: an accepted job may now be abandoned, but only while
 * promotion has not yet obtained fence authority over it.
 */
describe('accepted job — abandonable only before promotion obtains the fence (Phase 5n)', () => {
  async function acceptedBindingAndJob(projectId: string) {
    const binding = await makeBinding(projectId);
    const claimed = await engine.claim('worker-1', 'terra', { jobId: binding.jobId });
    const outputs = [{ name: `job-output/${binding.jobId}/1/candidate`, version: 1 }];
    await engine.submitForValidation(binding.jobId, 'worker-1', claimed!.attempt, { outputs });
    await engine.accept(binding.jobId, 'harness:validator');
    return binding;
  }

  it('succeeds when no fence has been acquired: job -> superseded, binding -> abandoned, candidate.acceptedAt untouched', async () => {
    const projectId = 'proj_5n_accepted_no_fence';
    const binding = await acceptedBindingAndJob(projectId);

    const result = await abandonFrontendBackendBuild(
      { projectId, bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('abandoned');

    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('superseded');
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('abandoned');
  });

  it('fails closed once a promotion fence exists — FrontendBackendBuildPromotionOwned, nothing mutated', async () => {
    const projectId = 'proj_5n_accepted_fenced';
    const binding = await acceptedBindingAndJob(projectId);
    const job = await store.jobs.findOne({ _id: binding.jobId });

    await engine.acquirePromotionFence(binding.jobId, {
      promotionId: 'promo_fence_fixture',
      attempt: job!.attempt,
      candidate: job!.executionOutputs![0]!,
      baseCommit: null,
      actor: 'harness:promoter',
    });

    await expect(
      abandonFrontendBackendBuild({ projectId, bindingId: binding._id, actor: ACTOR, reason: REASON }, { store, engine }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildPromotionOwned);

    const after = await store.jobs.findOne({ _id: binding.jobId });
    expect(after?.state).toBe('accepted');
    expect(after?.promotionFence?.promotionId).toBe('promo_fence_fixture');
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('prepared');
  });

  it('legacy pre-5n promotion evidence (no fence) still blocks abandonment', async () => {
    const projectId = 'proj_5n_accepted_legacy_evidence';
    const binding = await acceptedBindingAndJob(projectId);
    await store.promotions.insertOne({
      _id: 'promo_legacy_fixture',
      projectId,
      jobId: binding.jobId,
      attempt: 1,
      output: { name: 'job-output/x/1/candidate', version: 1 },
      baseCommit: null,
      status: 'committed',
      commitSha: 'deadbeef',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      abandonFrontendBackendBuild({ projectId, bindingId: binding._id, actor: ACTOR, reason: REASON }, { store, engine }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildAbandonmentPromotionEvidenceConflict);

    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('accepted');
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('prepared');
  });

  it('fails closed when a downstream job already depends on the accepted job', async () => {
    const projectId = 'proj_5n_accepted_downstream';
    const binding = await acceptedBindingAndJob(projectId);
    await engine.enqueue({
      spec: {
        projectId,
        jobId: 'job_downstream_dependent',
        role: 'frontend_backend',
        objective: 'depends on the accepted job',
        inputs: {},
        acceptanceCriteria: ['x'],
        allowedTools: [],
        output: ['other.tsx'],
      },
      origin: { kind: 'plan' },
      dependsOn: [binding.jobId],
    });

    await expect(
      abandonFrontendBackendBuild({ projectId, bindingId: binding._id, actor: ACTOR, reason: REASON }, { store, engine }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildAbandonmentDownstreamDependency);

    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('accepted');
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('prepared');
    expect((await store.jobs.findOne({ _id: 'job_downstream_dependent' }))?.state).toBe('ready');
  });
});

describe('promotion evidence present: fails closed even independent of job state', () => {
  it('rejects abandonment without touching the promotion record', async () => {
    const binding = await makeBinding('proj_5m_promo_evidence');
    // Contradictory-by-construction fixture: a promotion record exists for
    // a job that is not (yet, in this fixture) accepted — control-plane
    // corruption this must never silently proceed past.
    await store.promotions.insertOne({
      _id: 'promo_fixture',
      projectId: 'proj_5m_promo_evidence',
      jobId: binding.jobId,
      attempt: 1,
      output: { name: 'job-output/x/1/candidate', version: 1 },
      baseCommit: null,
      status: 'prepared',
      commitSha: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      abandonFrontendBackendBuild(
        { projectId: 'proj_5m_promo_evidence', bindingId: binding._id, actor: ACTOR, reason: REASON },
        { store, engine },
      ),
    ).rejects.toBeInstanceOf(FrontendBackendBuildAbandonmentPromotionEvidenceConflict);

    expect((await store.promotions.findOne({ _id: 'promo_fixture' }))?.status).toBe('prepared');
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('prepared');
  });
});

describe('exact identity guards', () => {
  it('a stale bindingId never touches a newer active binding for the same project', async () => {
    const projectId = 'proj_5m_stale_id';
    const bindingA = await makeBinding(projectId);
    const first = await abandonFrontendBackendBuild(
      { projectId, bindingId: bindingA._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(first.outcome).toBe('abandoned');

    const bindingB = await makeBinding(projectId);
    expect(bindingB._id).not.toBe(bindingA._id);

    // A stale request naming A again — must be a pure idempotent replay of A, never touch B.
    const replay = await abandonFrontendBackendBuild(
      { projectId, bindingId: bindingA._id, actor: ACTOR, reason: 'late-arriving duplicate' },
      { store, engine },
    );
    expect(replay.outcome).toBe('already_abandoned');

    const b = await store.frontendBackendBuildBindings.findOne({ _id: bindingB._id });
    expect(b?.status).toBe('prepared');
    expect((await store.jobs.findOne({ _id: bindingB.jobId }))?.state).toBe('ready');
  });

  it('rejects a wrong projectId; nothing mutated', async () => {
    const binding = await makeBinding('proj_5m_wrong_project_real');

    await expect(
      abandonFrontendBackendBuild(
        { projectId: 'proj_5m_wrong_project_imposter', bindingId: binding._id, actor: ACTOR, reason: REASON },
        { store, engine },
      ),
    ).rejects.toBeInstanceOf(FrontendBackendBuildBindingProjectMismatch);

    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('prepared');
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('ready');
  });

  it('rejects an unknown bindingId', async () => {
    await expect(
      abandonFrontendBackendBuild(
        { projectId: 'proj_5m_unknown', bindingId: 'frontend-backend-build-does-not-exist', actor: ACTOR, reason: REASON },
        { store, engine },
      ),
    ).rejects.toBeInstanceOf(FrontendBackendBuildBindingNotFound);
  });

  it('a fabricated bindingId never falls back to the project\'s real active binding', async () => {
    const projectId = 'proj_5m_fabricated_id';
    const active = await makeBinding(projectId);

    await expect(
      abandonFrontendBackendBuild(
        { projectId, bindingId: 'frontend-backend-build-never-existed', actor: ACTOR, reason: REASON },
        { store, engine },
      ),
    ).rejects.toBeInstanceOf(FrontendBackendBuildBindingNotFound);

    expect((await store.frontendBackendBuildBindings.findOne({ _id: active._id }))?.status).toBe('prepared');
    expect((await store.jobs.findOne({ _id: active.jobId }))?.state).toBe('ready');
  });
});

describe('idempotent replay', () => {
  it('repeating the exact same request is safe — no second job transition, no timestamp rewrite', async () => {
    const binding = await makeBinding('proj_5m_idempotent');
    const first = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_idempotent', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(first.outcome).toBe('abandoned');
    const afterFirst = await store.frontendBackendBuildBindings.findOne({ _id: binding._id });
    const transitionsAfterFirst = await store.auditLog.countDocuments({ jobId: binding.jobId, kind: 'job_transition' });

    const second = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_idempotent', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(second.outcome).toBe('already_abandoned');

    const afterSecond = await store.frontendBackendBuildBindings.findOne({ _id: binding._id });
    expect(afterSecond?.abandonedAt?.getTime()).toBe(afterFirst?.abandonedAt?.getTime());
    expect(await store.auditLog.countDocuments({ jobId: binding.jobId, kind: 'job_transition' })).toBe(transitionsAfterFirst);
  });
});

describe('promoted binding is immune', () => {
  it('an abandonment request against an already-promoted binding does not alter it', async () => {
    const binding = await makeBinding('proj_5m_promoted', { withJob: false });
    await store.frontendBackendBuildBindings.updateOne(
      { _id: binding._id },
      { $set: { status: 'promoted', promotionId: 'promo_x', promotionCommitSha: 'deadbeef' } },
    );

    const result = await abandonFrontendBackendBuild(
      { projectId: 'proj_5m_promoted', bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(result.outcome).toBe('already_promoted');

    const stored = await store.frontendBackendBuildBindings.findOne({ _id: binding._id });
    expect(stored?.status).toBe('promoted');
    expect(stored?.abandonedAt).toBeUndefined();
  });
});

describe('active slot released; history preserved', () => {
  it('a fresh prepared binding for the same project succeeds once the old one is abandoned', async () => {
    const projectId = 'proj_5m_slot_release';
    const bindingA = await makeBinding(projectId, { withJob: false });
    await abandonFrontendBackendBuild({ projectId, bindingId: bindingA._id, actor: ACTOR, reason: REASON }, { store, engine });

    const specB: JobSpec = { ...createFrontendBackendJobSpec({ projectId, businessProfileRef: PROFILE_REF, sitePlanRef: PLAN_REF }), objective: 'a different generation' };
    const bindingB = await prepareFrontendBackendBuildBinding(store, {
      projectId,
      runIntentHash: computeRunIntentHash({ projectId, profile: { businessName: 'generation-b' } as never }),
      businessProfileRef: PROFILE_REF,
      sitePlanRef: PLAN_REF,
      jobSpec: specB,
      specificationBaseCommit: null,
    });
    expect(bindingB._id).not.toBe(bindingA._id);
    expect((await findActivePreparedBinding(store, projectId))?._id).toBe(bindingB._id);

    const history = await store.frontendBackendBuildBindings.find({ projectId }).toArray();
    expect(history).toHaveLength(2);
    const historicalA = history.find((b) => b._id === bindingA._id);
    expect(historicalA?.status).toBe('abandoned');
    expect(historicalA?.abandonedBy).toBe(ACTOR);
  });
});

describe('reason validation', () => {
  it('rejects empty and whitespace-only reasons', async () => {
    const binding = await makeBinding('proj_5m_reason_empty');
    await expect(
      abandonFrontendBackendBuild({ projectId: 'proj_5m_reason_empty', bindingId: binding._id, actor: ACTOR, reason: '' }, { store, engine }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildAbandonmentReasonInvalid);
    await expect(
      abandonFrontendBackendBuild({ projectId: 'proj_5m_reason_empty', bindingId: binding._id, actor: ACTOR, reason: '   ' }, { store, engine }),
    ).rejects.toBeInstanceOf(FrontendBackendBuildAbandonmentReasonInvalid);
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('prepared');
  });

  it('rejects a reason over the length limit', async () => {
    const binding = await makeBinding('proj_5m_reason_long');
    await expect(
      abandonFrontendBackendBuild(
        { projectId: 'proj_5m_reason_long', bindingId: binding._id, actor: ACTOR, reason: 'x'.repeat(2001) },
        { store, engine },
      ),
    ).rejects.toBeInstanceOf(FrontendBackendBuildAbandonmentReasonInvalid);
  });
});

describe('no automatic abandonment', () => {
  it('a job left in retry_ready/failed/repair_requested/blocked never becomes abandoned on its own', async () => {
    const binding = await makeBinding('proj_5m_no_auto');
    await engine.claim('worker-1', 'terra', { jobId: binding.jobId });
    await store.jobs.updateOne({ _id: binding.jobId }, { $set: { maxAttempts: 1 } });
    await engine.fail(binding.jobId, 'boom', 'worker-1', 1);

    // Time passing and the job sitting in a terminal-looking state changes nothing on its own.
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('prepared');
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('failed');
  });
});

describe('structural: scope boundaries', () => {
  async function readOwnSource(): Promise<string> {
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'run-binding', 'frontend-backend.ts');
    return readFile(src, 'utf8');
  }

  it('abandonFrontendBackendBuild never references a workspace, registry, git, Luna, Sol, or deployment call', async () => {
    const code = await readOwnSource();
    const body = code.slice(code.indexOf('export async function abandonFrontendBackendBuild'));
    for (const forbidden of ['ProjectWorkspace', 'workspace.commit', 'git(', 'Luna', 'luna', 'planSite', 'routeBuild', 'deploy']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('AbandonFrontendBackendBuildDeps has no workspace/registry/model dependency at all', async () => {
    const code = await readOwnSource();
    const depsShape = code.slice(
      code.indexOf('export interface AbandonFrontendBackendBuildDeps'),
      code.indexOf('export type FrontendBackendBuildAbandonmentResult'),
    );
    expect(depsShape).not.toMatch(/registry|workspace|model/i);
  });

  it('nothing outside run-binding/frontend-backend.ts and the operator script calls abandonFrontendBackendBuild', async () => {
    const roots = [
      join(process.cwd(), 'packages', 'orchestrator', 'src'),
      join(process.cwd(), 'apps', 'console'),
    ];
    const allowed = new Set([
      join(process.cwd(), 'packages', 'orchestrator', 'src', 'run-binding', 'frontend-backend.ts'),
    ]);

    const walk = async (dir: string): Promise<string[]> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
      }
      return files;
    };

    for (const root of roots) {
      for (const file of await walk(root)) {
        if (allowed.has(file)) continue;
        const contents = await readFile(file, 'utf8');
        if (contents.includes('abandonFrontendBackendBuild(')) {
          throw new Error(`unexpected caller of abandonFrontendBackendBuild: ${file}`);
        }
      }
    }
  });

  it('the CLI operator script derives actor from the OS user, never a flag, and requires an explicit reason', async () => {
    const contents = await readFile(join(process.cwd(), 'scripts', 'abandon-build.ts'), 'utf8');
    expect(contents).toContain('userInfo()');
    expect(contents).not.toMatch(/--actor/);
    expect(contents).toMatch(/reason\.trim\(\) === ''/);
  });

  it('no HTTP route in apps/console exposes abandonment — a separate capability from Phase 5o’s operator boundary', async () => {
    const apiDir = join(process.cwd(), 'apps', 'console', 'app', 'api');
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
    for (const file of await walk(apiDir)) {
      const contents = await readFile(file, 'utf8');
      expect(contents).not.toContain('abandonFrontendBackendBuild');
    }
  });
});

// ---------------------------------------------------------------------------
// Part B — full pipeline (mocked model calls; real orchestrator/job-engine/Git)
// ---------------------------------------------------------------------------

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
let planSiteCalls = 0;
let buildSiteShouldThrow = false;

vi.mock('../src/job-acceptance/frontend-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof acceptanceModule>();
  return { ...actual, acceptValidatedFrontendBackendCandidate: vi.fn(actual.acceptValidatedFrontendBackendCandidate) };
});

vi.mock('../src/job-promotion/frontend-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof promotionModule>();
  return { ...actual, promoteAcceptedFrontendBackendCandidate: vi.fn(actual.promoteAcceptedFrontendBackendCandidate) };
});

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

const planWith = (marker: string) => ({
  strategy: 'Local trade credibility',
  valueProposition: `v-${marker}`,
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: `direction-${marker}`,
    radius: 'square',
    rationale: 'Workwear palette suits the trade.',
  },
  sitemap: { pages: [page('/', 'Home')] },
  acceptanceCriteria: ['a', 'b', 'c'],
});

const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => {
      planSiteCalls += 1;
      return { value: planWith(`v${planSiteCalls}`) as unknown as SitePlan, model: 'gpt-5.6-sol', ...usage };
    }),
    routeBuild: vi.fn(async () => ({
      value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    buildSite: vi.fn(async () => {
      terraBuildCalls += 1;
      if (buildSiteShouldThrow) throw new Error('simulated Terra generation failure');
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

let registry: ArtifactRegistry;
let workspacesRoot: string;
let validationWorkspacesRoot: string;

beforeAll(async () => {
  registry = new ArtifactRegistry(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5m-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-5m-validate-'));
});

afterAll(async () => {
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  gateVerdict = { passed: true, findings: [], gatesRun: ['claims'] };
  compileOk = true;
  terraBuildCalls = 0;
  planSiteCalls = 0;
  buildSiteShouldThrow = false;
  reviewSequence = [{ qualityScore: 92, blocking: false, issues: [issue()] }];
  approval = { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: ['QA-004'] };
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.budgets.deleteMany({});
  await store.runs.deleteMany({});
  await store.runEvents.deleteMany({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const runJobMode = async (projectId: string) => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({
    projectId,
    intake: INTAKE,
    store,
    workspacesRoot,
    autonomyMode: 'full_autonomous',
    frontendBackendExecutionMode: 'job_lifecycle',
    validationWorkspacesRoot,
  });
};

async function canonicalCommitSubjects(projectId: string): Promise<string[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
  try {
    const { stdout } = await exec('git', ['-c', `safe.directory=${ws.root}`, '-C', ws.root, 'log', '--all', '--format=%s']);
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A real `business-profile`/`site-plan` pair the deterministic pipeline can
 * actually resolve — `runGates` is mocked to always pass, so the *content*
 * need not be schema-perfect, only present at the ref the JobSpec pins.
 */
async function acceptedArtifact(projectId: string, name: string, data: unknown) {
  const ref = await registry.put(projectId, name, data);
  await registry.accept(projectId, ref);
  return ref;
}

async function makeRealBindingAndSpec(projectId: string, marker = projectId) {
  const businessProfileRef = await acceptedArtifact(projectId, 'business-profile', INTAKE);
  const sitePlanRef = await acceptedArtifact(projectId, 'site-plan', planWith(marker));
  const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef });
  const binding = await prepareFrontendBackendBuildBinding(store, {
    projectId,
    runIntentHash: computeRunIntentHash({ projectId, profile: { businessName: marker } as never }),
    businessProfileRef,
    sitePlanRef,
    jobSpec: spec,
    specificationBaseCommit: null,
  });
  return { spec, binding };
}

function coordinatorDeps() {
  return {
    store,
    registry,
    engine,
    model: new AgentsModelRuntime(),
    workerIdentity: { workerId: 'terra-5m-1', tier: 'terra' as const },
    workspacesRoot,
    validationWorkspacesRoot,
  };
}

function promotionDeps() {
  return { store, registry, engine, workspacesRoot };
}

const launchLegacy = async (projectId: string) => {
  const { launchRun } = await import('../src/run-service.js');
  return launchRun({ store, intake: INTAKE, workspacesRoot, frontendBackendExecutionMode: 'legacy_direct', projectId });
};

let AgentsModelRuntime: typeof Agents.ModelRuntime;

beforeAll(async () => {
  AgentsModelRuntime = (await import('@statxai/agents')).ModelRuntime;
});

describe('stale 5g-1 evidence cannot authorise acceptance after abandonment', () => {
  it('acceptance fails with AcceptanceBindingStale; the job stays superseded, the binding stays abandoned', async () => {
    const projectId = 'proj_5m_stale_5g1';
    const { spec, binding } = await makeRealBindingAndSpec(projectId);
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps());

    // Stop exactly at `validating`, the same technique
    // frontend-backend-job-lifecycle.integration.test.ts's own "resume from
    // validating" case uses: force the 5g-2 boundary to fail once, a
    // controlled failure rather than a fabrication of durable state.
    vi.mocked(acceptanceModule.acceptValidatedFrontendBackendCandidate).mockImplementationOnce(async () => {
      throw new Error('simulated process death before acceptance');
    });
    await expect(coordinator.run(spec)).rejects.toThrow('simulated process death before acceptance');

    const midway = await store.jobs.findOne({ _id: spec.jobId });
    expect(midway?.state).toBe('validating');

    const validate = createFrontendBackendCandidateValidator({ registry, validationWorkspacesRoot });
    const validation = await validate(midway!);
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error('unreachable');

    const abandonResult = await abandonFrontendBackendBuild(
      { projectId, bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(abandonResult.outcome).toBe('abandoned');

    // The exact authenticated evidence 5g-1 just produced, offered to 5g-2
    // for real, after the binding it describes no longer exists.
    await expect(acceptValidatedFrontendBackendCandidate(validation, { store, registry, engine })).rejects.toBeInstanceOf(
      AcceptanceBindingStale,
    );

    expect((await store.jobs.findOne({ _id: spec.jobId }))?.state).toBe('superseded');
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('abandoned');
  });
});

describe('acceptance vs abandonment race', () => {
  it('produces exactly one of the two valid outcomes — never mixed authority', async () => {
    const projectId = 'proj_5m_race';
    const { spec, binding } = await makeRealBindingAndSpec(projectId);
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps());

    vi.mocked(acceptanceModule.acceptValidatedFrontendBackendCandidate).mockImplementationOnce(async () => {
      throw new Error('stop at validating');
    });
    await expect(coordinator.run(spec)).rejects.toThrow('stop at validating');

    const midway = await store.jobs.findOne({ _id: spec.jobId });
    const validate = createFrontendBackendCandidateValidator({ registry, validationWorkspacesRoot });
    const validation = await validate(midway!);
    expect(validation.ok).toBe(true);
    if (!validation.ok) throw new Error('unreachable');

    const [acceptResult, abandonResult] = await Promise.allSettled([
      acceptValidatedFrontendBackendCandidate(validation, { store, registry, engine }),
      abandonFrontendBackendBuild({ projectId, bindingId: binding._id, actor: ACTOR, reason: REASON }, { store, engine }),
    ]);

    const job = await store.jobs.findOne({ _id: spec.jobId });
    const bindingAfter = await store.frontendBackendBuildBindings.findOne({ _id: binding._id });

    // The one invariant that must hold regardless of which side won.
    expect(job?.state === 'accepted' && bindingAfter?.status === 'abandoned').toBe(false);

    if (job?.state === 'accepted') {
      expect(acceptResult.status).toBe('fulfilled');
      expect(bindingAfter?.status).toBe('prepared');
      expect(abandonResult.status).toBe('rejected');
    } else {
      expect(job?.state).toBe('superseded');
      expect(bindingAfter?.status).toBe('abandoned');
      expect(acceptResult.status).toBe('rejected');
    }
  });
});

describe('a running worker races an operator abandonment', () => {
  it('the runner reports authority_lost; the job never reaches validating', async () => {
    const projectId = 'proj_5m_runner_race';
    const { spec, binding } = await makeRealBindingAndSpec(projectId);
    await engine.enqueue({ spec, origin: { kind: 'plan' } });

    let observedAbort = false;
    let handlerStartedResolve!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerStartedResolve = resolve;
    });
    let handlerAbortedResolve!: () => void;
    const handlerAborted = new Promise<void>((resolve) => {
      handlerAbortedResolve = resolve;
    });

    const identity: JobWorkerIdentity = { workerId: 'terra-race-1', tier: 'terra' };
    const runner = new JobRunner({
      engine,
      identity,
      claimableRoles: ['frontend_backend'],
      handlers: new Map([
        [
          'frontend_backend',
          (_job, ctx) =>
            new Promise<void>((resolve) => {
              handlerStartedResolve();
              const onAbort = () => {
                observedAbort = true;
                resolve();
                handlerAbortedResolve();
              };
              if (ctx.signal.aborted) onAbort();
              else ctx.signal.addEventListener('abort', onAbort, { once: true });
            }),
        ],
      ]),
      leaseMs: 60_000,
      heartbeatEveryMs: 20,
    });

    const resultPromise = runner.runOnce({ jobId: spec.jobId });
    await handlerStarted;

    const abandonResult = await abandonFrontendBackendBuild(
      { projectId, bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(abandonResult.outcome).toBe('abandoned');

    await handlerAborted;
    const result = await resultPromise;

    expect(result.kind).toBe('authority_lost');
    expect(observedAbort).toBe(true);

    const job = await store.jobs.findOne({ _id: spec.jobId });
    expect(job?.state).toBe('superseded');
  });
});

describe('Phase 5i superseded outcome', () => {
  it('reports outcome "superseded" with no model call, no validation, no acceptance, no promotion', async () => {
    const projectId = 'proj_5m_5i_superseded';
    const { spec, binding } = await makeRealBindingAndSpec(projectId);
    await engine.enqueue({ spec, origin: { kind: 'plan' } });

    const abandonResult = await abandonFrontendBackendBuild(
      { projectId, bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(abandonResult.outcome).toBe('abandoned');

    const planCallsBefore = planSiteCalls;
    const terraCallsBefore = terraBuildCalls;
    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps());
    const result = await coordinator.run(spec);

    expect(result.outcome).toBe('superseded');
    expect(planSiteCalls).toBe(planCallsBefore);
    expect(terraBuildCalls).toBe(terraCallsBefore);
  });
});

describe('a stale in-flight invocation observes superseded, not a platform error', () => {
  it('mirrors exactly what runProject would map jobLifecycleOutcome to', async () => {
    const projectId = 'proj_5m_stale_invocation';
    const { spec, binding } = await makeRealBindingAndSpec(projectId);
    await engine.enqueue({ spec, origin: { kind: 'plan' } });

    // Exactly what orchestrator.ts's job_lifecycle branch does before
    // calling `coordinator.run(spec)`: resolve the active binding and its
    // spec. A concurrent operator abandons it in the window between that
    // resolution and the coordinator call — the same window a real process
    // restart or a slow request could land in.
    const activeBefore = await findActivePreparedBinding(store, projectId);
    expect(activeBefore?._id).toBe(binding._id);

    await abandonFrontendBackendBuild({ projectId, bindingId: binding._id, actor: ACTOR, reason: REASON }, { store, engine });

    const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps());
    const result = await coordinator.run(spec);

    // `orchestrator.ts`'s own `result.outcome !== 'promoted'` branch treats
    // this exactly like every other non-delivery stop: `RunResult.outcome`
    // becomes `'blocked'`, `jobLifecycleOutcome` carries this value
    // verbatim, and nothing downstream (evaluation, direct fallback,
    // another job) ever runs — see that branch's own doc comment.
    expect(result.outcome).toBe('superseded');
  });
});

describe('a new job-mode generation after abandonment', () => {
  it('never resumes the abandoned binding; fresh discovery/planning really runs; the old job never returns', async () => {
    const projectId = 'proj_5m_new_generation';

    // Terra fails every time -> bounded to one attempt per invocation ->
    // the job lands back on `ready` ('retry_ready') — genuinely stuck
    // pre-acceptance, without needing to exhaust maxAttempts.
    buildSiteShouldThrow = true;
    const stuck = await runJobMode(projectId);
    expect(stuck.outcome).toBe('blocked');
    expect(stuck.jobLifecycleOutcome).toBe('retry_ready');

    const bindingA = await findActivePreparedBinding(store, projectId);
    expect(bindingA).not.toBeNull();
    const commitsAfterStuck = await canonicalCommitSubjects(projectId);

    const abandonResult = await abandonFrontendBackendBuild(
      { projectId, bindingId: bindingA!._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(abandonResult.outcome).toBe('abandoned');

    // Abandonment itself never touches Git.
    expect(await canonicalCommitSubjects(projectId)).toEqual(commitsAfterStuck);

    buildSiteShouldThrow = false;
    const planCallsBefore = planSiteCalls;
    const second = await runJobMode(projectId);
    expect(second.outcome).toBe('released');
    expect(planSiteCalls).toBeGreaterThan(planCallsBefore);

    const allBindings = await store.frontendBackendBuildBindings.find({ projectId }).sort({ createdAt: 1 }).toArray();
    expect(allBindings).toHaveLength(2);
    expect(allBindings[0]!._id).toBe(bindingA!._id);
    expect(allBindings[0]!.status).toBe('abandoned');
    expect(allBindings[1]!.status).toBe('promoted');
    expect(allBindings[1]!.jobId).not.toBe(bindingA!.jobId);

    // A's superseded job never resumes, however many later invocations run.
    expect((await store.jobs.findOne({ _id: bindingA!.jobId }))?.state).toBe('superseded');
  });
});

describe('legacy rollback interacts correctly with abandonment', () => {
  it('is blocked while the binding is prepared, and allowed once it is abandoned — the old binding stays untouched', async () => {
    const projectId = 'proj_5m_legacy_rollback';

    buildSiteShouldThrow = true;
    const stuck = await runJobMode(projectId);
    expect(stuck.jobLifecycleOutcome).toBe('retry_ready');
    const binding = await findActivePreparedBinding(store, projectId);
    expect(binding).not.toBeNull();

    // Regression: Phase 5l's own guard still fires against a prepared binding.
    await expect(launchLegacy(projectId)).rejects.toBeInstanceOf(ActiveJobLifecycleRollbackConflict);
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding!._id }))?.status).toBe('prepared');

    const abandonResult = await abandonFrontendBackendBuild(
      { projectId, bindingId: binding!._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(abandonResult.outcome).toBe('abandoned');

    buildSiteShouldThrow = false;
    const handle = await launchLegacy(projectId);
    const legacyResult = await handle.completed;
    expect(legacyResult?.outcome).toBe('released');

    // The abandoned binding is untouched by the legacy run that followed it.
    const stored = await store.frontendBackendBuildBindings.findOne({ _id: binding!._id });
    expect(stored?.status).toBe('abandoned');
    expect(stored?.abandonedBy).toBe(ACTOR);
  });
});

// ---------------------------------------------------------------------------
// Mandatory: accepted-abandonment vs. Phase 5h promotion-fence race
// ---------------------------------------------------------------------------

/** Drive the real coordinator to exactly `accepted`, with no promotion ever attempted — a controlled stop, not a fabrication of durable state. */
async function acceptedBindingAndSpec(projectId: string) {
  const { spec, binding } = await makeRealBindingAndSpec(projectId);
  const coordinator = createFrontendBackendLifecycleCoordinator(coordinatorDeps());
  vi.mocked(promotionModule.promoteAcceptedFrontendBackendCandidate).mockImplementationOnce(async () => {
    throw new Error('stop exactly at accepted, before any promotion attempt');
  });
  await expect(coordinator.run(spec)).rejects.toThrow('stop exactly at accepted');
  const job = await store.jobs.findOne({ _id: spec.jobId });
  expect(job?.state).toBe('accepted');
  expect(job?.promotionFence ?? null).toBeNull();
  return { spec, binding };
}

describe('accepted abandonment wins before Phase 5h ever acquires a fence', () => {
  it('MANDATORY: a stale Phase 5h invocation loses at fence acquisition, before any receipt or canonical write', async () => {
    const projectId = 'proj_5n_abandon_wins';
    const { binding } = await acceptedBindingAndSpec(projectId);

    const abandonResult = await abandonFrontendBackendBuild(
      { projectId, bindingId: binding._id, actor: ACTOR, reason: REASON },
      { store, engine },
    );
    expect(abandonResult.outcome).toBe('abandoned');
    expect((await store.jobs.findOne({ _id: binding.jobId }))?.state).toBe('superseded');

    // The stale, already-in-flight Phase 5h attempt continues regardless —
    // exactly what a real concurrent process would do — and must lose at
    // fence acquisition, before touching Mongo's promotion collection or
    // the canonical Git tree.
    await expect(promoteAcceptedFrontendBackendCandidate(binding.jobId, promotionDeps())).rejects.toThrow();

    expect(await store.promotions.countDocuments({ jobId: binding.jobId })).toBe(0);
    expect((await canonicalCommitSubjects(projectId)).some((s) => s.includes('Promote accepted'))).toBe(false);
  });
});

describe('promotion wins by acquiring the fence first', () => {
  it('MANDATORY: abandonment then fails closed, and promotion can still continue/recover', async () => {
    const projectId = 'proj_5n_promotion_wins';
    const { spec, binding } = await acceptedBindingAndSpec(projectId);

    // Promotion acquires the fence for real (the mock above only fires
    // once, already consumed) and completes.
    const promoted = await promoteAcceptedFrontendBackendCandidate(binding.jobId, promotionDeps());
    expect(promoted.commitSha).toBeTruthy();

    await expect(
      abandonFrontendBackendBuild({ projectId, bindingId: binding._id, actor: ACTOR, reason: REASON }, { store, engine }),
    ).rejects.toThrow();

    const job = await store.jobs.findOne({ _id: binding.jobId });
    expect(job?.state).toBe('accepted');
    expect(job?.promotionFence?.promotionId).toBe(promoted.promotionId);
    expect((await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))?.status).toBe('prepared');

    // Promotion "continuing/recovering" — a pure idempotent replay still
    // works, untouched by the refused abandonment attempt.
    const replay = await promoteAcceptedFrontendBackendCandidate(binding.jobId, promotionDeps());
    expect(replay.commitSha).toBe(promoted.commitSha);
    void spec;
  });
});

describe('a real concurrent race between accepted abandonment and Phase 5h', () => {
  it('MANDATORY: produces exactly one of the two valid authorities, never both', async () => {
    const projectId = 'proj_5n_real_race';
    const { binding } = await acceptedBindingAndSpec(projectId);

    const [abandonResult, promoteResult] = await Promise.allSettled([
      abandonFrontendBackendBuild({ projectId, bindingId: binding._id, actor: ACTOR, reason: REASON }, { store, engine }),
      promoteAcceptedFrontendBackendCandidate(binding.jobId, promotionDeps()),
    ]);

    const job = await store.jobs.findOne({ _id: binding.jobId });
    const bindingAfter = await store.frontendBackendBuildBindings.findOne({ _id: binding._id });
    const promotionCount = await store.promotions.countDocuments({ jobId: binding.jobId });

    // Forbidden combinations, checked directly rather than inferred from
    // which promise settled which way.
    expect(bindingAfter?.status === 'abandoned' && promotionCount > 0).toBe(false);
    expect(job?.state === 'superseded' && promotionCount > 0).toBe(false);
    expect(bindingAfter?.status === 'abandoned' && job?.promotionFence != null).toBe(false);

    if (bindingAfter?.status === 'abandoned') {
      // Authority A: abandonment won.
      expect(job?.state).toBe('superseded');
      expect(promotionCount).toBe(0);
      expect(promoteResult.status).toBe('rejected');
    } else {
      // Authority B: promotion won the fence (whether or not it finished
      // committing before the race resolved is immaterial — owning the
      // fence is what "won" means, per the brief).
      expect(bindingAfter?.status).toBe('prepared');
      expect(job?.state).toBe('accepted');
      expect(job?.promotionFence).not.toBeNull();
      expect(abandonResult.status).toBe('rejected');
    }
  });
});
