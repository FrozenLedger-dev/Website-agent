/**
 * Release publication bound to the exact canonical build lineage.
 *
 * Phase 5q needs to go from a project's active build lineage to that lineage's
 * one release publication — in any status, including `committed` after the
 * project's active publication slot is gone — without ordering receipts by time.
 * A receipt used to name only a project and an authorisation version, so a
 * historical committed release and the current lineage's committed release
 * were indistinguishable.
 *
 * Most cases call the publication module directly against real Mongo, which is
 * exact and fast. Two drive the real `runProject` (agents, compiler, gates and
 * the Vercel calls faked; everything else real) to prove the linkage is
 * threaded from the run's own canonical build, and that `legacy_direct` still
 * publishes without inventing one.
 *
 * Integration: needs the Mongo replica set and a real (temp) filesystem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Agents from '@statxai/agents';
import type * as Gates from '@statxai/gates';
import type * as Workspace from '@statxai/workspace';
import type { ArtifactRef, SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import type { ReleaseBuildAuthority, ReleasePublicationDocument } from '@statxai/state';
import {
  FrontendBackendBuildNotPublishable,
  deriveActiveLineageTip,
  finalizeBindingPromoted,
  findActiveLineageRoot,
  loadReleaseBuildAuthority,
  prepareFrontendBackendBuildBinding,
} from '../src/run-binding/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../src/job-specs/frontend-backend.js';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import type { ReleaseAuthorization } from '@statxai/policy-engine';
import type { RunContext } from '../src/run-context.js';
import { publishRelease } from '../src/phases/publish.js';
import {
  ReleasePublicationBindingConflict,
  ReleasePublicationCanonicalBuildMismatch,
  ReleasePublicationConflict,
  ReleasePublicationLineageConflict,
  adoptReleaseDeployment,
  assertReceiptMatchesCanonicalBuild,
  authorizeReleaseRepublication,
  beginPublicationAttempt,
  computeReleaseId,
  ensureReleasePublicationPrepared,
  findReleasePublicationForLineage,
  recordPublicationSuccess,
  resolveDeploymentTarget,
} from '../src/release-publication/publication.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// ---------------------------------------------------------------------------
// End-to-end rig (mirrors the active-lineage suite, plus a fake Vercel)
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

let deployments = 0;

const issue = (): ReviewIssue => ({
  id: 'QA-004',
  category: 'accessibility',
  severity: 'P2',
  location: 'index.html',
  reason: 'Focus indicator relies on an undefined custom property.',
  acceptanceTest: 'Focus is visible on every control.',
  recommendedAction: 'targeted_repair',
  evidence: [],
});

const P0 = {
  strategy: 'Local trade credibility',
  valueProposition: 'Fitted joinery, made and installed by the same two people.',
  brandSystem: {
    palette: { background: '#F4F1E8', surface: '#FFF', text: '#17212B', muted: '#DCE2E5', accent: '#F2B705', accentText: '#17212B', border: '#C8D2D6' },
    typography: { headingFamily: 'Fraunces', bodyFamily: 'Inter Tight', baseSize: '18px', scale: '1.25' },
    artDirection: 'Trade-signage directness.',
    radius: 'square',
    rationale: 'Workwear palette suits the trade.',
  },
  sitemap: {
    pages: [
      { route: '/', title: 'Home', metaDescription: 'd', goal: 'g', primaryAction: 'call', sections: [{ id: 's1', heading: 'H', purpose: 'p', layout: 'split-hero', contentBindings: ['services'] }] },
    ],
  },
  acceptanceCriteria: ['a', 'b', 'c'],
} as unknown as SitePlan;

const usage = { inputTokens: 10, outputTokens: 5, ms: 1 };

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    planSite: vi.fn(async () => ({ value: P0, model: 'gpt-5.6-sol', ...usage })),
    routeBuild: vi.fn(async () => ({
      value: { action: 'one_shot', reason: 'small site', confidence: 0.9, workstreams: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    buildSite: vi.fn(async () => ({
      value: { files: [{ path: 'app/page.tsx', contents: 'export default function P(){return 1}' }], notes: '' },
      model: 'gpt-5.6-terra',
      ...usage,
    })),
    reviewSite: vi.fn(async () => ({
      value: { decision: 'accept', qualityScore: 92, blocking: false, issues: [issue()], summary: 's' },
      model: 'gpt-5.6-terra',
      ...usage,
    })),
    recommendApproval: vi.fn(async () => ({
      value: { recommendation: 'accept', reason: 'Nothing blocking remains.', acknowledgedIssues: ['QA-004'] },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    adjudicate: vi.fn(async () => ({
      value: { action: 'block', reason: 'unused', defectIds: null, objective: null, scope: null },
      model: 'gpt-5.6-sol',
      ...usage,
    })),
    replanSite: vi.fn(async () => {
      throw new Error('replan not expected in this suite');
    }),
  };
});

vi.mock('@statxai/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof Workspace>();
  return {
    ...actual,
    scaffoldSite: vi.fn(actual.scaffoldSite),
    buildSite: vi.fn(async () => ({ ok: true, durationMs: 5, output: '', outDir: '/out' })),
    readBuiltFiles: vi.fn(async () => [
      { path: 'index.html', contents: '<!doctype html><html lang="en"><head><title>T</title></head><body><main><h1>Harrowgate Joinery</h1></main></body></html>' },
    ]),
    readExportFiles: vi.fn(async () => []),
    readSourceFiles: vi.fn(async () => [{ path: 'app/page.tsx', contents: 'x' }]),
    // A configured deployment is what gives a release a receipt at all.
    deploymentConfigured: vi.fn(() => true),
    deploySite: vi.fn(async (_root: string, projectId: string, options: { meta?: Record<string, string> }) => {
      deployments += 1;
      return {
        url: `https://${projectId}-${deployments}.vercel.app`,
        deploymentId: `dpl_e2e_${deployments}`,
        rollbackRef: null,
        fileCount: 1,
        durationMs: 1,
        meta: { ...(options.meta ?? {}) },
      };
    }),
  };
});

vi.mock('@statxai/gates', async (importOriginal) => {
  const actual = await importOriginal<typeof Gates>();
  return { ...actual, runGates: vi.fn(() => ({ passed: true, findings: [], gatesRun: ['claims'] })) };
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
  workspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-rel-lineage-canonical-'));
  validationWorkspacesRoot = await mkdtemp(join(tmpdir(), 'statxai-rel-lineage-validate-'));
});

afterAll(async () => {
  await store?.close();
  if (workspacesRoot) await rm(workspacesRoot, { recursive: true, force: true });
  if (validationWorkspacesRoot) await rm(validationWorkspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  deployments = 0;
  for (const c of [store.jobs, store.auditLog, store.artifacts, store.projects, store.budgets, store.defectBudgets, store.promotions]) {
    await (c as { deleteMany: (f: object) => Promise<unknown> }).deleteMany({});
  }
  await store.frontendBackendBuildBindings.deleteMany({});
  await store.releasePublications.deleteMany({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const run = async (projectId: string, mode: 'job_lifecycle' | 'legacy_direct') => {
  const { runProject } = await import('../src/orchestrator.js');
  return runProject({
    projectId,
    intake: INTAKE,
    store,
    workspacesRoot,
    autonomyMode: 'full_autonomous',
    frontendBackendExecutionMode: mode,
    validationWorkspacesRoot,
  });
};

// ---------------------------------------------------------------------------
// Direct helpers
// ---------------------------------------------------------------------------

const ref = (name: string, version: number): ArtifactRef => ({ name, version });
const authRef = (version: number): ArtifactRef => ({ name: 'release-authorization', version });

const prepare = async (projectId: string, marker: number, predecessor?: string) => {
  const businessProfileRef = ref('business-profile', 1);
  const sitePlanRef = ref('site-plan', marker);
  const jobSpec = createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef });
  return prepareFrontendBackendBuildBinding(store, {
    projectId,
    runIntentHash: `intent-${marker}`,
    businessProfileRef,
    sitePlanRef,
    jobSpec,
    specificationBaseCommit: null,
    ...(predecessor ? { lineage: { predecessorBindingId: predecessor, replanDecisionRef: ref('replan-decision', marker) } } : {}),
  });
};

const promote = (bindingId: string, n: number) =>
  finalizeBindingPromoted(store, bindingId, { promotionId: `promo-${bindingId.slice(-6)}-${n}`, promotionCommitSha: String(n).repeat(40).slice(0, 40) });

/** A promoted root build, returning its exact publishable authority. */
const promotedRoot = async (projectId: string, marker = 1): Promise<ReleaseBuildAuthority> => {
  const b0 = await prepare(projectId, marker);
  await promote(b0._id, marker);
  return loadReleaseBuildAuthority(store, projectId, b0._id);
};

