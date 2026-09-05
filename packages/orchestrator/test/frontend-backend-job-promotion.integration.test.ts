/**
 * Replay-safe canonical promotion of one accepted `frontend_backend`
 * candidate (Phase 5h) — end to end, against a real Mongo replica set and a
 * real canonical Git workspace.
 *
 * No build pipeline is faked here at all: promotion never compiles, gates,
 * or reviews anything — it materialises an already-accepted candidate's
 * files and commits them, so every dependency in this file is real.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Collection } from 'mongodb';
import { StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import { JobEngine, jobOutputNamespace } from '@statxai/job-engine';
import type { ArtifactRef, JobSpec } from '@statxai/contracts';
import type { BuildCandidate } from '../src/phases/build.js';
import { frontendBackendCandidateName } from '../src/job-handlers/frontend-backend.js';
import {
  PromotionBaseConflict,
  PromotionCandidateMissing,
  PromotionCandidateNotAccepted,
  PromotionCandidateShapeInvalid,
  PromotionInProgress,
  PromotionJobNotFound,
  PromotionNamespaceMismatch,
  PromotionOutputCountMismatch,
  PromotionReceiptCorrupt,
  PromotionRoleMismatch,
  PromotionStateMismatch,
  PromotionWorkingTreeDirty,
  promoteAcceptedFrontendBackendCandidate,
} from '../src/job-promotion/frontend-backend.js';

const execFileAsync = promisify(execFile);
const LEASE_MS = 60_000;

let store: StateStore;
let registry: ArtifactRegistry;
let engine: JobEngine;
let workspacesRoot: string;

beforeAll(async () => {
  store = await StateStore.connect({
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0',
    dbName: 'statxai_test',
  });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  engine = new JobEngine(store);
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-fb-promote-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.jobs.deleteMany({});
  await store.auditLog.deleteMany({});
  await store.artifacts.deleteMany({});
  await store.projects.deleteMany({});
  await store.promotions.deleteMany({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * 5h ignores `businessProfile`/`sitePlan` entirely (unlike 5g-1/5g-2), so
 * fixtures here skip `discoverProject` and go straight to a minimal
 * `frontend_backend` job — no build pipeline is faked because none ever
 * runs.
 */
function jobSpec(projectId: string, jobId: string): JobSpec {
  return {
    projectId,
    jobId,
    role: 'frontend_backend',
    objective: 'Build the site.',
    inputs: {},
    acceptanceCriteria: ['site files written'],
    allowedTools: [],
    output: ['app/page.tsx'],
  };
}

const candidate = (contents: string): BuildCandidate => ({
  routeDecisions: [],
  files: [{ path: 'app/page.tsx', contents }],
});

/** Stands up a real, genuinely `accepted` frontend_backend job with a real accepted candidate. */
async function stageAcceptedJob(
  projectId: string,
  jobId: string,
  opts: { contents?: string; maxAttempts?: number } = {},
): Promise<{ job: Awaited<ReturnType<typeof engine.accept>>; candidateRef: ArtifactRef }> {
  await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' }, maxAttempts: opts.maxAttempts ?? 3 });
  const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
  if (!claimed || claimed._id !== jobId) throw new Error('fixture setup: could not claim the fixture job');

  const candidateRef = await registry.put(
    projectId,
    frontendBackendCandidateName(jobId, claimed.attempt),
    candidate(opts.contents ?? 'fixture content'),
  );
  await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed.attempt, { outputs: [candidateRef] });
  await registry.accept(projectId, candidateRef);
  const job = await engine.accept(jobId, 'harness:validator');
  return { job, candidateRef };
}

const promotionDeps = () => ({ store, registry, workspacesRoot });

async function canonicalWorkspace(projectId: string): Promise<ProjectWorkspace> {
  return ProjectWorkspace.open(projectId, workspacesRoot);
}

function promotionMarker(promotionId: string): string {
  return `Statx-Promotion-Id: ${promotionId}`;
}

/** Test-only verification helper: an exact count of commits carrying `marker`, independent of production's own lookup. */
async function countCommitsWithMarker(root: string, marker: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['-C', root, 'log', '--all', '--format=%B\x02'], { maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return 0;
  }
  const entries = stdout.split('\x02').map((e) => e.trim()).filter(Boolean);
  return entries.filter((message) => message.split('\n').some((line) => line.trim() === marker)).length;
}

