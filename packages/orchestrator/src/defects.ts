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

/**
 * Which files a repair should be allowed to touch.
 *
 * Locations look like "index.html", "index.html#hero", or
 * "index.html -> /missing.html". The stylesheet is included alongside any page
 * because layout and contrast defects are usually fixed there, but a repair
 * never receives the whole site unless the defect genuinely is site-wide.
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
): string[] {
  const head = location.split(' -> ')[0]!.split('#')[0]!.trim();
  const scope = new Set<string>();

  const direct = available.find((path) => path === head);
  if (direct) scope.add(direct);

  for (const path of available) {
    if (location.includes(path) || reason.includes(path)) scope.add(path);
  }

  // No identifiable file: the defect is site-wide, so everything is in scope.
  if (scope.size === 0) return [...available];

  if ([...scope].some((p) => p.endsWith('.html')) && available.includes('styles.css')) {
    scope.add('styles.css');
  }
  return [...scope];
}