const prepareReceipt = (projectId: string, version: number, buildAuthority?: ReleaseBuildAuthority) =>
  ensureReleasePublicationPrepared(store, {
    releaseId: computeReleaseId({ projectId, releaseAuthorization: authRef(version) }),
    projectId,
    releaseAuthorization: authRef(version),
    baseCommit: null,
    deploymentTarget: resolveDeploymentTarget(projectId),
    ...(buildAuthority ? { buildAuthority } : {}),
  });

/** Take a prepared receipt all the way to `committed`. */
const commitReceipt = async (receipt: ReleasePublicationDocument) => {
  const publishing = await beginPublicationAttempt(store, receipt, { releaseCommitSha: null });
  return recordPublicationSuccess(store, {
    releaseId: receipt._id,
    attempt: publishing.attempt,
    deploymentId: `dpl_${receipt._id.slice(0, 6)}`,
    deploymentUrl: 'https://example.vercel.app',
  });
};

const reload = (id: string) => store.releasePublications.findOne({ _id: id });

// ---------------------------------------------------------------------------

describe('threading from a real run', () => {
  it('a job_lifecycle release records the exact lineage root, canonical binding and promotion', async () => {
    const projectId = 'proj_rel_lineage_e2e';
    const result = await run(projectId, 'job_lifecycle');
    expect(result.outcome).toBe('released');

    const [binding] = await store.frontendBackendBuildBindings.find({ projectId }).toArray();
    const receipts = await store.releasePublications.find({ projectId }).toArray();
    expect(receipts).toHaveLength(1);

    // All three, together, and exactly the run's own promoted build.
    expect(receipts[0]!.buildAuthority).toEqual({
      lineageRootBindingId: binding!._id,
      canonicalBindingId: binding!._id,
      promotionId: binding!.promotionId,
    });
    expect(binding!.promotionId).toEqual(expect.any(String));
    expect(receipts[0]!.status).toBe('committed');
  });

  it('a legacy_direct release still publishes, with no build authority invented', async () => {
    const projectId = 'proj_rel_lineage_legacy';
    const result = await run(projectId, 'legacy_direct');
    expect(result.outcome).toBe('released');

    const receipts = await store.releasePublications.find({ projectId }).toArray();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.status).toBe('committed');
    expect('buildAuthority' in receipts[0]!).toBe(false);
  });
});