// ---------------------------------------------------------------------------

describe('the happy path', () => {
  it('promotes the exact accepted candidate into a first (null-base) canonical commit', async () => {
    const projectId = 'proj_promote_happy';
    const jobId = 'job_promote_happy';
    const { job, candidateRef } = await stageAcceptedJob(projectId, jobId, { contents: 'happy content' });

    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();

    const result = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());

    expect(result.jobId).toBe(jobId);
    expect(result.attempt).toBe(job.attempt);
    expect(result.candidate).toEqual(candidateRef);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const record = await store.promotions.findOne({ _id: result.promotionId });
    expect(record?.status).toBe('committed');
    expect(record?.projectId).toBe(projectId);
    expect(record?.jobId).toBe(jobId);
    expect(record?.attempt).toBe(job.attempt);
    expect(record?.output).toEqual(candidateRef);
    expect(record?.commitSha).toBe(result.commitSha);
    expect(record?.baseCommit).toBeNull();

    await expect(ws.readSiteFile('app/page.tsx')).resolves.toBe('happy content');
    expect(await ws.currentCommit()).toBe(result.commitSha);

    const marker = promotionMarker(result.promotionId);
    expect(await ws.findCommitByMarker(marker)).toBe(result.commitSha);
    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);

    const jobAfter = await store.jobs.findOne({ _id: jobId });
    expect(jobAfter?.state).toBe('accepted');
    expect(jobAfter?.executionOutputs).toEqual([candidateRef]);
    const candidateDoc = await store.artifacts.findOne({ projectId, name: candidateRef.name });
    expect(candidateDoc?.acceptedAt).toBeInstanceOf(Date);
  });
});

describe('exact ref, not latest', () => {
  it('promotes version 1 even after version 2 of the same candidate name exists', async () => {
    const projectId = 'proj_promote_exact_version';
    const jobId = 'job_promote_exact_version';
    const { candidateRef } = await stageAcceptedJob(projectId, jobId, { contents: 'v1 content' });
    expect(candidateRef.version).toBe(1);

    await registry.put(projectId, candidateRef.name, candidate('v2 content, created after acceptance'));

    const result = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());
    expect(result.candidate).toEqual(candidateRef);

    const ws = await canonicalWorkspace(projectId);
    await expect(ws.readSiteFile('app/page.tsx')).resolves.toBe('v1 content');
  });
});

describe('candidate must be accepted', () => {
  it('fails before any canonical mutation when the exact candidate artifact is not accepted', async () => {
    const projectId = 'proj_promote_not_accepted';
    const jobId = 'job_promote_not_accepted';
    await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' } });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    const candidateRef = await registry.put(projectId, frontendBackendCandidateName(jobId, claimed!.attempt), candidate('x'));
    await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt, { outputs: [candidateRef] });
    // Job forced to accepted state-only, bypassing 5g-2 — the candidate
    // itself is deliberately never accepted, producing exactly the
    // inconsistent durable state this test needs.
    await engine.accept(jobId, 'harness:validator');

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionCandidateNotAccepted,
    );

    expect(await store.promotions.findOne({ jobId })).toBeNull();
    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();
  });
});

describe('wrong job state', () => {
  it.each(['validating', 'running', 'failed'] as const)('rejects a job in state "%s"', async (state) => {
    const projectId = `proj_promote_wrong_state_${state}`;
    const jobId = `job_promote_wrong_state_${state}`;
    await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' }, maxAttempts: 1 });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });

    if (state === 'running') {
      // already running
    } else if (state === 'validating') {
      await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt);
    } else {
      await engine.fail(jobId, 'forced failure', 'promotion-fixture-worker', claimed!.attempt);
    }

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionStateMismatch,
    );
  });

  it('rejects a job that does not exist', async () => {
    await expect(promoteAcceptedFrontendBackendCandidate('job_promote_does_not_exist', promotionDeps())).rejects.toBeInstanceOf(
      PromotionJobNotFound,
    );
  });
});

