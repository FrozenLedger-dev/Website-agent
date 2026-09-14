/**
 * Multimodal visual quality review of one exact screenshot set.
 *
 * The set is read by the exact reference this evaluation wrote, and every image
 * by the exact blob key it names, re-hashed against the sha256 it records — a
 * missing or altered image fails the review closed before any model sees
 * anything. Images are cut into review frames (policy
 * `statxai-visual-review-frames@1`) within a fixed budget; targets without a
 * screenshot, or beyond the budget, are listed and never presented as reviewed.
 *
 * Terra is invoked once, through the model runtime, with the frames as images.
 * Its answer must describe only targets it was shown. Whatever happens — a
 * review, no evidence, invalid evidence, a refusal, a provider failure, a
 * malformed answer — one `visual-quality-review` artifact records it, bound to
 * the screenshot set, and the exact reference is returned.
 *
 * Advisory: no defect, no gate, no release decision changes here. No tools, no
 * files, no build output — review only.
 */
import { createHash } from 'node:crypto';
import {
  ScreenshotSet,
  VISUAL_REVIEW_FRAME_POLICY_VERSION,
  VISUAL_REVIEW_SCHEMA_VERSION,
  VisualQualityReview,
  type ArtifactRef,
  type BrowserRenderReport,
  type BusinessProfile,
  type ScreenshotCapture,
  type SitePlan,
  type VisualQualityAssessment,
  type VisualReviewFrame,
  type VisualReviewStatus,
} from '@statxai/contracts';
import { MalformedModelOutput, ModelRefusal, reviewVisualQuality, type ModelRuntime, type VisualReviewImage } from '@statxai/agents';
import {
  MAX_FRAMES_PER_CAPTURE,
  MAX_REVIEW_FRAMES,
  MAX_REVIEW_FRAME_BYTES,
  frameOffsets,
  frameScreenshot,
  sanitizeSandboxOutput,
  type ArtifactRegistry,
  type BlobStore,
} from '@statxai/workspace';

export const VISUAL_QUALITY_REVIEW_ARTIFACT = 'visual-quality-review';

export interface VisualQualityReviewOutcome {
  readonly ref: ArtifactRef;
  readonly review: VisualQualityReview;
}

export interface VisualReviewDeps {
  readonly registry: ArtifactRegistry;
  readonly blobs: BlobStore;
  readonly model: ModelRuntime;
}

/** A capture's frames under a per-capture limit, computed from metadata alone. */
function frameCount(capture: ScreenshotCapture, perCapture: number): number {
  return frameOffsets(capture.image!.height, capture.viewport.height, perCapture).length;
}

/** A screenshot image could not be used: missing, altered, or not a decodable PNG. */
class EvidenceInvalid extends Error {}