describe('publishable build authority', () => {
  it('is read from the exact promoted binding, root and all', async () => {
    const projectId = 'proj_rel_auth_chain';
    const b0 = await prepare(projectId, 1);
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, 2, b0._id);
    await promote(b1._id, 2);

    const authority = await loadReleaseBuildAuthority(store, projectId, b1._id);
    expect(authority.lineageRootBindingId).toBe(b0._id);
    expect(authority.canonicalBindingId).toBe(b1._id);
    expect(authority.promotionId).toBe((await store.frontendBackendBuildBindings.findOne({ _id: b1._id }))!.promotionId);
  });

  it('is never manufactured from a build that is not promoted, or predates lineage identity', async () => {
    const projectId = 'proj_rel_auth_refused';
    const b0 = await prepare(projectId, 1);
    await expect(loadReleaseBuildAuthority(store, projectId, b0._id)).rejects.toBeInstanceOf(FrontendBackendBuildNotPublishable);

    await promote(b0._id, 1);
    await expect(loadReleaseBuildAuthority(store, 'proj_someone_else', b0._id)).rejects.toBeInstanceOf(FrontendBackendBuildNotPublishable);

    await store.frontendBackendBuildBindings.updateOne({ _id: b0._id }, { $unset: { lineageRootBindingId: '' } });
    await expect(loadReleaseBuildAuthority(store, projectId, b0._id)).rejects.toBeInstanceOf(FrontendBackendBuildNotPublishable);
  });
});