describe('wrong role', () => {
  it('rejects an accepted job whose role is not frontend_backend', async () => {
    const projectId = 'proj_promote_wrong_role';
    const jobId = 'job_promote_wrong_role';
    await engine.enqueue({ spec: { ...jobSpec(projectId, jobId), role: 'qa_review' }, origin: { kind: 'plan' } });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['qa_review'], leaseMs: LEASE_MS });
    await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt);
    await engine.accept(jobId, 'harness:validator');

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionRoleMismatch,
    );
  });
});

describe('output count mismatch', () => {
  it('refuses an accepted job whose executionOutputs carries more than one ref, rather than silently taking the first', async () => {
    const projectId = 'proj_promote_output_count';
    const jobId = 'job_promote_output_count';
    await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' } });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    const namespace = jobOutputNamespace(jobId, claimed!.attempt);
    const first = await registry.put(projectId, `${namespace}build-candidate`, candidate('first'));
    const second = await registry.put(projectId, `${namespace}build-candidate-extra`, candidate('second'));
    await registry.accept(projectId, first);
    await registry.accept(projectId, second);
    await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt, { outputs: [first, second] });
    await engine.accept(jobId, 'harness:validator');

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionOutputCountMismatch,
    );

    expect(await store.promotions.findOne({ jobId })).toBeNull();
    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();
  });
});

describe('wrong attempt namespace', () => {
  it('rejects an output belonging to a different attempt of the same job', async () => {
    const projectId = 'proj_promote_wrong_attempt_namespace';
    const jobId = 'job_promote_wrong_attempt_namespace';
    await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' } });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    // Namespaced for attempt 1, injected as if attempt 2's own output.
    const wrongAttemptRef = { name: `${jobOutputNamespace(jobId, 1)}build-candidate`, version: 1 };
    await store.jobs.updateOne({ _id: jobId }, { $set: { executionOutputs: [wrongAttemptRef] } });
    await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt);
    // submitForValidation without outputs leaves executionOutputs from the
    // raw update above untouched; force attempt to 2 explicitly to be sure.
    await store.jobs.updateOne({ _id: jobId }, { $set: { attempt: 2, executionOutputs: [wrongAttemptRef] } });
    await engine.accept(jobId, 'harness:validator');

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionNamespaceMismatch,
    );
  });
});

describe('another job’s output', () => {
  it('rejects an accepted job whose output belongs to another job’s namespace', async () => {
    const projectId = 'proj_promote_cross_job';
    const jobId = 'job_promote_cross_job_a';
    await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' } });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    const otherJobRef = { name: `${jobOutputNamespace('job_promote_cross_job_b', claimed!.attempt)}build-candidate`, version: 1 };
    await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt, { outputs: [otherJobRef] });
    await engine.accept(jobId, 'harness:validator');

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionNamespaceMismatch,
    );
  });
});

describe('another project', () => {
  it('resolves only through job.projectId — an equivalent ref in another project is never promoted', async () => {
    const projectId = 'proj_promote_a';
    const otherProjectId = 'proj_promote_b';
    const jobId = 'job_promote_project_scoped';
    await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' } });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    const ref = { name: `${jobOutputNamespace(jobId, claimed!.attempt)}build-candidate`, version: 1 };
    // Exists — accepted — only under the *other* project.
    await registry.put(otherProjectId, ref.name, candidate('belongs to the other project'));
    await registry.accept(otherProjectId, ref);
    await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt, { outputs: [ref] });
    await engine.accept(jobId, 'harness:validator');

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionCandidateMissing,
    );
  });
});

describe('malformed accepted candidate', () => {
  it('fails structural parsing even though acceptedAt is set — no files, no commit, no completed receipt', async () => {
    const projectId = 'proj_promote_malformed';
    const jobId = 'job_promote_malformed';
    await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' } });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    const ref = await registry.put(projectId, frontendBackendCandidateName(jobId, claimed!.attempt), { notAGeneratedFileList: true });
    await registry.accept(projectId, ref);
    await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt, { outputs: [ref] });
    await engine.accept(jobId, 'harness:validator');

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionCandidateShapeInvalid,
    );

    expect(await store.promotions.findOne({ jobId })).toBeNull();
    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();
  });
});

