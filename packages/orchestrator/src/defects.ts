/**
 * Unified defect view.
 *
 * Deterministic gates and the independent reviewer produce findings in
 * different shapes, but §7's escalation ladder and repair budgets act on both
 * identically. Normalising them here means the budget engine cannot be evaded
 * by which stage happened to notice a problem.
 */
import { defectFingerprint, type GateFinding, type ReviewIssueInput, type Severity } from '@statxai/contracts';

export interface Defect {
  id: string;
  source: 'gate' | 'review';
  category: string;
  severity: Severity;
  location: string;
  reason: string;
  acceptanceTest: string;
  fingerprint: string;
}

export function fromGateFinding(finding: GateFinding, index: number): Defect {
  return {
    id: `GATE-${String(index + 1).padStart(3, '0')}`,
    source: 'gate',
    category: finding.gate,
    severity: finding.severity,
    location: finding.location,
    reason: finding.message,
    acceptanceTest: finding.acceptanceTest,
    fingerprint: defectFingerprint({ category: finding.gate, location: finding.location }),
  };
}

/**
 * A failed compile, expressed as the one defect worth reporting.
 *
 * P0: there is no output, so nothing else can be evaluated. The location is the
 * source tree rather than a single file because a type error in one page is
 * frequently caused by another — the compiler output names the real site.
 */
export function buildFailureDefect(output: string): Defect {
  return {
    id: 'BUILD-001',
    source: 'gate',
    category: 'build',
    severity: 'P0',
    location: 'app/',
    reason: `The site does not compile, so no output was produced.\n\n${output}`,
    acceptanceTest: 'pnpm build completes and emits a static export.',
    fingerprint: defectFingerprint({ category: 'build', location: 'app/' }),
  };
}

export function fromReviewIssue(issue: ReviewIssueInput): Defect {
  return {
    id: issue.id,
    source: 'review',
    category: issue.category,
    severity: issue.severity,
    location: issue.location,
    reason: issue.reason,
    acceptanceTest: issue.acceptanceTest,
    fingerprint: defectFingerprint({ category: issue.category, location: issue.location }),
  };
}

/** Blocking severities only — what actually prevents release (§7). */
export function blocking(defects: readonly Defect[]): Defect[] {
  return defects.filter((d) => d.severity === 'P0' || d.severity === 'P1');
}

const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Collapse defects that share a fingerprint into one.
 *
 * The repair budget is charged per fingerprint, so the unit of repair has to be
 * the fingerprint too. It was the finding, and the mismatch starved the site of
 * repairs: three "font specified but never loaded" findings all live at
 * `app/globals.css`, so they share one fingerprint and one budget of two — the
 * first finding consumed it and the other two were skipped as exhausted, on the
 * very cycle they were raised. Nothing about them was unfixable; the second and
 * third were simply never shown to anyone.
 *
 * Merged rather than given separate budgets, because one call fixing three font
 * declarations in one file is both cheaper and likelier to be coherent than
 * three calls rewriting the same file in sequence.
 */
export function mergeByFingerprint(defects: readonly Defect[]): Defect[] {
  const groups = new Map<string, Defect[]>();
  for (const defect of defects) {
    const group = groups.get(defect.fingerprint);
    if (group) group.push(defect);
    else groups.set(defect.fingerprint, [defect]);
  }

  return [...groups.values()].map((group) => {
    const first = group[0]!;
    if (group.length === 1) return first;

    // The whole group blocks if any of it does, so the merged defect carries the
    // most severe reading. Anything else would let a P1 hide behind a P3.
    const severest = group.reduce((a, b) => (SEVERITY_ORDER[b.severity] < SEVERITY_ORDER[a.severity] ? b : a));

    return {
      ...first,
      id: `${first.id}+${group.length - 1}`,
      severity: severest.severity,
      source: group.some((d) => d.source === 'review') ? ('review' as const) : first.source,
      reason: group.map((d, i) => `(${i + 1}) ${d.reason}`).join('\n'),
      acceptanceTest: group.map((d, i) => `(${i + 1}) ${d.acceptanceTest}`).join(' '),
    };
  });
}

/**
 * Which source files a repair should be allowed to touch.
 *
 * A finding names where the defect is *visible*, which is rarely where it is
 * *fixable*. Gates and reviewers read the static export and cite
 * "services.html", "index.html#hero" or "services.html -> /missing.html"; the
 * compiler cites "app/page.tsx(61,23)". Both have to resolve to the TSX a
 * repair can actually edit, so export paths are translated through the sitemap
 * before matching.
 */
export function filesForDefect(
  location: string,
  available: readonly string[],
  /**
   * The finding's prose. A defect's `location` names one file, but the same
   * defect frequently spans several and the reviewer says so in the reason —
   * "softer echoes of the same claim appear on index.html and contact.html".
   * Scoping to `location` alone repaired one file and released with the claim
   * still live on the other two, so any file the reason names is in scope too.
   */
  reason = '',
  /**
   * Exported path → source path, derived from the plan's sitemap. Without it
   * every finding a gate raises resolves to nothing, because no gate ever names
   * a file that exists in the source tree.
   */
  sourceOf: Readonly<Record<string, string>> = {},
): string[] {
  const haystack = `${location}\n${reason}`;
  const scope = new Set<string>();

  for (const [output, source] of Object.entries(sourceOf)) {
    if (haystack.includes(output) && available.includes(source)) scope.add(source);
  }
  for (const path of available) {
    if (haystack.includes(path)) scope.add(path);
  }

  // No identifiable file: the defect is site-wide, so everything is in scope.
  if (scope.size === 0) return [...available];
  return [...scope];
}

/**
 * Files a repair always gets to see, and may fix in place.
 *
 * The shell and the brand tokens are where cross-page defects actually live: a
 * fabricated claim in the footer is visible on every page and fixable in
 * exactly one. Handing them over as context is what lets a repair scoped to one
 * page fix the thing the page was only displaying.
 */
export const REPAIR_COMPANIONS = ['app/layout.tsx', 'app/globals.css'] as const;
