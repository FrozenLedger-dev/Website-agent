/**
 * Measuring the site as it currently stands.
 *
 * Build, then deterministic gates, then — only if nothing blocking came out of
 * those — an independent review. The order is the point: a site that does not
 * compile has no export to inspect, so the build failure is the only finding
 * worth reporting, and a reviewer asked about a broken build would be guessing.
 *
 * The phase measures and records. It decides nothing about what to do next:
 * that is the caller's loop, reading the outcome below.
 */
import { routeToOutputPath, routeToSourcePath, type BusinessProfile, type SitePlan } from '@statxai/contracts';
import { reviewSite } from '@statxai/agents';
import { isFrameworkPage, runGates } from '@statxai/gates';
import {
  buildSite as compileSite,
  readBuiltFiles,
  readExportFiles,
  readSourceFiles,
  type BuildResult,
} from '@statxai/workspace';
import { blocking, buildFailureDefect, fromGateFinding, fromReviewIssue, mergeByFingerprint, type Defect } from '../defects.js';
import type { RunContext } from '../run-context.js';

/**
 * §7's first deterministic gate, then the rest: compile, then — only if the
 * export exists to inspect — run every gate against it. Extracted so a second
 * caller (the isolated candidate validator, `job-validation/frontend-backend.js`)
 * can run the exact same deterministic measurement `evaluateSite` does,
 * against a site root of its own choosing, without duplicating the fallback
 * shape a failed build produces or drifting from it over time. One
 * implementation, two callers — this function knows nothing about which.
 */
export async function runDeterministicGates(siteRoot: string, profile: BusinessProfile, plan: SitePlan) {
  const compiled = await compileSite(siteRoot);

  // Gates read the static export — the markup a visitor and a crawler
  // actually receive — rather than the TSX that produced it.
  const files = compiled.ok ? await readBuiltFiles(siteRoot) : [];

  // Every path in the export, so existence checks see the assets no gate
  // parses — scripts, fonts, icons — instead of reporting them missing.
  const assets = compiled.ok ? (await readExportFiles(siteRoot)).map((f) => f.path) : [];

  const gateRun = compiled.ok
    ? runGates({ files, profile, plan, assets })
    : { passed: false, findings: [], gatesRun: ['build'] };

  return { compiled, files, gateRun };
}

/**
 * The source files a repair may edit, as the workspace reports them.
 *
 * Readonly at this boundary, not at the workspace's: `readSourceFiles` returns
 * a fresh array it no longer owns, and nothing downstream needs to write to it.
 * Saying so in the type is what makes the repair phase's "reads, never
 * mutates" claim checkable rather than a comment.
 */
export type SourceFile = Awaited<ReturnType<typeof readSourceFiles>>[number];
export type SourceFiles = readonly SourceFile[];

export interface GateRun {
  passed: boolean;
  findings: { severity: string; gate: string; location: string; message: string }[];
  gatesRun: string[];
}

/** What one pass of measurement found. */
export interface Evaluation {
  compiled: BuildResult;
  gateRun: GateRun;
  /** Source files a repair may edit. Read even when the build failed. */
  sources: SourceFiles;
  /** Export path → the source file that produced it, for scoping a repair. */
  sourceOf: Record<string, string>;
  reviewSummary: string | null;
  /** Collapsed by fingerprint: the repair budget is charged per fingerprint. */
  openDefects: Defect[];
  qualityScore: number;
  gatesCertified: string[];
  /** True when the reviewer ran, which is what clears the repaired-since list. */
  reviewRan: boolean;
}

/**
 * A review that cannot run is not an accepted review.
 *
 * Repairs already degraded gracefully; this did not, so an API outage mid-review
 * took down a delivery whose build and gates had both passed. It is reported as
 * its own outcome rather than as an empty review, because "nobody checked" is a
 * weaker claim than "the builder says it is done" — which §7 already forbids
 * accepting.
 */
export type EvaluationOutcome =
  | ({ kind: 'evaluated' } & Evaluation)
  | { kind: 'review_unavailable'; reason: string };

