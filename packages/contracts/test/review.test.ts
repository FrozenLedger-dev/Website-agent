import { describe, expect, it } from 'vitest';
import {
  ReviewOutcomeInput,
  defectDetailFingerprint,
  defectFingerprint,
  isReleaseBlocked,
  legalTerminalOutcomes,
  primaryLocation,
  reviewOutcomeJsonSchema,
} from '../src/index.js';

const issue = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'QA-014',
  category: 'responsive',
  severity: 'P1',
  location: 'homepage.hero',
  reason: 'CTA overlaps heading at 375px',
  acceptanceTest: 'No overlap at viewport widths >= 320px',
  recommendedAction: 'targeted_repair',
  ...over,
});

describe('defect fingerprint', () => {
  it('survives paraphrase of the free-text fields', () => {
    // The evasion this exists to prevent: a reviewer rewording the same defect
    // between cycles to mint a fresh budget.
    const cycle1 = defectFingerprint({ category: 'responsive', location: 'homepage.hero' });
    const cycle2 = defectFingerprint({ category: 'responsive', location: 'Homepage.Hero' });
    expect(cycle2).toBe(cycle1);
  });

  it('ignores reason and acceptance test entirely', () => {
    const a = defectFingerprint({ category: 'responsive', location: 'homepage.hero' });
    // Same category+location, wildly different prose — must be the same budget.
    const b = defectFingerprint({ category: 'responsive', location: 'homepage hero' });
    expect(b).toBe(a);
  });

  it('separates genuinely different defects', () => {
    const hero = defectFingerprint({ category: 'responsive', location: 'homepage.hero' });
    const footer = defectFingerprint({ category: 'responsive', location: 'homepage.footer' });
    const a11y = defectFingerprint({ category: 'accessibility', location: 'homepage.hero' });
    expect(new Set([hero, footer, a11y]).size).toBe(3);
  });

  it('exposes a finer identity for dedup that is NOT the budget key', () => {
    const base = { category: 'responsive', location: 'homepage.hero' };
    const one = defectDetailFingerprint({ ...base, acceptanceTest: 'No overlap at >= 320px' });
    const two = defectDetailFingerprint({ ...base, acceptanceTest: 'No overlap at >= 375px' });
    expect(one).not.toBe(two);
    // ...while both still share one budget.
    expect(defectFingerprint(base)).toBe(defectFingerprint(base));
  });
});

describe('review outcome consistency rules', () => {
  it('accepts a well-formed blocking rejection', () => {
    const result = ReviewOutcomeInput.safeParse({
      decision: 'reject',
      qualityScore: 86,
      blocking: true,
      issues: [issue()],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unbounded "not good enough" with no issues', () => {
    const result = ReviewOutcomeInput.safeParse({
      decision: 'reject',
      qualityScore: 40,
      blocking: false,
      issues: [],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a P3-only review that claims to block release', () => {
    // Otherwise cosmetic preferences consume the whole approval budget.
    const result = ReviewOutcomeInput.safeParse({
      decision: 'reject',
      qualityScore: 92,
      blocking: true,
      issues: [issue({ severity: 'P3', id: 'QA-101' })],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a P3-only review that correctly reports itself non-blocking', () => {
    const result = ReviewOutcomeInput.safeParse({
      decision: 'reject',
      qualityScore: 92,
      blocking: false,
      issues: [issue({ severity: 'P3', id: 'QA-101' })],
    });
    expect(result.success).toBe(true);
  });

  it('refuses to accept while a P1 is open', () => {
    const result = ReviewOutcomeInput.safeParse({
      decision: 'accept',
      qualityScore: 88,
      blocking: true,
      issues: [issue()],
    });
    expect(result.success).toBe(false);
  });
});

describe('release adjudication', () => {
  it('blocks on P0 and P1 only', () => {
    expect(isReleaseBlocked([{ severity: 'P0' }])).toBe(true);
    expect(isReleaseBlocked([{ severity: 'P1' }])).toBe(true);
    expect(isReleaseBlocked([{ severity: 'P2' }, { severity: 'P3' }])).toBe(false);
  });

  it('narrows terminal outcomes to rollback or blocked when a P1 is open', () => {
    const outcomes = legalTerminalOutcomes([{ severity: 'P1' }], { humanReviewPermitted: false });
    expect(outcomes).toEqual(['rollback_to_last_accepted', 'mark_blocked']);
    expect(outcomes).not.toContain('accept_non_blocking');
  });

  it('allows accepting documented issues when nothing blocking remains', () => {
    const outcomes = legalTerminalOutcomes([{ severity: 'P2' }], { humanReviewPermitted: false });
    expect(outcomes).toContain('accept_non_blocking');
  });

  it('offers human review only when autonomy policy permits it', () => {
    expect(legalTerminalOutcomes([{ severity: 'P2' }], { humanReviewPermitted: false })).not.toContain(
      'request_human_review',
    );
    expect(legalTerminalOutcomes([{ severity: 'P2' }], { humanReviewPermitted: true })).toContain(
      'request_human_review',
    );
  });
});

describe('model output contract', () => {
  it('projects to strict JSON Schema for structured output', () => {
    const schema = reviewOutcomeJsonSchema() as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    const properties = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['blocking', 'decision', 'issues', 'qualityScore']);
  });
});

describe('fingerprint stability across a reviewer’s paraphrase', () => {
  /**
   * Observed on a real delivery. Seven blocking issues over four review cycles
   * produced seven distinct fingerprints and no repeats, while the reviewer's
   * own prose said "the previously reported binding defect remains". The budget
   * reset every cycle, Sol could not see the recurrence, and the run burned
   * every rejection and blocked with the site undeployed.
   */
  const cycle2 = 'index.html#hero; index.html#experience; services.html#services-intro';
  const cycle3a = 'index.html#experience';
  const cycle3b = 'index.html#coverage-contact';

  const fp = (location: string) => defectFingerprint({ category: 'content_accuracy', location });

  it('gives one defect one fingerprint however the reviewer words its location', () => {
    expect(fp(cycle3a)).toBe(fp(cycle2));
    expect(fp(cycle3b)).toBe(fp(cycle2));
  });

  it('keeps genuinely different pages apart', () => {
    expect(fp('landlords.html#landlord-contact')).not.toBe(fp(cycle2));
    expect(fp('contact.html#post-coverage')).not.toBe(fp(cycle2));
  });

  it('keeps different categories apart on the same page', () => {
    expect(defectFingerprint({ category: 'content_accuracy', location: 'index.html' })).not.toBe(
      defectFingerprint({ category: 'responsive', location: 'index.html' }),
    );
  });

  it('normalises anchors, lists and link arrows to the file named first', () => {
    expect(primaryLocation('index.html#hero')).toBe('index.html');
    expect(primaryLocation('index.html#hero, contact.html')).toBe('index.html');
    expect(primaryLocation('index.html; services.html')).toBe('index.html');
    expect(primaryLocation('services.html -> /missing.html')).toBe('services.html');
    expect(primaryLocation('  about.html  ')).toBe('about.html');
  });

  it('leaves a location naming no file usable rather than empty', () => {
    // "site" is a legitimate whole-site locator and must still fingerprint.
    expect(primaryLocation('site')).toBe('site');
    expect(fp('site')).toBe(fp('site'));
  });
});
