import { describe, expect, it } from 'vitest';
import { AgentTier, ROLE_TIER, WorkerRole, rolesForTier } from '../src/index.js';

describe('rolesForTier', () => {
  it('agrees with ROLE_TIER for every role', () => {
    for (const role of WorkerRole.options) {
      expect(rolesForTier(ROLE_TIER[role])).toContain(role);
    }
  });

  it('partitions every role across the tiers with no overlap and none left out', () => {
    const seen = new Set<WorkerRole>();
    for (const tier of AgentTier.options) {
      for (const role of rolesForTier(tier)) {
        expect(seen.has(role)).toBe(false);
        seen.add(role);
      }
    }
    expect(seen.size).toBe(WorkerRole.options.length);
  });

  it('gives Luna exactly repair, and nothing else', () => {
    expect(rolesForTier('luna')).toEqual(['repair']);
  });

  it('never lets a Terra worker claim the repair role', () => {
    expect(rolesForTier('terra')).not.toContain('repair');
  });
});