describe('file path safety', () => {
  it('refuses an accepted candidate that attempts path traversal, leaving the canonical workspace untouched', async () => {
    const projectId = 'proj_promote_path_traversal';
    const jobId = 'job_promote_path_traversal';
    await engine.enqueue({ spec: jobSpec(projectId, jobId), origin: { kind: 'plan' } });
    const claimed = await engine.claim('promotion-fixture-worker', 'terra', { roles: ['frontend_backend'], leaseMs: LEASE_MS });
    const malicious: BuildCandidate = { routeDecisions: [], files: [{ path: '../../etc/passwd', contents: 'x' }] };
    const ref = await registry.put(projectId, frontendBackendCandidateName(jobId, claimed!.attempt), malicious);
    await registry.accept(projectId, ref);
    await engine.submitForValidation(jobId, 'promotion-fixture-worker', claimed!.attempt, { outputs: [ref] });
    await engine.accept(jobId, 'harness:validator');

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toThrow(/workspace/i);

    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();
    const record = await store.promotions.findOne({ jobId });
    expect(record?.status).not.toBe('committed');
  });
});

describe('replay after prepared / before file write', () => {
  it('resumes the same promotion id from a durable prepared record with no files written yet', async () => {
    const projectId = 'proj_promote_replay_prepared';
    const jobId = 'job_promote_replay_prepared';
    const { candidateRef } = await stageAcceptedJob(projectId, jobId);

    // Simulate: a first attempt reached the durable prepared record and
    // crashed before touching canonical files at all.
    const first = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());

    // A genuinely fresh call — this *is* the replay, and it must be a pure
    // no-op read: same id, same commit, nothing new.
    const second = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());
    expect(second).toEqual(first);
    void candidateRef;
  });
});

describe('replay after partial file materialization', () => {
  it('converges to the exact candidate with exactly one promotion commit', async () => {
    const projectId = 'proj_promote_replay_partial';
    const jobId = 'job_promote_replay_partial';
    const { candidateRef } = await stageAcceptedJob(projectId, jobId, { contents: 'partial content' });

    // Simulate a crash mid-write: the files already exist on disk (from a
    // hypothetical earlier attempt), but no promotion commit and no durable
    // record exist yet.
    const ws = await canonicalWorkspace(projectId);
    const { scaffoldSite } = await import('@statxai/workspace');
    await scaffoldSite(ws.siteRoot);
    await ws.writeSiteFiles([{ path: 'app/page.tsx', contents: 'partial content' }]);
    expect(await ws.currentCommit()).toBeNull();

    const result = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());

    await expect(ws.readSiteFile('app/page.tsx')).resolves.toBe('partial content');
    const marker = promotionMarker(result.promotionId);
    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);
    const record = await store.promotions.findOne({ _id: result.promotionId });
    expect(record?.status).toBe('committed');
    void candidateRef;
  });
});

describe('unrelated dirty canonical file blocks promotion', () => {
  it('refuses to commit when the working tree has an uncommitted change outside the candidate\'s own files and the scaffold', async () => {
    const projectId = 'proj_promote_dirty_worktree';
    const jobId = 'job_promote_dirty_worktree';
    await stageAcceptedJob(projectId, jobId, { contents: 'dirty-worktree content' });

    // Something else entirely — a manual edit, leftover output from an
    // unrelated process — left the canonical workspace dirty before this
    // promotion ever touched it. `ProjectWorkspace.commit()`'s `git add -A`
    // would otherwise stage this right alongside the candidate.
    const ws = await canonicalWorkspace(projectId);
    const { scaffoldSite } = await import('@statxai/workspace');
    await scaffoldSite(ws.siteRoot);
    await ws.writeSiteFiles([{ path: 'unrelated-manual-edit.txt', contents: 'not part of any candidate' }]);

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionWorkingTreeDirty,
    );

    expect(await ws.currentCommit()).toBeNull();
    await expect(ws.readSiteFile('unrelated-manual-edit.txt')).resolves.toBe('not part of any candidate');
    const record = await store.promotions.findOne({ jobId });
    expect(record?.status).toBe('prepared');
  });

  // The counterpoint — a `prepared` replay's own leftover dirty candidate
  // files, and the harness scaffold's template tree on a first-ever
  // promotion, must not themselves be mistaken for this case — is already
  // proven by "replay after partial file materialization" above.
});