export async function evaluateSite(ctx: RunContext): Promise<EvaluationOutcome> {
  const { deps, facts, progress } = ctx;
  let qualityScore = progress.qualityScore;
  let reviewRan = false;

  await deps.store.projects.updateOne({ _id: facts.projectId }, { $set: { state: 'validating', updatedAt: new Date() } });

  /**
   * §7's first deterministic gate: the application must build.
   *
   * This runs before every evaluation, not once, because repairs change
   * source. A site that does not compile has no output to inspect, so there
   * is nothing for the other gates or the reviewer to look at — the build
   * failure is the only finding worth reporting.
   */
  deps.say({ phase: 'evaluate', detail: 'Compiling the site' });
  const { compiled, files, gateRun } = await runDeterministicGates(deps.workspace.siteRoot, facts.profile, progress.plan);

  if (!compiled.ok) {
    /**
     * The compiler's own words, not just "it failed".
     *
     * Everything else a run decides is reconstructable from the persisted
     * record afterwards; a build failure was the exception, because the
     * output only ever reached Luna's prompt. Diagnosing one meant rebuilding
     * the workspace by hand — and a live run had usually overwritten it.
     */
    const reason = firstErrors(compiled.output);
    deps.say({
      phase: 'evaluate',
      detail: `Build failed after ${(compiled.durationMs / 1000).toFixed(1)}s${reason ? `: ${reason}` : ''}`,
      level: 'fail',
    });
  } else {
    deps.say({
      phase: 'evaluate',
      detail: `Build succeeded in ${(compiled.durationMs / 1000).toFixed(1)}s`,
      level: 'ok',
    });
  }

  /**
   * Repairs edit source, never the export.
   *
   * Read separately and unconditionally: when the build fails there is no
   * export at all, and a repair handed an empty file list silently does
   * nothing while still spending the cycle that authorised it.
   */
  const sources = await readSourceFiles(deps.workspace.siteRoot);

  // Every path a gate or a reviewer could cite, mapped to the file that
  // produced it. Rebuilt each cycle because a re-plan changes the routes.
  const sourceOf = Object.fromEntries(
    progress.plan.sitemap.pages.map((page) => [routeToOutputPath(page.route), routeToSourcePath(page.route)]),
  );

  const gatesCertified = compiled.ok ? ['build', ...gateRun.gatesRun] : ['build'];

  // Carried into adjudication so Sol sees the reviewer's verdict, not just
  // the defects it produced.
  let reviewSummary: string | null = null;

  const gateDefects = compiled.ok
    ? gateRun.findings.map(fromGateFinding)
    : [buildFailureDefect(compiled.output)];
  const blockingGates = blocking(gateDefects);

  if (compiled.ok) {
    deps.say({
      phase: 'evaluate',
      detail: `Gates: ${gateRun.findings.length} findings, ${blockingGates.length} blocking`,
      level: blockingGates.length === 0 ? 'ok' : 'warn',
    });
  }

  await deps.registry.put(facts.projectId, 'test-report', {
    passed: compiled.ok && gateRun.passed,
    ranAt: new Date().toISOString(),
    findings: gateRun.findings,
    gatesRun: compiled.ok ? ['build', ...gateRun.gatesRun] : ['build'],
    buildOutput: compiled.ok ? null : compiled.output,
  });

  let defects: Defect[] = gateDefects;

  if (blockingGates.length === 0) {
    deps.say({
      phase: 'evaluate',
      detail:
        progress.repairedSinceReview.length === 0
          ? 'Independent Terra review'
          : `Independent Terra review, re-verifying ${progress.repairedSinceReview.length} repaired defect(s)`,
    });
    let reviewed;
    try {
      // The reviewer judges the same pages the gates judge. Handing it the
      // framework's own error pages invites a rejection nothing can repair.
      const reviewable = files.filter((f) => !isFrameworkPage(f.path));
      reviewed = await reviewSite(deps.model, facts.profile, progress.plan, reviewable, progress.reviewCycle, progress.repairedSinceReview);
    } catch (error) {
      // Reported as its own outcome rather than as an empty review. The caller
      // marks the project blocked with the reason recorded, leaving the
      // accepted artifacts and the workspace intact for a resumed run.
      const message = error instanceof Error ? error.message : String(error);
      deps.say({ phase: 'evaluate', detail: `Review could not complete: ${message}`, level: 'fail' });
      return { kind: 'review_unavailable', reason: message };
    }
    reviewRan = true;
    deps.track('terra', reviewed);
    qualityScore = reviewed.value.qualityScore;

    const reviewDefects = reviewed.value.issues.map(fromReviewIssue);
    defects = [...gateDefects, ...reviewDefects];

    await deps.registry.put(facts.projectId, 'visual-review', {
      ...reviewed.value,
      reviewer: { tier: 'terra', model: reviewed.model, skillVersion: 'terra-review@1' },
      reviewCycle: progress.reviewCycle,
    });

    reviewSummary =
      `  decision ${reviewed.value.decision}, quality ${qualityScore}, blocking=${reviewed.value.blocking}\n` +
      reviewed.value.issues
        .map((i) => `  ${i.severity} ${i.category} ${i.location} — ${i.reason}`)
        .join('\n');

    deps.say({
      phase: 'evaluate',
      detail: `Review: ${reviewed.value.decision}, score ${qualityScore}, ${reviewed.value.issues.length} issues, blocking=${reviewed.value.blocking}`,
      level: reviewed.value.blocking ? 'warn' : 'ok',
    });
  }

  return {
    kind: 'evaluated',
    compiled,
    gateRun,
    sources,
    sourceOf,
    reviewSummary,
    // Collapsed before anything acts on them: the repair budget is charged per
    // fingerprint, so the unit of work has to be the fingerprint too.
    openDefects: mergeByFingerprint(defects),
    qualityScore,
    gatesCertified,
    reviewRan,
  };
}

/**
 * The compiler lines from a build transcript, for the progress record.
 *
 * A failed `next build` emits install noise, a bundler banner and then the
 * errors. Only the last part identifies the defect, and the timeline needs it
 * short enough to read at a glance.
 */
function firstErrors(output: string, limit = 3): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\berror\b|\bError:/i.test(line) && !/^ELIFECYCLE/.test(line));

  if (lines.length === 0) return '';
  const shown = lines.slice(0, limit).join(' · ');
  const rest = lines.length - limit;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}
