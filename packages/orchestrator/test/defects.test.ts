import { describe, expect, it } from 'vitest';
import {
  blocking,
  buildFailureDefect,
  filesForDefect,
  fromGateFinding,
  fromReviewIssue,
  mergeByFingerprint,
} from '../src/defects.js';

/** What `readSourceFiles` returns for a four-page site: only what Terra wrote. */
const SOURCE = [
  'app/about/page.tsx',
  'app/contact/page.tsx',
  'app/globals.css',
  'app/layout.tsx',
  'app/page.tsx',
  'app/services/page.tsx',
  'components/site/contact-cta.tsx',
];

/** Exported path → source path, as the orchestrator derives it from the plan. */
const SOURCE_OF = {
  'index.html': 'app/page.tsx',
  'about.html': 'app/about/page.tsx',
  'contact.html': 'app/contact/page.tsx',
  'services.html': 'app/services/page.tsx',
};

describe('repair scoping', () => {
  it('resolves the exported page a gate cites back to its source', () => {
    // Every gate and every reviewer reads the static export, so no finding ever
    // names a file that exists in the source tree. Without the translation the
    // scope came back empty and the repair silently did nothing.
    expect(filesForDefect('about.html#materials', SOURCE, '', SOURCE_OF)).toEqual([
      'app/about/page.tsx',
    ]);
  });

  it('includes every file the reason names, not just the location', () => {
    // Regression: a P1 invented-claim defect was located on about.html but the
    // reviewer noted the same claim echoed on two other pages. Scoping to the
    // location alone repaired one file and released with the claim still live.
    const reason =
      'The page asserts an aftercare commitment absent from the profile. Softer echoes of the ' +
      'same claim appear on index.html#where-we-work and contact.html#area.';

    const scope = filesForDefect('about.html#materials-standards', SOURCE, reason, SOURCE_OF).sort();
    expect(scope).toEqual(['app/about/page.tsx', 'app/contact/page.tsx', 'app/page.tsx']);
  });

  it('resolves a source path the compiler names directly', () => {
    // Regression: a failed build produced BUILD-001 scoped to zero files, so
    // three repair cycles ran without Luna ever being shown a line of code and
    // the run blocked with the budget spent on nothing.
    const defect = buildFailureDefect(
      "app/page.tsx(61,23): error TS2322: Type '{ asChild: true; }' is not assignable…\n" +
        'components/site/contact-cta.tsx(25,19): error TS2322: …',
    );

    const scope = filesForDefect(defect.location, SOURCE, defect.reason, SOURCE_OF).sort();
    expect(scope).toEqual(['app/page.tsx', 'components/site/contact-cta.tsx']);
  });

  it('treats an unidentifiable location as site-wide', () => {
    expect(filesForDefect('site', SOURCE, '', SOURCE_OF).sort()).toEqual([...SOURCE].sort());
  });

  it('does not drag in a page because another page name contains it', () => {
    // "index.html" appears inside no other exported name, but "app/page.tsx" is
    // a substring of nothing while "page.tsx" is a substring of everything —
    // matching must be on the full relative path.
    expect(filesForDefect('services.html', SOURCE, '', SOURCE_OF)).toEqual([
      'app/services/page.tsx',
    ]);
  });

  it('scopes to the shell when the defect is in the shell', () => {
    const scope = filesForDefect(
      'index.html#footer',
      SOURCE,
      'The footer, which app/layout.tsx renders on every page, claims a guarantee the profile does not support.',
      SOURCE_OF,
    ).sort();
    expect(scope).toContain('app/layout.tsx');
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

describe('merging defects that share a budget', () => {
  const typography = (index: number, severity: 'P1' | 'P2', message: string) =>
    fromGateFinding(
      {
        gate: 'typography',
        severity,
        location: 'app/globals.css',
        message,
        acceptanceTest: `"${message}" no longer holds.`,
      },
      index,
    );

  it('collapses findings that share a fingerprint into one repairable defect', () => {
    // Regression: three "font specified but never loaded" findings all live at
    // app/globals.css, so they share one fingerprint and one budget of two. The
    // first consumed it and the other two were skipped as exhausted on the very
    // cycle they were raised — never shown to anyone, though nothing about them
    // was unfixable.
    const merged = mergeByFingerprint([
      typography(0, 'P1', 'Cormorant Garamond is never loaded'),
      typography(1, 'P1', 'Inter Tight is never loaded'),
      typography(2, 'P2', 'Fraunces is never loaded'),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.reason).toContain('Cormorant Garamond');
    expect(merged[0]!.reason).toContain('Inter Tight');
    expect(merged[0]!.reason).toContain('Fraunces');
    expect(merged[0]!.acceptanceTest).toContain('Fraunces');
  });

  it('carries the most severe reading, so a P1 cannot hide behind a P2', () => {
    const merged = mergeByFingerprint([
      typography(0, 'P2', 'cosmetic'),
      typography(1, 'P1', 'a stated acceptance criterion fails'),
    ]);

    expect(merged[0]!.severity).toBe('P1');
    expect(blocking(merged)).toHaveLength(1);
  });

  it('leaves distinct fingerprints separate', () => {
    const merged = mergeByFingerprint([
      typography(0, 'P1', 'a'),
      fromGateFinding(
        { gate: 'claims', severity: 'P1', location: 'index.html', message: 'b', acceptanceTest: 't' },
        1,
      ),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('is a no-op when every defect is already unique', () => {
    const defects = [
      typography(0, 'P1', 'a'),
      fromGateFinding(
        { gate: 'typography', severity: 'P1', location: 'app/layout.tsx', message: 'b', acceptanceTest: 't' },
        1,
      ),
    ];
    expect(mergeByFingerprint(defects)).toEqual(defects);
  });
});
