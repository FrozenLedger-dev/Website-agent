/**
 * How a run ends.
 *
 * Two exits, and the distinction between them is not cosmetic. A refused
 * release once used the intake exit, so a run that built a site, scored 92 over
 * three review cycles and two repairs, and was then correctly refused, reported
 * a quality score of 0, no cycles, no repairs, no defects, no commit and no
 * site root. The decision was right and the telemetry described a different
 * run.
 *
 * So these stay separate on purpose. Collapsing them into one helper that
 * "handles both" is precisely the change that caused the bug.
 */
import type { RunContext, RunProgress, UsageByTier, UsageTotals } from '../run-context.js';
import type { Defect } from '../defects.js';
import type { DeploymentManifest, TerminalOutcome } from '@statxai/contracts';

export interface RunResult {
  projectId: string;
  outcome: 'released' | 'blocked' | 'intake_insufficient';
  terminalDecision?: TerminalOutcome;
  qualityScore: number;
  reviewCycles: number;
  repairsApplied: number;
  openDefects: Defect[];
  commit: string | null;
  siteRoot: string;
  manifest?: DeploymentManifest;
  /**
   * Stated outright rather than aliased from `RunProgress`.
   *
   * `RunResult` is the package's public contract and `RunProgress` is an
   * internal phase boundary. Aliasing meant tightening the second silently
   * tightened the first: making the phase view readonly turned the result
   * readonly too, so a caller doing `result.usage.calls += 1` stopped
   * compiling — an API change nobody decided on, arriving as a side effect.
   *
   * Whether a result should be readonly is a separate question, and if the
   * answer is yes it belongs in a commit that says so.
   */
  usage: UsageTotals;
  usageByTier: UsageByTier;
  phaseMs: Record<string, number>;
}

/**
 * An exit before there is a delivery to describe.
 *
 * Only for intake failures, which happen before a workspace exists, a plan is
 * made or a token is spent — so the zeroes are accurate rather than missing.
 * Anything that ends after the build has real values to report and must use
 * {@link concluded}.
 */
export function withoutDelivery(
  projectId: string,
  outcome: RunResult['outcome'],
  telemetry: Pick<RunProgress, 'usage' | 'usageByTier' | 'phaseMs'>,
): RunResult {
  return {
    projectId,
    outcome,
    qualityScore: 0,
    reviewCycles: 0,
    repairsApplied: 0,
    openDefects: [],
    commit: null,
    siteRoot: '',
    usage: { ...telemetry.usage },
    usageByTier: structuredClone(telemetry.usageByTier) as UsageByTier,
    phaseMs: { ...telemetry.phaseMs },
  };
}

/**
 * An exit after a delivery has happened, reporting what it actually did.
 *
 * Every field comes from the run's own progress rather than from a default, so
 * a late refusal reports the work performed rather than an empty run.
 */
export async function concluded(
  ctx: RunContext,
  outcome: RunResult['outcome'],
  decision: TerminalOutcome | undefined,
): Promise<RunResult> {
  const { facts, progress, deps } = ctx;
  return {
    projectId: facts.projectId,
    outcome,
    ...(decision ? { terminalDecision: decision } : {}),
    qualityScore: progress.qualityScore,
    reviewCycles: progress.reviewCycle,
    repairsApplied: progress.repairsApplied,
    openDefects: [...progress.openDefects],
    commit: await deps.workspace.currentCommit(),
    siteRoot: deps.workspace.siteRoot,
    usage: { ...progress.usage },
    usageByTier: structuredClone(progress.usageByTier) as UsageByTier,
    phaseMs: { ...progress.phaseMs },
  };
}
