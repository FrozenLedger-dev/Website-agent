/**
 * Recommending a release, and authorising one.
 *
 * Sol judges; the harness decides. These pin the boundary, because the manifest
 * used to record `approvedBy: "sol:machine-approval"` for a decision no model
 * was consulted about — crediting a model for the harness's own arithmetic and
 * leaving nothing to check the harness against.
 */
import { describe, expect, it } from 'vitest';
import { DeploymentManifest } from '@statxai/contracts';
import { RELEASE_POLICY_VERSION } from '@statxai/policy-engine';

describe('provenance: who judged and who authorised', () => {
  /**
   * The most important test in this phase. The manifest must show a
   * recommendation and an authorisation as separate acts, and must contain no
   * field in which a model appears to have authorised or executed a release.
   */
  const manifest = {
    projectId: 'proj_x',
    commit: 'abc123',
    environment: 'production' as const,
    autonomyMode: 'full_autonomous',
    recommendation: {
      by: 'sol' as const,
      model: 'gpt-5.6-sol',
      artifactVersion: 1,
      decision: 'accept' as const,
    },
    authorization: {
      by: 'harness-policy' as const,
      policyVersion: RELEASE_POLICY_VERSION,
      action: 'release' as const,
      reason: 'Sol recommended acceptance and policy permits release.',
    },
    qualityScore: 96,
    checks: ['claims', 'structure'],
    url: 'https://example.vercel.app',
    deploymentId: 'dpl_1',
    rollbackRef: null,
    releasedAt: new Date(),
  };

  it('records the recommendation and the authorisation separately', () => {
    const parsed = DeploymentManifest.safeParse(manifest);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.recommendation.by).toBe('sol');
    expect(parsed.data.recommendation.model).toBe('gpt-5.6-sol');
    expect(parsed.data.authorization.by).toBe('harness-policy');
    expect(parsed.data.authorization.action).toBe('release');
  });

  it('has no field in which a model authorised anything', () => {
    // Asserted on the Zod shape rather than a JSON Schema projection: the
    // manifest is never sent to a model, and it carries dates that have no
    // JSON Schema form.
    const keys = Object.keys(DeploymentManifest.shape);

    expect(keys).not.toContain('approvedBy');
    expect(keys.filter((k) => /approv|authoriz|authoris/i.test(k))).toEqual(['authorization']);

    // Authorship is fixed on both sides by a literal, so neither can be
    // recorded as the other.
    expect(DeploymentManifest.shape.authorization.shape.by.value).toBe('harness-policy');
    expect(DeploymentManifest.shape.recommendation.shape.by.value).toBe('sol');
  });

  it('cannot record a model as the authoriser', () => {
    const forged = {
      ...manifest,
      authorization: { ...manifest.authorization, by: 'sol' },
    };
    expect(DeploymentManifest.safeParse(forged).success).toBe(false);
  });

  it('cannot record the harness as the recommender', () => {
    const forged = {
      ...manifest,
      recommendation: { ...manifest.recommendation, by: 'harness-policy' },
    };
    expect(DeploymentManifest.safeParse(forged).success).toBe(false);
  });
});

describe('ordering and reachability in the delivery loop', () => {
  const read = async (file: string) => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    return readFile(join(src, file), 'utf8');
  };

  /** The delivery loop, which decides *when* release is asked about. */
  const source = () => read('orchestrator.ts');
  /** The release phase, which decides what asking involves. */
  const releasePhase = () => read('phases/release.ts');

  it('asks Sol only once nothing blocking remains', async () => {
    const code = await source();
    const gate = code.indexOf('if (mustFix.length === 0) {');
    const call = code.indexOf('seekRelease(ctx()');

    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(call);
  });

  it('records the recommendation before authorising, and the authorisation before deploying', async () => {
    // Never: deploy, then write down that it was approved.
    const body = await releasePhase();

    const recommend = body.indexOf('recommendApproval(');
    const persistRec = body.indexOf("registry.put(facts.projectId, 'approval-recommendation'");
    const authorize = body.indexOf('authorizeRelease({');
    const persistAuth = body.indexOf("registry.put(facts.projectId, 'release-authorization'");

    for (const [name, at] of Object.entries({ recommend, persistRec, authorize, persistAuth })) {
      expect(at, name).toBeGreaterThan(-1);
    }
    expect(recommend).toBeLessThan(persistRec);
    expect(persistRec).toBeLessThan(authorize);
    expect(authorize).toBeLessThan(persistAuth);
  });

  it('makes deployment unreachable without an authorisation', async () => {
    // `authorization` is null on every path that skipped approval — a terminal
    // escalation, an exhausted budget, a refused revision — so the guard covers
    // them all rather than each needing its own check.
    //
    // The guard now lives in the delivery loop and the deploy in the publish
    // phase, which is the stronger arrangement: publishing is not reachable
    // without going through the call the guard sits in front of.
    const code = await source();
    const guard = code.indexOf('if (!authorization?.authorized)');
    const publish = code.indexOf('publishRelease(ctx()');

    expect(guard).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(publish);

    // And the loop itself never deploys.
    expect(code).not.toContain('await deploySite(');
    expect(await read('phases/publish.ts')).toContain('await deploySite(');
  });

  it('no longer attributes approval to a model in the manifest', async () => {
    const code = (await source()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain("approvedBy: 'sol:machine-approval'");
    expect(code).not.toContain('approvedBy');
  });

  it('fixes the authoriser as the harness at the point the manifest is written', async () => {
    const code = await read('phases/publish.ts');
    expect(code).toContain("by: 'harness-policy' as const");
    expect(code).toContain("by: 'sol' as const");
  });
});