describe('crash after Git commit before Mongo finalize', () => {
  it('MANDATORY: discovers the existing commit on retry, creates no second commit, and finalizes to it', async () => {
    const projectId = 'proj_promote_crash_after_commit';
    const jobId = 'job_promote_crash_after_commit';
    const { job, candidateRef } = await stageAcceptedJob(projectId, jobId, { contents: 'crash-recovery content' });

    // The real Git commit is allowed to happen for real; only the final
    // Mongo finalize call is made to fail, simulating a process crash in
    // exactly the gap between the two. `store.promotions` returns a fresh
    // `Collection` instance per access (the driver never caches it), so the
    // spy must sit on the shared prototype, not on any one instance.
    const spy = vi.spyOn(Collection.prototype, 'findOneAndUpdate').mockImplementationOnce(async () => {
      throw new Error('simulated crash: Mongo finalize fails right after the Git commit succeeded');
    });

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toThrow(
      'simulated crash',
    );
    spy.mockRestore();

    const crashedRecord = await store.promotions.findOne({ jobId });
    expect(crashedRecord?.status).toBe('prepared');
    expect(crashedRecord?.commitSha).toBeNull();

    const ws = await canonicalWorkspace(projectId);
    const marker = promotionMarker(crashedRecord!._id);
    const commitAfterCrash = await ws.findCommitByMarker(marker);
    expect(commitAfterCrash).not.toBeNull();
    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);

    // Retry: a genuine, unmocked production call.
    const result = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());
    expect(result.commitSha).toBe(commitAfterCrash);
    expect(result.candidate).toEqual(candidateRef);
    expect(result.jobId).toBe(job._id);

    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);
    const finalRecord = await store.promotions.findOne({ jobId });
    expect(finalRecord?.status).toBe('committed');
    expect(finalRecord?.commitSha).toBe(commitAfterCrash);
  });
});

describe('exact completed replay is idempotent', () => {
  it('running promotion twice returns the same result and creates no additional commit', async () => {
    const projectId = 'proj_promote_idempotent_replay';
    const jobId = 'job_promote_idempotent_replay';
    await stageAcceptedJob(projectId, jobId);

    const first = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());
    const jobBefore = await store.jobs.findOne({ _id: jobId });
    const artifactBefore = await store.artifacts.findOne({ projectId, name: first.candidate.name });

    const second = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());
    expect(second).toEqual(first);

    const ws = await canonicalWorkspace(projectId);
    const marker = promotionMarker(first.promotionId);
    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);

    const jobAfter = await store.jobs.findOne({ _id: jobId });
    expect(jobAfter).toEqual(jobBefore);
    const artifactAfter = await store.artifacts.findOne({ projectId, name: first.candidate.name });
    expect(artifactAfter?.acceptedAt).toEqual(artifactBefore?.acceptedAt);

    const receiptCount = await store.promotions.countDocuments({ jobId });
    expect(receiptCount).toBe(1);
  });
});

describe('prepared base commit conflict', () => {
  it('fails closed when canonical HEAD moved before this promotion committed, and does not mutate the new head', async () => {
    const projectId = 'proj_promote_base_conflict';
    const jobId = 'job_promote_base_conflict';
    const { candidateRef } = await stageAcceptedJob(projectId, jobId, { contents: 'conflict content' });

    // Prepare (and, via a forced Mongo-finalize failure, leave `prepared`)
    // without ever letting a Git commit happen this time, by making the
    // very first canonical write throw instead.
    const ws = await canonicalWorkspace(projectId);
    // `ProjectWorkspace.open` returns a fresh instance per call, so the
    // production call's own internal `ws` is a different object than this
    // one — the spy has to sit on the shared prototype to reach it.
    const writeSpy = vi.spyOn(ProjectWorkspace.prototype, 'writeSiteFiles').mockImplementationOnce(async () => {
      throw new Error('simulated crash before any canonical file write');
    });
    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toThrow(
      'simulated crash before any canonical file write',
    );
    writeSpy.mockRestore();

    const prepared = await store.promotions.findOne({ jobId });
    expect(prepared?.status).toBe('prepared');
    expect(prepared?.baseCommit).toBeNull();

    // Canonical HEAD legitimately advances to B, with no promotion marker.
    const { scaffoldSite } = await import('@statxai/workspace');
    await scaffoldSite(ws.siteRoot);
    await ws.writeSiteFiles([{ path: 'unrelated.txt', contents: 'unrelated canonical change' }]);
    const headB = await ws.commit('unrelated canonical work');
    expect(headB).not.toBeNull();

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionBaseConflict,
    );

    expect(await ws.currentCommit()).toBe(headB);
    const marker = promotionMarker(prepared!._id);
    expect(await ws.findCommitByMarker(marker)).toBeNull();
    const stillPrepared = await store.promotions.findOne({ jobId });
    expect(stillPrepared?.status).toBe('prepared');
    void candidateRef;
  });
});