export async function reviewScreenshotSetVisually(
  deps: VisualReviewDeps,
  input: {
    readonly projectId: string;
    readonly profile: BusinessProfile;
    readonly plan: SitePlan;
    /** The exact set this evaluation wrote. */
    readonly screenshotSet: ArtifactRef;
    readonly browserRender: BrowserRenderReport | null;
  },
): Promise<VisualQualityReviewOutcome> {
  const set = ScreenshotSet.parse(await deps.registry.resolve(input.projectId, input.screenshotSet));

  const missing = set.captures
    .filter((c) => c.image === null)
    .map((c) => ({ route: c.route, viewport: c.viewport.name, reason: c.reason }));
  const captured = set.captures.filter((c) => c.image !== null);

  // The frame budget, decided from metadata before any image is read: fewer
  // frames per capture first, then — in the set's own target order — captures
  // beyond the budget are left unreviewed and named.
  let perCapture = MAX_FRAMES_PER_CAPTURE;
  while (perCapture > 1 && captured.reduce((sum, c) => sum + frameCount(c, perCapture), 0) > MAX_REVIEW_FRAMES) perCapture -= 1;
  const planned: ScreenshotCapture[] = [];
  const notReviewed: { route: string; viewport: ScreenshotCapture['viewport']['name'] }[] = [];
  let plannedFrames = 0;
  for (const capture of captured) {
    const count = frameCount(capture, perCapture);
    if (plannedFrames + count > MAX_REVIEW_FRAMES) notReviewed.push({ route: capture.route, viewport: capture.viewport.name });
    else {
      planned.push(capture);
      plannedFrames += count;
    }
  }

  const persist = async (
    status: VisualReviewStatus,
    fields: { frames?: VisualReviewFrame[]; reviewed?: number; assessment?: VisualQualityAssessment | null; failure?: string | null; reviewer?: VisualQualityReview['reviewer'] },
  ): Promise<VisualQualityReviewOutcome> => {
    const reviewedTargets = status === 'reviewed' ? (fields.reviewed ?? 0) : 0;
    const review = VisualQualityReview.parse({
      schemaVersion: VISUAL_REVIEW_SCHEMA_VERSION,
      framePolicyVersion: VISUAL_REVIEW_FRAME_POLICY_VERSION,
      screenshotSet: input.screenshotSet,
      screenshotPolicyVersion: set.policy.version,
      subject: set.subject,
      status,
      coverage: {
        expectedTargets: set.expectedCaptures,
        reviewedTargets,
        missing,
        notReviewed,
        complete: status === 'reviewed' && set.complete && missing.length === 0 && notReviewed.length === 0 && reviewedTargets === set.expectedCaptures,
      },
      frames: fields.frames ?? [],
      assessment: status === 'reviewed' ? (fields.assessment ?? null) : null,
      failure: fields.failure ? { kind: status, detail: sanitizeSandboxOutput(fields.failure).slice(0, 500) } : null,
      reviewer: fields.reviewer ?? null,
    });
    const ref = await deps.registry.put(input.projectId, VISUAL_QUALITY_REVIEW_ARTIFACT, review);
    return { ref, review };
  };

  if (planned.length === 0) {
    return persist('no_evidence', { failure: captured.length === 0 ? 'The screenshot set holds no captured image.' : 'No capture fits the review budget.' });
  }

  // Read every image by its exact key, verify it, and cut its frames.
  const frames: VisualReviewFrame[] = [];
  const images: VisualReviewImage[] = [];
  const reviewed: ScreenshotCapture[] = [];
  let frameBytes = 0;
  try {
    for (const capture of planned) {
      const image = capture.image!;
      let bytes: Buffer;
      try {
        bytes = await deps.blobs.get(image.blob);
      } catch (error) {
        throw new EvidenceInvalid(`${capture.route} @ ${capture.viewport.name}: ${error instanceof Error ? error.name : 'unreadable'} for ${image.blob}`);
      }
      if (createHash('sha256').update(bytes).digest('hex') !== image.sha256 || bytes.length !== image.bytes) {
        throw new EvidenceInvalid(`${capture.route} @ ${capture.viewport.name}: stored image does not match the screenshot set's sha256`);
      }
      let cut: ReturnType<typeof frameScreenshot>;
      try {
        cut = frameScreenshot(bytes, capture.viewport.height, perCapture);
      } catch (error) {
        throw new EvidenceInvalid(`${capture.route} @ ${capture.viewport.name}: ${error instanceof Error ? error.message : 'undecodable image'}`);
      }
      const size = cut.reduce((sum, f) => sum + f.png.length, 0);
      if (frameBytes + size > MAX_REVIEW_FRAME_BYTES) {
        notReviewed.push({ route: capture.route, viewport: capture.viewport.name });
        continue;
      }
      frameBytes += size;
      reviewed.push(capture);
      for (const frame of cut) {
        frames.push({
          route: capture.route,
          viewport: capture.viewport.name,
          index: frame.index,
          count: frame.count,
          offsetY: frame.offsetY,
          width: frame.width,
          height: frame.height,
          sha256: frame.sha256,
          sourceSha256: image.sha256,
          sourceHeight: image.height,
        });
        images.push({ route: capture.route, viewport: capture.viewport.name, index: frame.index, count: frame.count, offsetY: frame.offsetY, sourceHeight: image.height, png: frame.png });
      }
    }
  } catch (error) {
    if (!(error instanceof EvidenceInvalid)) throw error;
    // Fail closed: no substitute image, no partial review.
    return persist('evidence_invalid', { failure: error.message });
  }

  if (images.length === 0) return persist('no_evidence', { failure: 'No capture fits the review byte budget.' });

  const browserFindings = (input.browserRender?.renders ?? [])
    .filter((r) => r.findings.length > 0)
    .map((r) => `${r.route} @ ${r.viewport}: ${[...new Set(r.findings.map((f) => f.category))].join(', ')}`)
    .slice(0, 40);

  let result: Awaited<ReturnType<typeof reviewVisualQuality>>;
  try {
    result = await reviewVisualQuality(deps.model, {
      profile: input.profile,
      plan: input.plan,
      frames: images,
      missing,
      notReviewed,
      browserFindings,
    });
  } catch (error) {
    const status: VisualReviewStatus = error instanceof ModelRefusal ? 'refused' : error instanceof MalformedModelOutput ? 'malformed_output' : 'provider_failed';
    return persist(status, { frames, failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }

  const reviewer: VisualQualityReview['reviewer'] = {
    skill: 'terra-review',
    tier: 'terra',
    model: result.model,
    invocationId: result.invocationId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };

  // The answer may only speak about what was shown.
  const shown = new Set(reviewed.map((c) => `${c.route}\0${c.viewport.name}`));
  const shownRoutes = new Set(reviewed.map((c) => c.route));
  const assessment = result.value;
  const unseen = [
    ...assessment.routeReviews.flatMap((r) => r.viewports.map((v) => [r.route, v] as const)),
    ...assessment.issues.flatMap((i) => i.viewports.map((v) => [i.route, v] as const)),
    ...assessment.antiPatterns.flatMap((a) => a.viewports.map((v) => [a.route, v] as const)),
  ].filter(([route, viewport]) => !shown.has(`${route}\0${viewport}`));
  const unseenRoutes = assessment.refinementPriorities.filter((p) => p.route !== undefined && !shownRoutes.has(p.route));
  if (unseen.length > 0 || unseenRoutes.length > 0) {
    const named = [...unseen.map(([r, v]) => `${r} @ ${v}`), ...unseenRoutes.map((p) => String(p.route))];
    return persist('malformed_output', { frames, reviewer, failure: `The review describes targets it was not shown: ${[...new Set(named)].slice(0, 10).join(', ')}` });
  }

  return persist('reviewed', { frames, reviewed: reviewed.length, assessment, reviewer });
}

/** The frames a review recorded could not be reproduced byte-for-byte from the screenshot set it names. */
export class ReviewFramesNotReproducible extends Error {
  constructor(detail: string) {
    super(`visual review frames cannot be reproduced exactly: ${detail}`);
    this.name = 'ReviewFramesNotReproducible';
  }
}

/**
 * The exact images a recorded review judged, recut from the durable screenshots
 * of the exact set it names — for a later reader (a refinement) that must see
 * what the reviewer saw, never a newer or re-rendered capture.
 *
 * Every image is read by its exact blob key and re-hashed against the set; every
 * frame is recut under the same policy and must match the review's recorded
 * frame sha256, offset and size exactly. Anything else fails closed.
 */
export async function reproduceReviewFrames(
  deps: Pick<VisualReviewDeps, 'registry' | 'blobs'>,
  projectId: string,
  review: VisualQualityReview,
): Promise<VisualReviewImage[]> {
  if (review.framePolicyVersion !== VISUAL_REVIEW_FRAME_POLICY_VERSION) {
    throw new ReviewFramesNotReproducible(`frame policy ${review.framePolicyVersion} is not ${VISUAL_REVIEW_FRAME_POLICY_VERSION}`);
  }
  const set = ScreenshotSet.parse(await deps.registry.resolve(projectId, review.screenshotSet));
  const images: VisualReviewImage[] = [];
  const cutByTarget = new Map<string, ReturnType<typeof frameScreenshot>>();
  for (const frame of review.frames) {
    const key = `${frame.route}\0${frame.viewport}`;
    let cut = cutByTarget.get(key);
    const capture = set.captures.find((c) => c.route === frame.route && c.viewport.name === frame.viewport);
    if (!capture?.image) throw new ReviewFramesNotReproducible(`${frame.route} @ ${frame.viewport} has no screenshot in ${review.screenshotSet.name}@${review.screenshotSet.version}`);
    if (capture.image.sha256 !== frame.sourceSha256) throw new ReviewFramesNotReproducible(`${frame.route} @ ${frame.viewport} names a different screenshot`);
    if (!cut) {
      const bytes = await deps.blobs.get(capture.image.blob);
      if (createHash('sha256').update(bytes).digest('hex') !== capture.image.sha256 || bytes.length !== capture.image.bytes) {
        throw new ReviewFramesNotReproducible(`${frame.route} @ ${frame.viewport}: stored image does not match the screenshot set's sha256`);
      }
      cut = frameScreenshot(bytes, capture.viewport.height, frame.count);
      cutByTarget.set(key, cut);
    }
    const recut = cut.find((c) => c.index === frame.index);
    if (!recut || recut.count !== frame.count || recut.sha256 !== frame.sha256 || recut.offsetY !== frame.offsetY || recut.width !== frame.width || recut.height !== frame.height) {
      throw new ReviewFramesNotReproducible(`${frame.route} @ ${frame.viewport} frame ${frame.index} does not recut to the recorded frame`);
    }
    images.push({ route: frame.route, viewport: frame.viewport, index: frame.index, count: frame.count, offsetY: frame.offsetY, sourceHeight: frame.sourceHeight, png: recut.png });
  }
  return images;
}

/** A compact, exact account of a visual review for Sol — named by its reference, never looked up. */
export function summarizeVisualReview(outcome: VisualQualityReviewOutcome): string {
  const { ref, review } = outcome;
  const header = `  ${ref.name}@${ref.version} of ${review.screenshotSet.name}@${review.screenshotSet.version} — ${review.status}; reviewed ${review.coverage.reviewedTargets}/${review.coverage.expectedTargets} targets${review.coverage.complete ? '' : ' (coverage incomplete)'}`;
  if (review.status !== 'reviewed' || !review.assessment) return `${header}\n  ${review.failure?.detail ?? 'no assessment'}`;
  const a = review.assessment;
  return [
    header,
    `  overall ${a.overallScore}; ${Object.entries(a.scores).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `  ${a.summary}`,
    ...a.issues.slice(0, 12).map((i) => `  ${i.id} [${i.severity} ${i.dimension}] ${i.route} (${i.viewports.join('/')}) — ${i.problem}`),
    ...a.refinementPriorities.slice(0, 5).map((p) => `  priority ${p.rank}: ${p.dimension}${p.route ? ` on ${p.route}` : ''} — ${p.direction}`),
  ].join('\n');
}
