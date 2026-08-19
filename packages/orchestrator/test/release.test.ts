/**
 * Recommending a release, and authorising one.
 *
 * Sol judges; the harness decides. These pin the boundary, because the manifest
 * used to record `approvedBy: "sol:machine-approval"` for a decision no model
 * was consulted about — crediting a model for the harness's own arithmetic and
 * leaving nothing to check the harness against.
 */
import { describe, expect, it } from 'vitest';
import { DeploymentManifest, SolApprovalRecommendation, toStrictModelSchema } from '@statxai/contracts';
import {
  RELEASE_POLICY_VERSION,
  authorizeRelease,
  verifyAcknowledged,
  type ReleaseEvidence,
} from '../src/release.js';

const clean = (over: Partial<ReleaseEvidence> = {}): ReleaseEvidence => ({
  blockingDefects: 0,
  buildSucceeded: true,
  gatesPassed: true,
  autonomyMode: 'full_autonomous',
  deploymentConfigured: true,
  ...over,
});

const says = (
  recommendation: 'accept' | 'reject' | 'human_review',
  acknowledgedIssues: string[] = [],
) => SolApprovalRecommendation.parse({ recommendation, reason: 'because', acknowledgedIssues });

/** Nothing open, and the check to prove it. */
const nothingOpen = () => verifyAcknowledged([], []);

describe('a recommendation the harness agrees with', () => {
  it('authorises a release', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean(),
      acknowledgement: nothingOpen(),
    });
    expect(auth).toMatchObject({ authorized: true, action: 'release' });
    expect(auth.policyVersion).toBe(RELEASE_POLICY_VERSION);
  });

  it('authorises even with no deployment target, because that is not a refusal', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ deploymentConfigured: false }),
      acknowledgement: nothingOpen(),
    });
    expect(auth.authorized).toBe(true);
    expect(auth.reason).toContain('no deployment target');
  });
});

describe('an acceptance with nothing to check it against', () => {
  it('fails closed rather than reading absence as "nothing omitted"', () => {
    // `acknowledgement?.unacknowledged ?? []` treated a missing check as an
    // empty one, so a caller that simply forgot it got a release. The delivery
    // loop always supplies one, but an exported policy function has to hold its
    // own invariant rather than trust every caller to remember.
    const auth = authorizeRelease({ recommendation: says('accept'), evidence: clean() });

    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('no acknowledgement check was supplied');
  });

  it('does not require one to refuse a rejection', () => {
    // Only an acceptance ships with anything, so only an acceptance needs the
    // check. A rejection is refused on its own terms.
    const auth = authorizeRelease({ recommendation: says('reject'), evidence: clean() });
    expect(auth.action).toBe('block');
    expect(auth.reason).toContain('recommended rejection');
  });

  it('does not require one to refuse on deterministic grounds', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ blockingDefects: 1 }),
    });
    expect(auth.reason).toContain('not waivable');
  });
});

describe('a recommendation the harness overrules', () => {
  it('refuses acceptance over a blocking defect', () => {
    // Blocking severity is harness policy. A recommendation cannot waive one,
    // and the refusal is not a disagreement with Sol — the deterministic facts
    // are checked before the recommendation is read at all.
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ blockingDefects: 2 }),
    });
    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('not waivable');
  });

  it('refuses acceptance over a failed build', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ buildSucceeded: false }),
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toContain('nothing to release');
  });

  it('refuses acceptance over failing gates', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ gatesPassed: false }),
    });
    expect(auth.authorized).toBe(false);
  });

  it('routes acceptance to a human where the autonomy mode requires one', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ autonomyMode: 'human_in_the_loop' }),
      acknowledgement: nothingOpen(),
    });
    expect(auth).toMatchObject({ authorized: false, action: 'human_review' });
  });
});

describe('a recommendation against releasing', () => {
  it('never releases on a rejection', () => {
    const auth = authorizeRelease({ recommendation: says('reject'), evidence: clean() });
    expect(auth).toMatchObject({ authorized: false, action: 'block' });
  });

  it('never auto-releases when Sol asks for a human', () => {
    const auth = authorizeRelease({
      recommendation: says('human_review'),
      evidence: clean({ autonomyMode: 'supervised_autonomous' }),
    });
    expect(auth).toMatchObject({ authorized: false, action: 'human_review' });
  });

  it('blocks rather than inventing a reviewer under full autonomy', () => {
    // Sol may ask for a person; it may not summon one. Full autonomy has none,
    // so the request is honoured as far as policy allows — by not releasing.
    const auth = authorizeRelease({ recommendation: says('human_review'), evidence: clean() });
    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('full autonomy does not provide');
  });
});