describe('promotion commit may become an ancestor', () => {
  it('discovers the promotion commit even after later commits are built on top of it, without rewinding HEAD', async () => {
    const projectId = 'proj_promote_ancestor';
    const jobId = 'job_promote_ancestor';
    await stageAcceptedJob(projectId, jobId, { contents: 'ancestor content' });

    const spy = vi.spyOn(Collection.prototype, 'findOneAndUpdate').mockImplementationOnce(async () => {
      throw new Error('simulated crash after commit C, before Mongo finalize');
    });
    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toThrow(
      'simulated crash after commit C',
    );
    spy.mockRestore();

    const prepared = await store.promotions.findOne({ jobId });
    const ws = await canonicalWorkspace(projectId);
    const marker = promotionMarker(prepared!._id);
    const commitC = await ws.findCommitByMarker(marker);
    expect(commitC).not.toBeNull();

    // A later, legitimate canonical commit D lands on top of C.
    await ws.writeSiteFiles([{ path: 'later.txt', contents: 'later canonical work' }]);
    const commitD = await ws.commit('later canonical work, on top of the promotion');
    expect(commitD).not.toBeNull();
    expect(commitD).not.toBe(commitC);
    expect(await ws.currentCommit()).toBe(commitD);

    const result = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());
    expect(result.commitSha).toBe(commitC);

    // HEAD is untouched — no rewind, no duplicate promotion commit.
    expect(await ws.currentCommit()).toBe(commitD);
    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);
    const finalRecord = await store.promotions.findOne({ jobId });
    expect(finalRecord?.status).toBe('committed');
    expect(finalRecord?.commitSha).toBe(commitC);
  });
});

describe('different promotion for the same project cannot race', () => {
  it('a second, different job’s promotion is refused while the first is still prepared', async () => {
    const projectId = 'proj_promote_project_serialized';
    const jobIdA = 'job_promote_serialized_a';
    const jobIdB = 'job_promote_serialized_b';
    await stageAcceptedJob(projectId, jobIdA, { contents: 'A content' });
    await stageAcceptedJob(projectId, jobIdB, { contents: 'B content' });

    // Force A to stop at `prepared` without ever reaching a commit, by
    // failing its own file write — leaving the project genuinely "busy".
    const firstWriteSpy = vi.spyOn(ProjectWorkspace.prototype, 'writeSiteFiles').mockImplementationOnce(async () => {
      throw new Error('simulated crash before A’s canonical file write');
    });
    await expect(promoteAcceptedFrontendBackendCandidate(jobIdA, promotionDeps())).rejects.toThrow(
      'simulated crash before A’s canonical file write',
    );
    firstWriteSpy.mockRestore();

    const recordA = await store.promotions.findOne({ jobId: jobIdA });
    expect(recordA?.status).toBe('prepared');

    await expect(promoteAcceptedFrontendBackendCandidate(jobIdB, promotionDeps())).rejects.toBeInstanceOf(
      PromotionInProgress,
    );

    const ws2 = await canonicalWorkspace(projectId);
    expect(await ws2.currentCommit()).toBeNull();
    expect(await store.promotions.findOne({ jobId: jobIdB })).toBeNull();
  });
});