describe('receipt build authority', () => {
  it('persists all three values together, and refuses a partial one', async () => {
    const projectId = 'proj_rel_whole';
    const authority = await promotedRoot(projectId);
    const receipt = await prepareReceipt(projectId, 1, authority);

    expect((await reload(receipt._id))!.buildAuthority).toEqual(authority);

    await expect(
      prepareReceipt(projectId, 2, { lineageRootBindingId: 'root', canonicalBindingId: '', promotionId: 'p' }),
    ).rejects.toBeInstanceOf(ReleasePublicationBindingConflict);
  });

  it('leaves releaseId byte-for-byte unchanged', () => {
    // Captured from the unmodified code before build authority existed.
    expect(
      computeReleaseId({ projectId: 'proj_pinned_release', releaseAuthorization: { name: 'release-authorization', version: 3, contentHash: 'a'.repeat(64) } }),
    ).toBe('0c9c750cf150ffa4953778fc4b16cfd90c7abdad1add0d4207fb71b191c8448a');
    expect(
      computeReleaseId({ projectId: 'proj_pinned_release', releaseAuthorization: { name: 'release-authorization', version: 3 } }),
    ).toBe('9a84aee826494a18e454047ae65041053d8234d99b890cca5be17107a1472cff');
  });

  it('exact linked replay converges on the one receipt', async () => {
    const projectId = 'proj_rel_replay';
    const authority = await promotedRoot(projectId);
    const first = await prepareReceipt(projectId, 1, authority);
    const again = await prepareReceipt(projectId, 1, { ...authority });

    expect(again._id).toBe(first._id);
    expect(await store.releasePublications.countDocuments({ projectId })).toBe(1);
  });

  it.each([
    ['lineage root', { lineageRootBindingId: 'frontend-backend-build-other' }],
    ['canonical binding', { canonicalBindingId: 'frontend-backend-build-other' }],
    ['promotion', { promotionId: 'promo-other' }],
  ])('the same releaseId with a different %s fails closed, and the receipt is not rewritten', async (_label, change) => {
    const projectId = `proj_rel_mismatch_${Object.keys(change)[0]}`;
    const authority = await promotedRoot(projectId);
    const receipt = await prepareReceipt(projectId, 1, authority);

    await expect(prepareReceipt(projectId, 1, { ...authority, ...change })).rejects.toBeInstanceOf(ReleasePublicationBindingConflict);
    expect((await reload(receipt._id))!.buildAuthority).toEqual(authority);
  });

  it('a linked receipt replayed without build authority fails closed', async () => {
    const projectId = 'proj_rel_presence_dropped';
    const receipt = await prepareReceipt(projectId, 1, await promotedRoot(projectId));

    await expect(prepareReceipt(projectId, 1)).rejects.toBeInstanceOf(ReleasePublicationBindingConflict);
    expect((await reload(receipt._id))!.buildAuthority).toBeDefined();
  });

  it('a committed linked receipt is not replayed by a publish that presents different build authority', async () => {
    const projectId = 'proj_rel_committed_replay_guard';
    const authority = await promotedRoot(projectId);
    const receipt = await commitReceipt(await prepareReceipt(projectId, 1, authority));

    const workspace = await ProjectWorkspace.open(projectId, workspacesRoot);
    const ctx = {
      deps: { store, registry: new ArtifactRegistry(store), workspace, model: {} as never, say: () => {} },
      facts: { projectId, profile: { businessName: 'Acme' } as never, autonomyMode: 'full_autonomous' as const, budgetLimits: {} as never },
      progress: { qualityScore: 91, gatesCertified: ['build'], approvalModel: 'm', approvalArtifactVersion: 1, approvalDecision: 'accept' as const } as never,
    } as unknown as RunContext;
    const authorization = { authorized: true, action: 'release', reason: 'r', policyVersion: 'p@1' } as ReleaseAuthorization;

    // A caller that no longer names the build this receipt was published for —
    // the committed short-circuit must not finalize it on the releaseId alone.
    await expect(
      publishRelease(ctx, authorization, { releaseAuthorizationRef: authRef(1) }),
    ).rejects.toBeInstanceOf(ReleasePublicationBindingConflict);

    expect(deployments).toBe(0);
    expect(await store.artifacts.countDocuments({ projectId, name: 'deployment-manifest' })).toBe(0);
    expect((await reload(receipt._id))!.buildAuthority).toEqual(authority);
  });

  it('an unlinked historical receipt is never upgraded to a linked one', async () => {
    const projectId = 'proj_rel_presence_added';
    const receipt = await prepareReceipt(projectId, 1);

    await expect(prepareReceipt(projectId, 1, await promotedRoot(projectId))).rejects.toBeInstanceOf(ReleasePublicationBindingConflict);
    expect('buildAuthority' in (await reload(receipt._id))!).toBe(false);
  });
});

