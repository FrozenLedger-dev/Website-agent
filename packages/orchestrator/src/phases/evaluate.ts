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
import {
  routeToOutputPath,
  routeToSourcePath,
  type ArtifactRef,
  type BrowserRenderAuthority,
  type BrowserRenderReport,
  type BusinessProfile,
  type EditableSiteModel,
  type SitePlan,
} from '@statxai/contracts';
import { reviewSite } from '@statxai/agents';
import { isFrameworkPage, runGates, siteModelMarkerFindings } from '@statxai/gates';
import {
  BlobStore,
  buildSite as compileSite,
  captureInBrowser,
  persistScreenshotSet,
  readBuiltFiles,
  readExportFiles,
  readSourceFiles,
  type BuildResult,
} from '@statxai/workspace';
import { reviewScreenshotSetVisually, type VisualQualityReviewOutcome } from './visual-review.js';
import { resolveEditableSiteModel } from '../site-model/persist.js';
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
export async function runDeterministicGates(
  siteRoot: string,
  profile: BusinessProfile,
  plan: SitePlan,
  signal?: AbortSignal,
  /**
   * The exact editable site model the build must carry. When given, the
   * site-model gate proves the export's semantic identity and values against it
   * — for official validation, advisory tests and canonical evaluation alike.
   */
  siteModel?: EditableSiteModel | null,
) {
  // Sandboxed: the build executes model-authored code, never with the harness's privileges.
  const compiled = await compileSite(siteRoot, signal !== undefined ? { signal } : {});
  // A cancelled measurement stops here — no gate runs on a build nobody is waiting for.
  signal?.throwIfAborted();

  // Gates read the static export — the markup a visitor and a crawler
  // actually receive — rather than the TSX that produced it.
  const files = compiled.ok ? await readBuiltFiles(siteRoot) : [];

  // Every path in the export, so existence checks see the assets no gate
  // parses — scripts, fonts, icons — instead of reporting them missing.
  const assets = compiled.ok ? (await readExportFiles(siteRoot)).map((f) => f.path) : [];

  const measured = compiled.ok
    ? runGates({ files, profile, plan, assets })
    : { passed: false, findings: [], gatesRun: ['build'] };
  const identity = compiled.ok && siteModel ? siteModelMarkerFindings(siteModel, files) : [];
  const gateRun = siteModel && compiled.ok
    ? { passed: measured.passed && identity.length === 0, findings: [...measured.findings, ...identity], gatesRun: [...measured.gatesRun, 'site-model'] }
    : measured;

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
  /**
   * What real Chromium found rendering the exact export at every planned route
   * and viewport — null when there was no export to render. Evidence only:
   * it adds no defect and blocks nothing yet.
   */
  browserRender: BrowserRenderReport | null;
  /** The exact `test-report` artifact this evaluation wrote — its deterministic gate results. */
  testReport: ArtifactRef;
  /**
   * The exact `screenshot-set` artifact this evaluation wrote — every capture of
   * the rendered build, bound to its subject — or null when nothing was
   * rendered. Handed on by reference: nothing looks it up again.
   */
  screenshotSet: ArtifactRef | null;
  /**
   * Terra's multimodal review of exactly that screenshot set — its exact
   * reference and content — or null when there was no set. Advisory: it adds
   * no defect and blocks nothing.
   */
  visualQualityReview: VisualQualityReviewOutcome | null;
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

/** Exactly what an evaluation measures: the plan version, the editable site model it must carry, and what made the tree canonical. */
export interface EvaluationSubject {
  readonly sitePlan: ArtifactRef;
  /** The exact model the canonical build pinned, or null for a build that predates the model. */
  readonly editableSiteModel: ArtifactRef | null;
  readonly authority: BrowserRenderAuthority;
}

/** An evaluation was handed a model that does not describe the plan it evaluates. */
export class EvaluationSiteModelMismatch extends Error {
  constructor(detail: string) {
    super(`evaluation refused: ${detail}`);
    this.name = 'EvaluationSiteModelMismatch';
  }
}

export async function evaluateSite(ctx: RunContext, subject: EvaluationSubject): Promise<EvaluationOutcome> {
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
  // The exact model the canonical build carries — resolved by its pinned ref, never "the latest model".
  const siteModel = subject.editableSiteModel ? await resolveEditableSiteModel(deps.registry, facts.projectId, subject.editableSiteModel) : null;
  if (siteModel && (siteModel.sitePlan.name !== subject.sitePlan.name || siteModel.sitePlan.version !== subject.sitePlan.version)) {
    throw new EvaluationSiteModelMismatch(`the editable site model describes ${siteModel.sitePlan.name}@${siteModel.sitePlan.version}, not ${subject.sitePlan.name}@${subject.sitePlan.version}`);
  }

  deps.say({ phase: 'evaluate', detail: 'Compiling the site' });
  const { compiled, files, gateRun } = await runDeterministicGates(deps.workspace.siteRoot, facts.profile, progress.plan, undefined, siteModel);

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
   * The exact export, rendered in a real browser at every planned route and
   * viewport — after the deterministic gates, before review. Isolated in its
   * own container, bound to the exact plan version, revision and export it
   * rendered, and advisory: it changes no defect, gate or release decision in
   * this slice.
   */
  const captured = compiled.ok
    ? await captureInBrowser({
        exportDir: compiled.outDir,
        plan: progress.plan,
        subject: {
          projectId: facts.projectId,
          sitePlan: subject.sitePlan,
          sourceCommit: await deps.workspace.currentCommit(),
          authority: subject.authority,
        },
      })
    : null;
  const browserRender = captured?.report ?? null;

  if (browserRender) {
    const blocked = browserRender.renders.filter((r) => r.status !== 'rendered').length;
    deps.say({
      phase: 'evaluate',
      detail:
        browserRender.status === 'completed'
          ? `Browser render: ${browserRender.renders.length} route×viewport renders, ${blocked} not clean`
          : `Browser render ${browserRender.status}: ${browserRender.reason ?? ''}`,
      level: browserRender.passed ? 'ok' : 'warn',
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

  const testReport = await deps.registry.put(facts.projectId, 'test-report', {
    passed: compiled.ok && gateRun.passed,
    ranAt: new Date().toISOString(),
    findings: gateRun.findings,
    gatesRun: compiled.ok ? ['build', ...gateRun.gatesRun] : ['build'],
    buildOutput: compiled.ok ? null : compiled.output,
  });

  // The screenshots of this exact build, recorded after its gate results and before any review of it.
  // Images first, then the one set that names them: never a set pointing at a missing image.
  const screenshots = captured
    ? await persistScreenshotSet({ registry: deps.registry, blobs: new BlobStore(deps.store), projectId: facts.projectId, outcome: captured })
    : null;
  if (screenshots) {
    deps.say({
      phase: 'evaluate',
      detail: `Screenshots: ${screenshots.set.capturedCount}/${screenshots.set.expectedCaptures} captured (${screenshots.ref.name}@${screenshots.ref.version})`,
      level: screenshots.set.complete ? 'ok' : 'warn',
    });
  }

  // Terra looks at the exact screenshots just written — by reference, never "the latest".
  const visualQualityReview = screenshots
    ? await reviewScreenshotSetVisually(
        { registry: deps.registry, blobs: new BlobStore(deps.store), model: deps.model },
        { projectId: facts.projectId, profile: facts.profile, plan: progress.plan, screenshotSet: screenshots.ref, browserRender },
      )
    : null;
  if (visualQualityReview) {
    const { review } = visualQualityReview;
    deps.say({
      phase: 'evaluate',
      detail:
        review.status === 'reviewed'
          ? `Visual review: overall ${review.assessment!.overallScore}, ${review.assessment!.issues.length} issues, ${review.coverage.reviewedTargets}/${review.coverage.expectedTargets} targets`
          : `Visual review ${review.status}${review.failure ? `: ${review.failure.detail}` : ''}`,
      level: review.status === 'reviewed' ? 'ok' : 'warn',
    });
  }

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
    browserRender,
    testReport,
    screenshotSet: screenshots?.ref ?? null,
    visualQualityReview,
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