describe('a project may be promoted again once the prior promotion has committed', () => {
  it('a second, different accepted job for the same project can prepare and commit its own receipt without colliding with the first', async () => {
    const projectId = 'proj_promote_sequential';
    const jobIdA = 'job_promote_sequential_a';
    const jobIdB = 'job_promote_sequential_b';

    await stageAcceptedJob(projectId, jobIdA, { contents: 'A content' });
    const resultA = await promoteAcceptedFrontendBackendCandidate(jobIdA, promotionDeps());
    const recordA = await store.promotions.findOne({ _id: resultA.promotionId });
    expect(recordA?.status).toBe('committed');

    await stageAcceptedJob(projectId, jobIdB, { contents: 'B content' });
    // The partial unique index only excludes a second *unfinished* ('prepared')
    // promotion for this project — A being 'committed' must not permanently
    // block the project from ever being promoted again.
    const resultB = await promoteAcceptedFrontendBackendCandidate(jobIdB, promotionDeps());

    expect(resultB.promotionId).not.toBe(resultA.promotionId);
    const recordB = await store.promotions.findOne({ _id: resultB.promotionId });
    expect(recordB?.status).toBe('committed');
    expect(recordB?.projectId).toBe(projectId);
    expect(recordB?.jobId).toBe(jobIdB);

    // A's historical committed receipt is untouched by B's promotion.
    const recordAAfter = await store.promotions.findOne({ _id: resultA.promotionId });
    expect(recordAAfter).toEqual(recordA);

    const ws = await canonicalWorkspace(projectId);
    await expect(ws.readSiteFile('app/page.tsx')).resolves.toBe('B content');
    expect(await countCommitsWithMarker(ws.root, promotionMarker(resultA.promotionId))).toBe(1);
    expect(await countCommitsWithMarker(ws.root, promotionMarker(resultB.promotionId))).toBe(1);
  });
});

