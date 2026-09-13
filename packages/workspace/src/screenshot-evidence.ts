/**
 * Durable screenshot evidence: the images one browser capture made of one exact
 * build, stored so a later reviewer can be handed exactly them.
 *
 * Images are written first, as content-addressed blobs, each verified against
 * the hash it was captured with. Only then is one `screenshot-set` artifact
 * written — an ordinary new registry version, never an overwrite — naming the
 * exact subject, the capture policy, every expected target, and for each either
 * the durable image or the reason it has none. So a set never points at an
 * image that is not stored, and a set that is missing anything says so.
 *
 * A second evaluation of the same build writes a second set: evaluation events
 * are additive evidence. Identical bytes are one blob either way.
 *
 * Holds no job, promotion, release or model authority, and reads no "latest"
 * anything: the caller receives the exact reference written.
 */
import { createHash } from 'node:crypto';
import { ScreenshotSet, type ArtifactRef, type BrowserFindingCategory, type ScreenshotCapture } from '@statxai/contracts';
import type { BrowserCaptureOutcome } from './browser-renderer.js';
import type { BlobStore } from './blob-store.js';
import type { ArtifactRegistry } from './registry.js';

export const SCREENSHOT_SET_ARTIFACT = 'screenshot-set';

export interface PersistedScreenshotSet {
  readonly ref: ArtifactRef;
  readonly set: ScreenshotSet;
}

/**
 * Store every captured image, then the one set that describes them all.
 *
 * A capture whose image cannot be stored is recorded as `storage_failed`, with
 * no image — never as captured. The set is validated against its contract
 * before it is written; if the registry write fails, nothing claims the images
 * exist (they remain as unreferenced, content-addressed blobs).
 */
export async function persistScreenshotSet(input: {
  readonly registry: ArtifactRegistry;
  readonly blobs: BlobStore;
  readonly projectId: string;
  readonly outcome: BrowserCaptureOutcome;
}): Promise<PersistedScreenshotSet> {
  const { report, captures, policy } = input.outcome;
  const renders = new Map(report.renders.map((render) => [`${render.route}\0${render.viewport}`, render]));

  const described: ScreenshotCapture[] = [];
  let totalBytes = 0;
  for (const capture of captures) {
    const render = renders.get(`${capture.route}\0${capture.viewport.name}`);
    const findingCategories = [...new Set((render?.findings ?? []).map((f) => f.category))].sort() as BrowserFindingCategory[];
    const base = {
      route: capture.route,
      viewport: capture.viewport,
      renderStatus: render?.status ?? 'not_run',
      findingCategories,
      page: capture.page,
      truncated: capture.truncated,
    } as const;

    if (capture.reason !== 'captured' || capture.png === null || capture.width === null || capture.height === null) {
      described.push({ ...base, reason: capture.reason === 'captured' ? 'invalid_image' : capture.reason, image: null, detail: capture.detail });
      continue;
    }

    const sha256 = createHash('sha256').update(capture.png).digest('hex');
    try {
      const stored = await input.blobs.put(capture.png, 'image/png');
      if (stored.sha256 !== sha256 || stored.bytes !== capture.png.length) throw new Error('stored blob does not match the captured bytes');
      totalBytes += stored.bytes;
      described.push({
        ...base,
        reason: 'captured',
        image: { blob: stored.blob, sha256, bytes: stored.bytes, width: capture.width, height: capture.height, contentType: 'image/png' },
        detail: capture.detail,
      });
    } catch (error) {
      described.push({ ...base, reason: 'storage_failed', image: null, detail: error instanceof Error ? error.name : 'storage failure' });
    }
  }

  const capturedCount = described.filter((c) => c.image !== null).length;
  const set = ScreenshotSet.parse({
    subject: report.subject,
    policy,
    browser: { status: report.status, passed: report.passed, runtime: report.runtime, reason: report.reason },
    expectedCaptures: captures.length,
    capturedCount,
    missingCount: captures.length - capturedCount,
    complete: captures.length > 0 && capturedCount === captures.length && report.status === 'completed',
    totalBytes,
    omittedRoutes: report.omittedRoutes,
    captures: described,
  });

  const ref = await input.registry.put(input.projectId, SCREENSHOT_SET_ARTIFACT, set);
  return { ref, set };
}