describe('a recommendation that never arrived', () => {
  it('is not an approval', () => {
    // Silence is not consent, and the harness does not write a verdict on
    // Sol's behalf.
    const auth = authorizeRelease({ recommendation: null, evidence: clean() });
    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('No approval recommendation');
  });

  it('defers to a human where the mode has one', () => {
    const auth = authorizeRelease({
      recommendation: null,
      evidence: clean({ autonomyMode: 'supervised_autonomous' }),
    });
    expect(auth).toMatchObject({ authorized: false, action: 'human_review' });
  });

  it('is refused before the deterministic checks even matter', () => {
    const auth = authorizeRelease({
      recommendation: null,
      evidence: clean({ blockingDefects: 1 }),
    });
    expect(auth.authorized).toBe(false);
  });
});

describe('acknowledged issues', () => {
  const open = [{ id: 'QA-004' }, { id: 'GATE-007' }];

  it('separates ids that match something open from ids that do not', () => {
    // An acknowledgement records that an issue was seen and judged acceptable.
    // An id nothing matches is not that, so it is recorded rather than counted.
    const checked = verifyAcknowledged(['QA-004', 'QA-999'], open);
    expect(checked.known).toEqual(['QA-004']);
    expect(checked.unknown).toEqual(['QA-999']);
  });

  it('reports open issues that were never mentioned', () => {
    // Detecting invented ids without detecting omitted ones catches only the
    // careless half: a recommendation silent about three open issues reads
    // identically to one that never looked.
    const checked = verifyAcknowledged(['QA-004'], open);
    expect(checked.unacknowledged).toEqual(['GATE-007']);
  });

  it('reports everything open when nothing was acknowledged', () => {
    expect(verifyAcknowledged([], open).unacknowledged).toEqual(['QA-004', 'GATE-007']);
  });

  it('reports nothing outstanding when the list is complete', () => {
    const checked = verifyAcknowledged(['QA-004', 'GATE-007'], open);
    expect(checked.unacknowledged).toEqual([]);
    expect(checked.unknown).toEqual([]);
  });

  it('accepts an empty acknowledgement when nothing is open', () => {
    expect(verifyAcknowledged([], [])).toEqual({ known: [], unknown: [], unacknowledged: [] });
  });

  it('cannot be used to acknowledge a blocker, because blockers never reach it', () => {
    // Only non-blocking issues are offered for acknowledgement, and blocking
    // severity is checked by the harness before the recommendation is read.
    const auth = authorizeRelease({
      recommendation: says('accept', ['GATE-001']),
      evidence: clean({ blockingDefects: 1 }),
    });
    expect(auth.authorized).toBe(false);
  });
});

describe('what a recommendation cannot express', () => {
  const forbidden =
    /deploy|release|bypass|permission|budget|policy|credential|token|autonomy|authoriz|authoris/i;

  it('carries only a verdict, a reason and acknowledged issues', () => {
    const json = toStrictModelSchema(SolApprovalRecommendation) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      'acknowledgedIssues',
      'reason',
      'recommendation',
    ]);
    for (const key of Object.keys(json.properties ?? {})) {
      expect(forbidden.test(key), key).toBe(false);
    }
  });
});

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
  const source = async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    return readFile(join(src, 'orchestrator.ts'), 'utf8');
  };

  it('asks Sol only once nothing blocking remains', async () => {
    const code = await source();
    const gate = code.indexOf('if (mustFix.length === 0) {');
    const call = code.indexOf('seekRelease({');

    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(call);
  });

  it('records the recommendation before authorising, and the authorisation before deploying', async () => {
    // Never: deploy, then write down that it was approved.
    const code = await source();
    const seek = code.slice(code.indexOf('async function seekRelease'));
    const body = seek.slice(0, seek.indexOf('\n  }\n'));

    const recommend = body.indexOf('recommendApproval(');
    const persistRec = body.indexOf("registry.put(projectId, 'approval-recommendation'");
    const authorize = body.indexOf('authorizeRelease({');
    const persistAuth = body.indexOf("registry.put(projectId, 'release-authorization'");

    expect(recommend).toBeLessThan(persistRec);
    expect(persistRec).toBeLessThan(authorize);
    expect(authorize).toBeLessThan(persistAuth);
  });

  it('makes deployment unreachable without an authorisation', async () => {
    // `authorization` is null on every path that skipped approval — a terminal
    // escalation, an exhausted budget, a refused revision — so the guard covers
    // them all rather than each needing its own check.
    const code = await source();
    const guard = code.indexOf('if (!authorization?.authorized)');
    const deploy = code.indexOf('await deploySite(');

    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(deploy);
  });

  it('no longer attributes approval to a model in the manifest', async () => {
    const code = (await source()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain("approvedBy: 'sol:machine-approval'");
    expect(code).not.toContain('approvedBy');
  });

  it('fixes the authoriser as the harness at the point the manifest is written', async () => {
    const code = await source();
    expect(code).toContain("by: 'harness-policy' as const");
    expect(code).toContain("by: 'sol' as const");
  });
});