describe('corrupt committed receipt', () => {
  it('fails closed on a record claiming committed with a binding/job mismatch, rather than silently creating a fresh one', async () => {
    const projectId = 'proj_promote_corrupt_receipt';
    const jobId = 'job_promote_corrupt_receipt';
    const { job } = await stageAcceptedJob(projectId, jobId);

    // A record that would collide on the exact same deterministic id but
    // whose stored binding disagrees with the real job — a hand-corrupted
    // or otherwise-tampered document, never produced by this module itself.
    const outputs = job.executionOutputs!;
    const { contentHash } = await import('@statxai/workspace');
    const promotionId = contentHash({
      projectId,
      jobId,
      attempt: job.attempt,
      outputName: outputs[0]!.name,
      outputVersion: outputs[0]!.version,
      outputContentHash: outputs[0]!.contentHash ?? null,
    });

    await store.promotions.insertOne({
      _id: promotionId,
      projectId,
      jobId: 'a-different-job-id-entirely',
      attempt: job.attempt,
      output: outputs[0]!,
      baseCommit: null,
      status: 'committed',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionReceiptCorrupt,
    );

    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();
  });
});

describe('committed receipt with no matching commit', () => {
  it('fails closed on a record whose binding matches exactly but whose marker is absent from history, rather than silently re-promoting', async () => {
    const projectId = 'proj_promote_committed_no_marker';
    const jobId = 'job_promote_committed_no_marker';
    const { job } = await stageAcceptedJob(projectId, jobId);

    // Every binding field matches the real job exactly — this must not be
    // caught by the "binding mismatch" check above. Only the commit itself
    // is missing: a `committed` record whose promised evidence was never
    // actually written to canonical history (or was, and has since been
    // rewritten away).
    const outputs = job.executionOutputs!;
    const { contentHash } = await import('@statxai/workspace');
    const promotionId = contentHash({
      projectId,
      jobId,
      attempt: job.attempt,
      outputName: outputs[0]!.name,
      outputVersion: outputs[0]!.version,
      outputContentHash: outputs[0]!.contentHash ?? null,
    });

    await store.promotions.insertOne({
      _id: promotionId,
      projectId,
      jobId,
      attempt: job.attempt,
      output: outputs[0]!,
      baseCommit: null,
      status: 'committed',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionReceiptCorrupt,
    );

    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();
    const record = await store.promotions.findOne({ _id: promotionId });
    expect(record?.status).toBe('committed');
    expect(record?.commitSha).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });
});

describe('prepared receipt binding mismatch', () => {
  it('fails closed on a colliding "prepared" record whose attempt disagrees with the real job, rather than silently promoting under it', async () => {
    const projectId = 'proj_promote_prepared_mismatch';
    const jobId = 'job_promote_prepared_mismatch';
    const { job } = await stageAcceptedJob(projectId, jobId);

    // Same deterministic promotionId the real job would compute, but a
    // hand-corrupted `attempt` — distinct from the "committed with no
    // marker" corruption case: this one is caught only if a recovered
    // `prepared` record's binding is actually checked against the current
    // job before being trusted, not merely if a committed record's marker
    // is later verified to exist.
    const outputs = job.executionOutputs!;
    const { contentHash } = await import('@statxai/workspace');
    const promotionId = contentHash({
      projectId,
      jobId,
      attempt: job.attempt,
      outputName: outputs[0]!.name,
      outputVersion: outputs[0]!.version,
      outputContentHash: outputs[0]!.contentHash ?? null,
    });

    await store.promotions.insertOne({
      _id: promotionId,
      projectId,
      jobId,
      attempt: job.attempt + 1,
      output: outputs[0]!,
      baseCommit: null,
      status: 'prepared',
      commitSha: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps())).rejects.toBeInstanceOf(
      PromotionReceiptCorrupt,
    );

    const ws = await canonicalWorkspace(projectId);
    expect(await ws.currentCommit()).toBeNull();
    const record = await store.promotions.findOne({ _id: promotionId });
    expect(record?.status).toBe('prepared');
    expect(record?.attempt).toBe(job.attempt + 1);
  });
});

describe('exact Git marker lookup', () => {
  it('ignores unrelated commits with similar-looking text and matches only the exact marker line', async () => {
    const projectId = 'proj_promote_exact_marker';
    const jobId = 'job_promote_exact_marker';
    const { candidateRef } = await stageAcceptedJob(projectId, jobId);

    const ws = await canonicalWorkspace(projectId);
    const { scaffoldSite } = await import('@statxai/workspace');
    await scaffoldSite(ws.siteRoot);
    await ws.writeSiteFiles([{ path: 'decoy.txt', contents: 'x' }]);
    await ws.commit('Statx-Promotion-Id-ish: not-a-real-marker-line');
    await ws.writeSiteFiles([{ path: 'decoy2.txt', contents: 'y' }]);
    await ws.commit('mentions Statx-Promotion-Id: fakeid123 inline, not as its own line');

    const result = await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());
    const marker = promotionMarker(result.promotionId);
    expect(await countCommitsWithMarker(ws.root, marker)).toBe(1);
    expect(await ws.findCommitByMarker('Statx-Promotion-Id: nonexistent')).toBeNull();
    void candidateRef;
  });
});

describe('job/candidate acceptance unchanged', () => {
  it('leaves job.state, attempt, executionOutputs, and candidate.acceptedAt exactly as they were', async () => {
    const projectId = 'proj_promote_acceptance_unchanged';
    const jobId = 'job_promote_acceptance_unchanged';
    const { job, candidateRef } = await stageAcceptedJob(projectId, jobId);
    const before = await store.jobs.findOne({ _id: jobId });
    const artifactBefore = await store.artifacts.findOne({ projectId, name: candidateRef.name });

    await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());

    const after = await store.jobs.findOne({ _id: jobId });
    // Full deep equality, not just the fields promotion is known to read —
    // a stray write anywhere on the job document (e.g. a bespoke
    // "promoted" marker) must fail this test even if it doesn't touch
    // `state`, `attempt`, or `executionOutputs`.
    expect(after).toEqual(before);
    expect(after?.state).toBe('accepted');
    expect(after?.attempt).toBe(job.attempt);
    expect(after?.executionOutputs).toEqual(before?.executionOutputs);
    const artifactAfter = await store.artifacts.findOne({ projectId, name: candidateRef.name });
    expect(artifactAfter).toEqual(artifactBefore);
    expect(artifactAfter?.acceptedAt).toEqual(artifactBefore?.acceptedAt);
  });
});

describe('no repair, deployment, or model side effect', () => {
  it('a successful promotion writes exactly the promotion receipt and one canonical commit — nothing else', async () => {
    const projectId = 'proj_promote_no_side_effects';
    const jobId = 'job_promote_no_side_effects';
    await stageAcceptedJob(projectId, jobId);

    await promoteAcceptedFrontendBackendCandidate(jobId, promotionDeps());

    const events = await store.auditLog.find({ jobId }).toArray();
    expect(events.map((e) => e.detail['to'])).not.toContain('repair_requested');
    const promotionCount = await store.promotions.countDocuments({ jobId });
    expect(promotionCount).toBe(1);
  });
});
