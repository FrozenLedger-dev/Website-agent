import { describe, expect, it } from 'vitest';
import { blocking, filesForDefect, fromGateFinding, fromReviewIssue } from '../src/defects.js';

const SITE = ['index.html', 'about.html', 'contact.html', 'services.html', 'styles.css'];

describe('repair scoping', () => {
  it('scopes to the file named in the location, plus the stylesheet', () => {
    expect(filesForDefect('about.html#materials', SITE).sort()).toEqual(['about.html', 'styles.css']);
  });

  it('includes every file the reason names, not just the location', () => {
    // Regression: a P1 invented-claim defect was located on about.html but the
    // reviewer noted the same claim echoed on two other pages. Scoping to the
    // location alone repaired one file and released with the claim still live.
    const reason =
      'The page asserts an aftercare commitment absent from the profile. Softer echoes of the ' +
      'same claim appear on index.html#where-we-work and contact.html#area.';

    const scope = filesForDefect('about.html#materials-standards', SITE, reason).sort();
    expect(scope).toEqual(['about.html', 'contact.html', 'index.html', 'styles.css']);
  });

  it('treats an unidentifiable location as site-wide', () => {
    expect(filesForDefect('site', SITE).sort()).toEqual([...SITE].sort());
  });

  it('does not drag in files merely because their name is a substring', () => {
    const scope = filesForDefect('contact.html', ['contact.html', 'styles.css']);
    expect(scope.sort()).toEqual(['contact.html', 'styles.css']);
  });
});

describe('defect normalisation', () => {
  it('gives gate findings and review issues the same fingerprint basis', () => {
    const gate = fromGateFinding(
      {
        gate: 'responsive',
        severity: 'P1',
        location: 'index.html',
        message: 'overflow',
        acceptanceTest: 'no overflow',
      },
      0,
    );
    const review = fromReviewIssue({
      id: 'QA-001',
      category: 'responsive',
      severity: 'P1',
      location: 'index.html',
      reason: 'the hero overflows on mobile',
      acceptanceTest: 'no overlap at 320px',
      recommendedAction: 'targeted_repair',
      evidence: [],
    });

    // Same category and location: one budget, whichever stage noticed it.
    expect(review.fingerprint).toBe(gate.fingerprint);
  });

  it('counts only P0 and P1 as blocking', () => {
    const defects = (['P0', 'P1', 'P2', 'P3'] as const).map((severity, i) =>
      fromGateFinding(
        { gate: 'g', severity, location: `p${i}.html`, message: 'm', acceptanceTest: 't' },
        i,
      ),
    );
    expect(blocking(defects).map((d) => d.severity)).toEqual(['P0', 'P1']);
  });
});