describe('one release per build lineage', () => {
  it('a second, different release for the same lineage is refused as a lineage conflict', async () => {
    const projectId = 'proj_rel_second';
    const authority = await promotedRoot(projectId);
    await prepareReceipt(projectId, 1, authority);

    // The first is still unfinished, so both indexes refuse — and the permanent
    // fact is the one reported, not the temporary active slot.
    await expect(prepareReceipt(projectId, 2, authority)).rejects.toBeInstanceOf(ReleasePublicationLineageConflict);
  });

  it('two concurrent different releases for one lineage: exactly one wins', async () => {
    const projectId = 'proj_rel_race';
    const authority = await promotedRoot(projectId);

    const results = await Promise.allSettled([prepareReceipt(projectId, 1, authority), prepareReceipt(projectId, 2, authority)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ReleasePublicationLineageConflict);
    expect(await store.releasePublications.countDocuments({ projectId })).toBe(1);
  });

  it('committed does not let the same lineage publish again', async () => {
    const projectId = 'proj_rel_after_commit';
    const authority = await promotedRoot(projectId);
    await commitReceipt(await prepareReceipt(projectId, 1, authority));

    // The active slot is free now, so only lineage authority can refuse this.
    await expect(prepareReceipt(projectId, 2, authority)).rejects.toBeInstanceOf(ReleasePublicationLineageConflict);
  });

  it('a later lineage for the same project has its own release', async () => {
    const projectId = 'proj_rel_later_lineage';
    const a = await promotedRoot(projectId, 1);
    const ra = await commitReceipt(await prepareReceipt(projectId, 1, a));

    // Lineage A is done; a new root legitimately publishes its own release.
    await store.frontendBackendBuildBindings.updateOne({ _id: a.lineageRootBindingId }, { $unset: { activeLineage: '' } });
    const b = await promotedRoot(projectId, 2);
    const rb = await prepareReceipt(projectId, 2, b);

    expect(rb._id).not.toBe(ra._id);
    expect((await reload(ra._id))!.buildAuthority).toEqual(a);
  });

  it('the project-level active publication slot is unchanged and orthogonal', async () => {
    const projectId = 'proj_rel_active_slot';
    const a = await promotedRoot(projectId, 1);
    await prepareReceipt(projectId, 1, a);

    // A different lineage while A's release is unfinished: the temporary slot,
    // not a lineage conflict.
    await store.frontendBackendBuildBindings.updateOne({ _id: a.lineageRootBindingId }, { $unset: { activeLineage: '' } });
    const b = await promotedRoot(projectId, 2);
    await expect(prepareReceipt(projectId, 2, b)).rejects.toBeInstanceOf(ReleasePublicationConflict);
    await expect(prepareReceipt(projectId, 2, b)).rejects.not.toBeInstanceOf(ReleasePublicationLineageConflict);

    // And unlinked releases still compete for it exactly as before.
    const other = 'proj_rel_active_slot_unlinked';
    await prepareReceipt(other, 1);
    await expect(prepareReceipt(other, 2)).rejects.toBeInstanceOf(ReleasePublicationConflict);
  });
});

describe('exact lookup by lineage', () => {
  const lookup = (projectId: string, a: ReleaseBuildAuthority) =>
    findReleasePublicationForLineage(store, projectId, a.lineageRootBindingId);

  it('finds the one receipt through prepared, publishing, retry_authorized and committed — and adopted', async () => {
    const projectId = 'proj_rel_lookup_states';
    const authority = await promotedRoot(projectId);
    const receipt = await prepareReceipt(projectId, 1, authority);
    expect((await lookup(projectId, authority))?.status).toBe('prepared');

    const publishing = await beginPublicationAttempt(store, receipt, { releaseCommitSha: null });
    expect((await lookup(projectId, authority))?.status).toBe('publishing');

    const retry = await authorizeReleaseRepublication(store, {
      projectId, releaseId: receipt._id, attempt: publishing.attempt, actor: 'operator', reason: 'reconciled: nothing deployed',
    });
    expect(retry.buildAuthority).toEqual(authority);
    expect((await lookup(projectId, authority))?.status).toBe('retry_authorized');

    const second = await beginPublicationAttempt(store, retry, { releaseCommitSha: null });
    const adopted = await adoptReleaseDeployment(
      store,
      {
        getDeploymentById: async (deploymentId) => ({
          deploymentId, url: 'https://adopted.vercel.app', meta: { statxReleaseId: receipt._id }, project: null, target: null,
        }),
      },
      { projectId, releaseId: receipt._id, attempt: second.attempt, deploymentId: 'dpl_adopted', actor: 'operator', reason: 'found it' },
    );
    expect(adopted.buildAuthority).toEqual(authority);

    const committed = await lookup(projectId, authority);
    expect(committed?.status).toBe('committed');
    expect(committed?.active).toBeUndefined();
    expect(committed?._id).toBe(receipt._id);
  });

  it('a normally committed receipt keeps its build authority and stays findable', async () => {
    const projectId = 'proj_rel_lookup_committed';
    const authority = await promotedRoot(projectId);
    const committed = await commitReceipt(await prepareReceipt(projectId, 1, authority));

    expect(committed.buildAuthority).toEqual(authority);
    expect((await lookup(projectId, authority))?._id).toBe(committed._id);
  });

  it('ignores historical and legacy receipts that carry no build authority', async () => {
    const projectId = 'proj_rel_lookup_unlinked';
    await commitReceipt(await prepareReceipt(projectId, 1));
    const authority = await promotedRoot(projectId);

    expect(await lookup(projectId, authority)).toBeNull();
  });

  it('never orders receipts by time or version', async () => {
    const source = await readFile(join(SRC, 'release-publication', 'publication.ts'), 'utf8');
    const body = source.slice(
      source.indexOf('export async function findReleasePublicationForLineage'),
      source.indexOf('export function assertReceiptMatchesCanonicalBuild'),
    );
    const code = body.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/sort/);
    expect(code).not.toMatch(/preparedAt|committedAt|updatedAt|version/);
    expect(code).not.toMatch(/active/);
    expect(code).toMatch(/'buildAuthority\.lineageRootBindingId': lineageRootBindingId/);
  });

  it('a receipt for B1 is not publication authority once the lineage tip is B2', async () => {
    const projectId = 'proj_rel_moved_tip';
    const b0 = await prepare(projectId, 1);
    await promote(b0._id, 1);
    const b1 = await prepare(projectId, 2, b0._id);
    await promote(b1._id, 2);
    const receipt = await prepareReceipt(projectId, 1, await loadReleaseBuildAuthority(store, projectId, b1._id));

    const b2 = await prepare(projectId, 3, b1._id);
    await promote(b2._id, 3);

    const root = await findActiveLineageRoot(store, projectId);
    const tip = await deriveActiveLineageTip(store, root!);
    expect(tip._id).toBe(b2._id);

    const found = await findReleasePublicationForLineage(store, projectId, root!._id);
    expect(found?._id).toBe(receipt._id);
    // Same root — and still refused, because binding and promotion differ.
    const error = (() => {
      try {
        assertReceiptMatchesCanonicalBuild(found!, {
          lineageRootBindingId: root!._id,
          canonicalBindingId: tip._id,
          promotionId: tip.promotionId!,
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ReleasePublicationCanonicalBuildMismatch);
    expect((error as Error).message).toMatch(/canonical binding/);

    // The build it really was published for still matches.
    expect(() => assertReceiptMatchesCanonicalBuild(found!, found!.buildAuthority!)).not.toThrow();
  });
});

describe('historical receipts', () => {
  it('stay readable, and ensureIndexes builds the lineage index over them with no backfill', async () => {
    const projectId = 'proj_rel_historical';
    await store.releasePublications.insertOne({
      _id: 'historical-release',
      projectId,
      releaseAuthorization: authRef(1),
      baseCommit: null,
      deploymentTarget: resolveDeploymentTarget(projectId),
      status: 'committed',
      releaseCommitSha: null,
      deploymentId: 'dpl_old',
      deploymentUrl: 'https://old.vercel.app',
      attempt: 1,
      attempts: [],
      preparedAt: new Date(),
      committedAt: new Date(),
      updatedAt: new Date(),
    });

    const named = async () => (await store.releasePublications.indexes()).map((i) => i.name);
    if ((await named()).includes('projectId_1_buildAuthority_lineageRoot')) {
      await store.releasePublications.dropIndex('projectId_1_buildAuthority_lineageRoot');
    }
    expect(await named()).not.toContain('projectId_1_buildAuthority_lineageRoot');

    await expect(store.ensureIndexes()).resolves.not.toThrow();
    expect(await named()).toContain('projectId_1_buildAuthority_lineageRoot');

    const historical = await reload('historical-release');
    expect(historical?.status).toBe('committed');
    expect('buildAuthority' in historical!).toBe(false);
  });
});