describe('git provenance', () => {
  it('does not credit a model for commits the harness authorised', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(join(src, 'phases/publish.ts'), 'utf8');

    expect(code).not.toContain("commit('Sol: accepted revision')");
    expect(code).not.toContain("commit('Sol: release manifest')");
    expect(code).toContain("commit('Harness: release-authorized revision')");
    expect(code).toContain("commit('Harness: release manifest')");
  });

  it('writes the recommendation Sol gave, not one inferred from the outcome', async () => {
    // Deriving it from `action === 'release'` agrees today only because a
    // manifest exists solely after an authorised release. It would report the
    // harness's conclusion under Sol's name the moment those could differ.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(join(src, 'phases/publish.ts'), 'utf8');

    expect(code).toContain('decision: progress.approvalDecision');
    expect(code).not.toContain("authorization.action === 'release' ? 'accept' : null");
  });

  it('carries no stale pending marker for a phase that shipped', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(join(src, 'orchestrator.ts'), 'utf8');
    expect(code).not.toContain('PENDING (Phase 2d');
  });
});

describe('what a refused release reports to its caller', () => {
  const read = async (file: string) => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    return readFile(join(src, file), 'utf8');
  };
  const source = () => read('orchestrator.ts');

  it('does not use the intake-failure helper after a delivery has happened', async () => {
    /**
     * `terminal()` zeroes everything, which is accurate before a workspace
     * exists and wrong afterwards. A run that built a site, scored 92 over
     * three cycles and two repairs, and was then correctly refused a release,
     * reported quality 0, no cycles, no repairs, no defects and no commit — the
     * decision right, the telemetry describing a different run.
     */
    const code = await source();
    const late = code.slice(code.indexOf('if (!authorization?.authorized)'));
    const branch = late.slice(0, late.indexOf('\n  }\n'));

    expect(branch).toContain('concluded(');
    expect(branch).not.toContain('withoutDelivery(');
  });

  it('keeps the intake helper for the exits that genuinely have nothing to report', async () => {
    const code = (await source()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const calls = code.match(/return withoutDelivery\(/g) ?? [];

    // Both remaining uses are intake failures, before a workspace exists.
    expect(calls).toHaveLength(2);
    expect(code.match(/withoutDelivery\(projectId, 'intake_insufficient'/g) ?? []).toHaveLength(2);
  });

  it('reports the delivery that actually happened', async () => {
    // The two exits live in `phases/conclude.ts` now, and the distinction
    // between them is the reason that file exists.
    const code = await read('phases/conclude.ts');
    const body = code.slice(code.indexOf('export async function concluded'));

    for (const field of [
      'qualityScore: progress.qualityScore,',
      'reviewCycles: progress.reviewCycle,',
      'repairsApplied: progress.repairsApplied,',
      'openDefects: progress.openDefects,',
      'workspace.currentCommit()',
      'siteRoot: deps.workspace.siteRoot,',
    ]) {
      expect(body, field).toContain(field);
    }
  });

  it('maps its terminal outcome from the authorisation, not the defect list', async () => {
    // `decideTerminal` answers what to do about outstanding defects and spent
    // budgets, and prefers `accept_non_blocking` whenever no P0 or P1 remains.
    // This branch is reached only when none remains, so borrowing it reported a
    // denied release as an acceptance.
    const code = await source();
    const late = code.slice(code.indexOf('if (!authorization?.authorized)'));
    const branch = late.slice(0, late.indexOf('\n  }\n'));

    expect(branch).toContain('terminalForRefusal(');
    expect(branch).not.toContain('decideTerminal(');
    expect(branch).toContain('awaiting_human_review');
  });

  it('records a blocked project state when it did not route to a person', async () => {
    const code = await source();
    const late = code.slice(code.indexOf('if (!authorization?.authorized)'));
    const branch = late.slice(0, late.indexOf('\n  }\n'));
    expect(branch).toContain("state: 'blocked'");
  });
});