describe('an acceptance has to account for what is still open', () => {
  const open = [{ id: 'QA-004' }, { id: 'QA-005' }];

  it('refuses an acceptance that ignores open issues', () => {
    // The load-bearing case: `acknowledgedIssues` is the stated basis on which
    // something ships with known defects. Accepting while silent about them is
    // not that judgement — it is the absence of one.
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean(),
      acknowledgement: verifyAcknowledged([], open),
    });

    expect(auth).toMatchObject({ authorized: false, action: 'block' });
    expect(auth.reason).toContain('QA-004');
    expect(auth.reason).toContain('QA-005');
  });

  it('refuses a partial acknowledgement', () => {
    const auth = authorizeRelease({
      recommendation: says('accept', ['QA-004']),
      evidence: clean(),
      acknowledgement: verifyAcknowledged(['QA-004'], open),
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toContain('QA-005');
    expect(auth.reason).not.toContain('QA-004');
  });

  it('authorises when every open issue is accounted for', () => {
    const auth = authorizeRelease({
      recommendation: says('accept', ['QA-004', 'QA-005']),
      evidence: clean(),
      acknowledgement: verifyAcknowledged(['QA-004', 'QA-005'], open),
    });
    expect(auth).toMatchObject({ authorized: true, action: 'release' });
  });

  it('authorises when nothing is open to acknowledge', () => {
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean(),
      acknowledgement: verifyAcknowledged([], []),
    });
    expect(auth.authorized).toBe(true);
  });

  it('does not apply the check to a rejection', () => {
    // Only an acceptance ships with known defects, so only an acceptance has to
    // account for them.
    const auth = authorizeRelease({
      recommendation: says('reject'),
      evidence: clean(),
      acknowledgement: verifyAcknowledged([], open),
    });
    expect(auth.action).toBe('block');
    expect(auth.reason).toContain('recommended rejection');
  });

  it('still refuses on deterministic grounds before checking completeness', () => {
    // Ordering: a blocking defect is refused for being a blocking defect, not
    // for an unacknowledged P2.
    const auth = authorizeRelease({
      recommendation: says('accept'),
      evidence: clean({ blockingDefects: 1 }),
      acknowledgement: verifyAcknowledged([], open),
    });
    expect(auth.reason).toContain('not waivable');
  });
});

describe('git provenance', () => {
  it('does not credit a model for commits the harness authorised', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(join(src, 'orchestrator.ts'), 'utf8');

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
    const code = await readFile(join(src, 'orchestrator.ts'), 'utf8');

    expect(code).toContain('decision: approvalDecision');
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
  const source = async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    return readFile(join(src, 'orchestrator.ts'), 'utf8');
  };

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
    expect(branch).not.toContain('terminal(');
  });

  it('keeps the intake helper for the exits that genuinely have nothing to report', async () => {
    const code = (await source()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const calls = code.match(/return terminal\(/g) ?? [];

    // Both remaining uses are intake failures, before a workspace exists.
    expect(calls).toHaveLength(2);
    expect(code.match(/return terminal\('intake_insufficient'\)/g) ?? []).toHaveLength(2);
  });

  it('reports the delivery that actually happened', async () => {
    const code = await source();
    const concluded = code.slice(code.indexOf('async function concluded'));
    const body = concluded.slice(0, concluded.indexOf('\n  }\n'));

    for (const field of [
      'qualityScore,',
      'reviewCycles: reviewCycle,',
      'repairsApplied,',
      'openDefects,',
      'workspace.currentCommit()',
      'siteRoot: workspace.siteRoot,',
    ]) {
      expect(body, field).toContain(field);
    }
  });

  it('distinguishes a refusal that wants a person from one that gave up', async () => {
    // `request_human_review` has always been a legal terminal outcome; the late
    // path returned a bare `blocked` while setting the project state to
    // awaiting_human_review, so the two disagreed.
    const code = await source();
    const late = code.slice(code.indexOf('if (!authorization?.authorized)'));
    const branch = late.slice(0, late.indexOf('\n  }\n'));

    expect(branch).toContain("'request_human_review'");
    expect(branch).toContain('awaiting_human_review');
    expect(branch).toContain('decideTerminal(openDefects, autonomyMode)');
  });

  it('records a blocked project state when it did not route to a person', async () => {
    const code = await source();
    const late = code.slice(code.indexOf('if (!authorization?.authorized)'));
    const branch = late.slice(0, late.indexOf('\n  }\n'));
    expect(branch).toContain("state: 'blocked'");
  });
});
