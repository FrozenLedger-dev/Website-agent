/**
 * The snapshot as an actual boundary, not a convention.
 *
 * `runProject` owns the run's progress; a phase gets a view of it. That was
 * previously a rebuilt object whose arrays and telemetry buckets still pointed
 * at the owner's live data — so a phase could have mutated the run through
 * `openDefects.push(...)`, and a value read early in a call could differ from
 * the same value read later. Neither ever happened, and neither was prevented.
 *
 * These pin both directions of the isolation, and the nesting, because a copy
 * that is only one level deep looks identical until something reaches through.
 */
import { describe, expect, it } from 'vitest';
import { createRunProgress, snapshotProgress } from '../src/run-context.js';
import type { MutableRunProgress, UsageTotals } from '../src/run-context.js';
import type { Defect } from '../src/defects.js';
import type { SitePlan } from '@statxai/contracts';

const defect = (id: string): Defect =>
  ({
    id,
    category: 'claims',
    severity: 'P1',
    location: 'index.html',
    reason: 'r',
    acceptanceTest: 't',
    fingerprint: `fp:${id}`,
  }) as Defect;

const plan = (title: string): SitePlan =>
  ({
    strategy: 's',
    valueProposition: 'v',
    brandSystem: { palette: {}, typography: {}, artDirection: 'a', radius: 'square', rationale: 'r' },
    sitemap: { pages: [{ route: '/', title, sections: [] }] },
    acceptanceCriteria: ['a'],
  }) as unknown as SitePlan;

const owned = (): MutableRunProgress => {
  const owner = createRunProgress();
  owner.plan = plan('Home');
  owner.reviewCycle = 2;
  owner.openDefects = [defect('QA-001')];
  owner.repairHistory = [{ defectId: 'QA-001', fingerprint: 'fp:QA-001', outcome: '1 file(s) rewritten' }];
  owner.gatesCertified = ['build', 'claims'];
  owner.usage = { inputTokens: 100, outputTokens: 50, calls: 4 };
  owner.usageByTier = { sol: { inputTokens: 60, outputTokens: 30, calls: 2, ms: 900 } };
  owner.phaseMs = { evaluate: 100 };
  return owner;
};

describe('what a phase is handed', () => {
  it('carries the values the owner holds', () => {
    const view = snapshotProgress(owned());

    expect(view.reviewCycle).toBe(2);
    expect(view.openDefects.map((d) => d.id)).toEqual(['QA-001']);
    expect(view.usage.calls).toBe(4);
    expect(view.usageByTier.sol?.calls).toBe(2);
    expect(view.phaseMs['evaluate']).toBe(100);
    expect(view.plan.sitemap.pages[0]?.title).toBe('Home');
    expect(view.gatesCertified).toEqual(['build', 'claims']);
  });

  it('refuses to exist before a plan does', () => {
    // Being handed progress with no plan would mean a phase ran before
    // planning — a wiring mistake, not a runtime condition to absorb.
    expect(() => snapshotProgress(createRunProgress())).toThrow(/no plan yet/);
  });
});

describe('the owner cannot reach into a view it already handed out', () => {
  it('leaves an earlier view unchanged when the run moves on', () => {
    const owner = owned();
    const view = snapshotProgress(owner);

    owner.reviewCycle = 3;
    owner.openDefects.push(defect('QA-002'));
    owner.repairHistory.push({ defectId: 'QA-002', fingerprint: 'fp:QA-002', outcome: 'failed' });
    owner.usage.calls += 1;
    owner.usageByTier.sol!.calls += 1;
    owner.phaseMs['evaluate'] = (owner.phaseMs['evaluate'] ?? 0) + 50;
    owner.gatesCertified.push('headings');

    expect(view.reviewCycle).toBe(2);
    expect(view.openDefects).toHaveLength(1);
    expect(view.repairHistory).toHaveLength(1);
    expect(view.usage.calls).toBe(4);
    expect(view.usageByTier.sol?.calls).toBe(2);
    expect(view.phaseMs['evaluate']).toBe(100);
    expect(view.gatesCertified).toEqual(['build', 'claims']);
  });

  it('detaches nested plan data, not just the top level', () => {
    // The failure a shallow copy hides: everything above passes while the plan
    // is still the owner's object.
    const owner = owned();
    const view = snapshotProgress(owner);

    owner.plan!.sitemap.pages[0]!.title = 'Changed';

    expect(view.plan.sitemap.pages[0]?.title).toBe('Home');
  });
});

describe('a view cannot reach into the owner', () => {
  it('absorbs writes made through an unsafe cast', () => {
    // The `readonly` markers stop this at compile time. The clone is what makes
    // it true at runtime, which is what matters if a cast ever slips through.
    const owner = owned();
    const view = snapshotProgress(owner);

    (view.openDefects as Defect[]).push(defect('QA-999'));
    (view.repairHistory as { defectId: string; fingerprint: string; outcome: string }[]).push({
      defectId: 'QA-999',
      fingerprint: 'fp:QA-999',
      outcome: 'invented',
    });
    (view.usage as UsageTotals).calls = 999;
    (view.phaseMs as Record<string, number>)['evaluate'] = 999;
    view.plan.sitemap.pages[0]!.title = 'Rewritten';

    expect(owner.openDefects).toHaveLength(1);
    expect(owner.repairHistory).toHaveLength(1);
    expect(owner.usage.calls).toBe(4);
    expect(owner.phaseMs['evaluate']).toBe(100);
    expect(owner.plan!.sitemap.pages[0]?.title).toBe('Home');
  });
});

describe('each call gets the progress as it is now', () => {
  it('reflects the run advancing between two snapshots', () => {
    const owner = owned();
    const before = snapshotProgress(owner);

    owner.reviewCycle = 3;
    owner.repairsApplied = 1;
    owner.usage.calls = 9;

    const after = snapshotProgress(owner);

    expect(before.reviewCycle).toBe(2);
    expect(before.repairsApplied).toBe(0);
    expect(before.usage.calls).toBe(4);

    expect(after.reviewCycle).toBe(3);
    expect(after.repairsApplied).toBe(1);
    expect(after.usage.calls).toBe(9);
  });
});

describe('what the owner deliberately does not hold', () => {
  it('caches no budget remainder and no artifact version', () => {
    // Budgets are read from the store when a decision needs them and spent
    // transactionally; artifact versions belong to the registry. A copy here
    // would be a second authority that could disagree with the transaction.
    const keys = Object.keys(createRunProgress());

    for (const forbidden of [
      'repairsLeft',
      'replansLeft',
      'reviewRejectionsLeft',
      'repairsUsedByFingerprint',
      'budgets',
      'artifactVersions',
      'manifestVersion',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }

    // The one provenance exception the manifest genuinely needs.
    expect(keys).toContain('approvalArtifactVersion');
  });
});
