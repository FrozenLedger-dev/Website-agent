/**
 * The multimodal visual review phase against real storage: an exact screenshot
 * set in the registry, real PNG blobs, real frame derivation, the real model
 * runtime with a scripted provider that records what it was sent.
 *
 * Integration: needs the Mongo replica set.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Binary } from 'mongodb';
import {
  SCREENSHOT_POLICY_VERSION,
  VISUAL_REVIEW_FRAME_POLICY_VERSION,
  VISUAL_REVIEW_SCHEMA_VERSION,
  VisualQualityReview,
  type SitePlan,
} from '@statxai/contracts';
import { ModelRuntime, type ModelUsageEvent, type Provider, type ProviderRequest } from '@statxai/agents';
import { StateStore } from '@statxai/state';
import {
  ArtifactRegistry,
  BROWSER_IMAGE,
  BROWSER_VIEWPORTS,
  BlobStore,
  PLAYWRIGHT_VERSION,
  SCREENSHOT_POLICY,
  persistScreenshotSet,
  type BrowserCapture,
} from '@statxai/workspace';
import { VISUAL_QUALITY_REVIEW_ARTIFACT, reviewScreenshotSetVisually, summarizeVisualReview } from '../src/phases/visual-review.js';

let store: StateStore;
let registry: ArtifactRegistry;
let blobs: BlobStore;

beforeAll(async () => {
  store = await StateStore.connect({ uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/statxai_test?replicaSet=rs0', dbName: 'statxai_test' });
  await store.ensureIndexes();
  registry = new ArtifactRegistry(store);
  blobs = new BlobStore(store);
});

afterAll(async () => {
  await store?.close();
});

beforeEach(async () => {
  await store.artifacts.deleteMany({ projectId: PROJECT });
  await store.blobs.deleteMany({});
});

const PROJECT = 'proj_visual_review';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, body: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
};
/** A real RGB PNG, each row coloured by its y so frames from different offsets differ. */
function png(width: number, height: number, seed: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row.fill((seed + (y >> 4)) & 0xff, 1);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const SUBJECT = {
  projectId: PROJECT,
  sitePlan: { name: 'site-plan', version: 4 },
  sourceCommit: 'd00d000000000000000000000000000000000000',
  exportDigest: 'e'.repeat(64),
  authority: { mode: 'job_lifecycle' as const, buildBindingId: 'binding_vr', promotionId: 'promotion_vr', promotionCommitSha: 'f'.repeat(40) },
};

const profile = { businessName: 'Harrowgate Joinery', industry: 'Joinery', location: 'Harrogate', audience: 'Homeowners', tone: 'Warm' } as never;
const plan = {
  brandSystem: { artDirection: 'workshop' },
  sitemap: { pages: [{ route: '/', title: 'Home', goal: 'g', primaryAction: 'call' }, { route: '/services', title: 'Services', goal: 'g', primaryAction: 'quote' }] },
} as unknown as SitePlan;

const [DESKTOP, TABLET, MOBILE] = BROWSER_VIEWPORTS as [typeof BROWSER_VIEWPORTS[0], typeof BROWSER_VIEWPORTS[0], typeof BROWSER_VIEWPORTS[0]];
const capture = (route: string, viewport: typeof DESKTOP, height: number, seed: number): BrowserCapture => {
  const bytes = png(viewport.width, height, seed);
  return { route, viewport, reason: 'captured', page: { width: viewport.width, height }, truncated: false, png: bytes, width: viewport.width, height, detail: null };
};
const missing = (route: string, viewport: typeof DESKTOP): BrowserCapture => ({ route, viewport, reason: 'render_not_ready', page: null, truncated: false, png: null, width: null, height: null, detail: null });

async function writeSet(captures: BrowserCapture[]) {
  return persistScreenshotSet({
    registry,
    blobs,
    projectId: PROJECT,
    outcome: {
      report: {
        subject: SUBJECT,
        runtime: { playwright: PLAYWRIGHT_VERSION, image: BROWSER_IMAGE },
        viewports: [...BROWSER_VIEWPORTS],
        status: 'completed',
        renders: captures.map((c) => ({ route: c.route, viewport: c.viewport.name, status: c.png ? 'rendered' : 'failed', httpStatus: c.png ? 200 : 404, navigationMs: 1, readyMs: 1, findings: c.png ? [] : [{ category: 'http_error' as const, route: c.route, viewport: c.viewport.name, detail: 'HTTP 404' }] })),
        omittedRoutes: [],
        passed: captures.every((c) => c.png),
        truncated: false,
        durationMs: 1,
        reason: null,
      },
      captures,
      policy: SCREENSHOT_POLICY,
    },
  });
}

const ASSESSMENT = {
  overallScore: 61,
  scores: { composition: 58, typography: 66, spacingRhythm: 52, hierarchy: 63, brandDistinctiveness: 44, assetQuality: 57, conversionClarity: 72, mobileQuality: 59 },
  summary: 'A competent but generic joinery site.',
  routeReviews: [
    { route: '/', viewports: ['desktop', 'tablet', 'mobile'], score: 60, summary: 'Centred hero, equal cards.' },
    { route: '/services', viewports: ['desktop', 'tablet'], score: 62, summary: 'Long, uniform sections.' },
  ],
  strengths: ['Clear call to action'],
  issues: [
    { id: 'VQ-001', route: '/', viewports: ['mobile'], dimension: 'mobileQuality', severity: 'major', problem: 'Desktop sections stacked unchanged.', direction: 'Recompose the hero for a narrow screen.' },
    { id: 'VQ-002', route: '/services', viewports: ['desktop'], dimension: 'spacingRhythm', severity: 'moderate', problem: 'Identical section padding down the page.', direction: 'Vary rhythm between feature and list sections.' },
  ],
  antiPatterns: [{ pattern: 'three_equal_cards', route: '/', viewports: ['desktop'] }],
  refinementPriorities: [{ rank: 1, dimension: 'brandDistinctiveness', direction: 'Give the site a workshop identity.' }, { rank: 2, dimension: 'mobileQuality', route: '/', direction: 'Design the mobile hero.' }],
};

function model(answer: unknown | (() => never)) {
  const requests: ProviderRequest[] = [];
  const usage: ModelUsageEvent[] = [];
  const provider: Provider = {
    name: 'scripted',
    schemaDialect: 'strict',
    async complete(request) {
      requests.push(request);
      if (typeof answer === 'function') return (answer as () => never)();
      if (answer && typeof answer === 'object' && 'stopReason' in (answer as object)) return { text: '', model: 'm', inputTokens: 1, outputTokens: 1, ...(answer as object) } as never;
      return { text: JSON.stringify(answer), model: 'gpt-5.6-terra', inputTokens: 5000, outputTokens: 800, stopReason: 'complete' };
    },
  };
  return { runtime: new ModelRuntime({ provider, onUsage: (e) => usage.push(e) }), requests, usage };
}

/** Desktop / tablet / mobile for "/", desktop (very tall) and tablet for "/services", and a missing "/services" mobile. */
async function standardSet() {
  return writeSet([
    capture('/', DESKTOP, 900, 10),
    capture('/', TABLET, 1024, 20),
    capture('/', MOBILE, 1700, 30),
    capture('/services', DESKTOP, 16_000, 40),
    capture('/services', TABLET, 1024, 50),
    missing('/services', MOBILE),
  ]);
}

const review = (runtime: ModelRuntime, ref: Awaited<ReturnType<typeof standardSet>>['ref']) =>
  reviewScreenshotSetVisually({ registry, blobs, model: runtime }, { projectId: PROJECT, profile, plan, screenshotSet: ref, browserRender: null });

describe('reviewing the exact screenshot set', () => {
  it('sends real frames of every captured target, and persists a review bound to exactly that set', async () => {
    const { ref: setRef, set } = await standardSet();
    const blobBefore = await store.blobs.findOne({ _id: find(set, '/services', 'desktop').image!.blob });
    const { runtime, requests, usage } = model(ASSESSMENT);

    const { ref, review: persisted } = await review(runtime, setRef);

    // One model call, one usage event.
    expect(requests).toHaveLength(1);
    expect(usage).toHaveLength(1);
    const images = requests[0]!.images!;
    const labels = images.map((i) => i.label);
    for (const target of ['/ @ desktop', '/ @ tablet', '/ @ mobile', '/services @ desktop', '/services @ tablet']) {
      expect(labels.some((l) => l.includes(`: ${target} —`))).toBe(true);
    }
    expect(labels.some((l) => l.includes('/services @ mobile'))).toBe(false);

    // Each image sent is exactly a recorded frame, and a real PNG — not a description.
    expect(images.map((i) => sha(Buffer.from(i.data)))).toEqual(persisted.frames.map((f) => f.sha256));
    expect(images.every((i) => Buffer.from(i.data).subarray(1, 4).toString('latin1') === 'PNG')).toBe(true);

    // The tall page is framed top to bottom, not reduced to its hero.
    const tall = persisted.frames.filter((f) => f.route === '/services' && f.viewport === 'desktop');
    expect(tall.map((f) => [f.index, f.count, f.offsetY, f.height])).toEqual([[1, 4, 0, 900], [2, 4, 5033, 900], [3, 4, 10067, 900], [4, 4, 15100, 900]]);
    expect(tall.every((f) => f.sourceSha256 === find(set, '/services', 'desktop').image!.sha256 && f.sourceHeight === 16_000)).toBe(true);
    // The mobile page, a little over two screens tall, gets every frame, the last flush with its bottom.
    expect(persisted.frames.filter((f) => f.route === '/' && f.viewport === 'mobile').map((f) => f.offsetY)).toEqual([0, 844, 856]);

    // The durable screenshot is unchanged.
    expect(await store.blobs.findOne({ _id: find(set, '/services', 'desktop').image!.blob })).toEqual(blobBefore);

    expect(ref).toMatchObject({ name: VISUAL_QUALITY_REVIEW_ARTIFACT, version: 1 });
    expect(await registry.resolve(PROJECT, ref)).toEqual(persisted);
    expect(persisted).toMatchObject({
      schemaVersion: VISUAL_REVIEW_SCHEMA_VERSION,
      framePolicyVersion: VISUAL_REVIEW_FRAME_POLICY_VERSION,
      screenshotSet: setRef,
      screenshotPolicyVersion: SCREENSHOT_POLICY_VERSION,
      subject: SUBJECT,
      status: 'reviewed',
      failure: null,
      reviewer: { skill: 'terra-review', tier: 'terra', model: 'gpt-5.6-terra', inputTokens: 5000, outputTokens: 800 },
    });
    expect(persisted.assessment).toEqual(ASSESSMENT);
    expect(persisted.assessment!.issues.map((i) => [i.route, i.viewports])).toEqual([['/', ['mobile']], ['/services', ['desktop']]]);
    // The missing target is named, never reviewed, and the review does not claim full coverage.
    expect(persisted.coverage).toEqual({
      expectedTargets: 6,
      reviewedTargets: 5,
      missing: [{ route: '/services', viewport: 'mobile', reason: 'render_not_ready' }],
      notReviewed: [],
      complete: false,
    });
    expect(summarizeVisualReview({ ref, review: persisted })).toContain(`visual-quality-review@1 of screenshot-set@${setRef.version}`);
  });

  it('reads the set it is given, not a newer one', async () => {
    const first = await standardSet();
    await writeSet([capture('/', DESKTOP, 900, 99)]);
    const { runtime, requests } = model(ASSESSMENT);

    const { review: persisted } = await review(runtime, first.ref);

    expect(persisted.screenshotSet).toEqual(first.ref);
    expect(requests[0]!.images!.length).toBe(persisted.frames.length);
    expect(persisted.frames.find((f) => f.route === '/' && f.viewport === 'desktop')!.sourceSha256).toBe(find(first.set, '/', 'desktop').image!.sha256);
  });

  it('a review of a target it was not shown is malformed, and no assessment is kept', async () => {
    const { ref: setRef } = await standardSet();
    const lying = { ...ASSESSMENT, issues: [{ ...ASSESSMENT.issues[0], route: '/services', viewports: ['mobile'] }] };
    const { review: persisted } = await review(model(lying).runtime, setRef);

    expect(persisted.status).toBe('malformed_output');
    expect(persisted.assessment).toBeNull();
    expect(persisted.failure?.detail).toContain('/services @ mobile');
  });

  it('repeated review adds evidence and preserves the earlier review', async () => {
    const { ref: setRef } = await standardSet();
    const first = await review(model(ASSESSMENT).runtime, setRef);
    const stored = await store.artifacts.findOne({ projectId: PROJECT, name: VISUAL_QUALITY_REVIEW_ARTIFACT, version: 1 });
    const second = await review(model(ASSESSMENT).runtime, setRef);

    expect([first.ref.version, second.ref.version]).toEqual([1, 2]);
    expect(await store.artifacts.findOne({ projectId: PROJECT, name: VISUAL_QUALITY_REVIEW_ARTIFACT, version: 1 })).toEqual(stored);
  });
});

describe('failing closed, and keeping failures distinct', () => {
  it('a screenshot whose stored bytes do not match its sha256 stops the review before any model call', async () => {
    const { ref: setRef, set } = await standardSet();
    // Rewritten under a different key's document: its own key no longer matches, and neither does the set's hash.
    await store.blobs.updateOne({ _id: find(set, '/', 'tablet').image!.blob }, { $set: { data: new Binary(png(768, 1024, 77)) } });
    const { runtime, requests, usage } = model(ASSESSMENT);

    const { review: persisted } = await review(runtime, setRef);

    expect(persisted.status).toBe('evidence_invalid');
    expect(persisted.failure?.detail).toContain('/ @ tablet');
    expect(persisted.assessment).toBeNull();
    expect(requests).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('a screenshot set whose recorded sha256 disagrees with the blob it names stops the review before any model call', async () => {
    const { ref: setRef, set } = await standardSet();
    // The blob is intact under its own key; the set's claim about it is not.
    const tampered = structuredClone(set);
    find(tampered, '/', 'desktop').image!.sha256 = '0'.repeat(64);
    await store.artifacts.updateOne({ projectId: PROJECT, name: 'screenshot-set', version: setRef.version }, { $set: { data: tampered } });
    const { runtime, requests } = model(ASSESSMENT);

    const { review: persisted } = await review(runtime, setRef);

    expect(persisted).toMatchObject({ status: 'evidence_invalid', assessment: null });
    expect(persisted.failure?.detail).toContain("/ @ desktop: stored image does not match the screenshot set's sha256");
    expect(requests).toHaveLength(0);
  });

  it('a missing screenshot blob stops the review before any model call', async () => {
    const { ref: setRef, set } = await standardSet();
    await store.blobs.deleteOne({ _id: find(set, '/', 'mobile').image!.blob });
    const { runtime, requests } = model(ASSESSMENT);

    const { review: persisted } = await review(runtime, setRef);

    expect(persisted).toMatchObject({ status: 'evidence_invalid', assessment: null });
    expect(persisted.failure?.detail).toMatch(/BlobNotFound/);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['a refusal', { stopReason: 'refusal', refusalCategory: 'policy' }, 'refused'],
    ['a malformed answer', { ...ASSESSMENT, scores: { ...ASSESSMENT.scores, composition: 140 } }, 'malformed_output'],
    ['a provider failure', () => { throw new Error('upstream 503'); }, 'provider_failed'],
  ] as const)('%s is recorded as its own status, with no assessment', async (_label, answer, status) => {
    const { ref: setRef } = await standardSet();
    const { review: persisted } = await review(model(answer).runtime, setRef);
    expect(persisted.status).toBe(status);
    expect(persisted.assessment).toBeNull();
    expect(persisted.failure?.kind).toBe(status);
    expect(persisted.coverage.reviewedTargets).toBe(0);
  });

  it('a set with no captured image is no evidence: nothing sent, nothing judged', async () => {
    const { ref: setRef } = await writeSet([missing('/', DESKTOP), missing('/', MOBILE)]);
    const { runtime, requests } = model(ASSESSMENT);
    const { review: persisted } = await review(runtime, setRef);
    expect(persisted).toMatchObject({ status: 'no_evidence', assessment: null, frames: [] });
    expect(persisted.coverage).toMatchObject({ reviewedTargets: 0, complete: false });
    expect(requests).toHaveLength(0);
  });

  it('more frames than the budget reduces frames per capture deterministically before leaving anything unreviewed', async () => {
    const captures = Array.from({ length: 24 }, (_, i) => capture(`/p${i}`, DESKTOP, 3_600, i));
    const { ref: setRef } = await writeSet(captures);
    const { runtime, requests } = model({ ...ASSESSMENT, routeReviews: [], issues: [], antiPatterns: [], refinementPriorities: [] });

    const { review: persisted } = await review(runtime, setRef);

    expect(requests[0]!.images).toHaveLength(48);
    expect(new Set(persisted.frames.map((f) => f.count))).toEqual(new Set([2]));
    expect(persisted.coverage).toMatchObject({ reviewedTargets: 24, notReviewed: [], complete: true });
  });

  it('a historical textual visual-review is not readable as a multimodal review', () => {
    const textual = { decision: 'accept', qualityScore: 91, blocking: false, issues: [], summary: 's', reviewer: { tier: 'terra', model: 'm', skillVersion: 'terra-review@1' }, reviewCycle: 1 };
    expect(VisualQualityReview.safeParse(textual).success).toBe(false);
  });
});

function find(set: Awaited<ReturnType<typeof standardSet>>['set'], route: string, viewport: string) {
  return set.captures.find((c) => c.route === route && c.viewport.name === viewport)!;
}
