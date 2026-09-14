/**
 * Structural enforcement of the multimodal visual review boundary.
 *
 * Only Terra's review sends images, only through the model runtime, only of the
 * exact screenshot set an evaluation wrote, read by exact blob key. The review
 * holds no tool, file, Git, job, promotion or release authority and applies
 * nothing; its exact reference is what Sol receives.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', 'test', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}
async function allProductionFiles(): Promise<string[]> {
  const packages = await readdir(join(REPO, 'packages'));
  return (await Promise.all([...packages.map((p) => `packages/${p}/src`), 'apps/console/app', 'apps/console/lib', 'scripts'].map(productionFiles))).flat();
}
function body(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return code.slice(from, to);
}

const REVIEW_SKILL = 'packages/agents/src/skills/terra-review.ts';
const PHASE = 'packages/orchestrator/src/phases/visual-review.ts';
const EVALUATE = 'packages/orchestrator/src/phases/evaluate.ts';

describe('images reach a model only through Terra’s visual review and the runtime', () => {
  it('terra-review is the only skill that sends images, in exactly one runtime invocation', async () => {
    const senders: string[] = [];
    for (const file of await productionFiles('packages/agents/src/skills')) {
      if (/\bimages:/.test(await src(file))) senders.push(file);
    }
    expect(senders).toEqual([REVIEW_SKILL]);
    const visual = body(await src(REVIEW_SKILL), 'export async function reviewVisualQuality(', '\n}\n');
    expect(visual.match(/runtime\.invoke\(\{/g)).toHaveLength(1);
    expect(visual).toContain("skill: 'terra-review',");
    expect(visual).toContain("tier: 'terra',");
    expect(visual).toContain('schema: VisualQualityAssessment,');
    expect(visual).toMatch(/images: input\.frames\.map\(/);
  });

  it('the provider is the only place images become a vendor request, and the runtime reports usage once', async () => {
    const openai = await src('packages/agents/src/providers/openai.ts');
    expect(openai).toContain("{ role: 'user', content: userContent(request.prompt, request.images) },");
    const runtime = await src('packages/agents/src/runtime.ts');
    expect(runtime.match(/this\.onUsage\(\{/g)).toHaveLength(1);
    expect(runtime).toContain('...(invocation.images !== undefined ? { images: invocation.images } : {}),');
    for (const file of await allProductionFiles()) {
      if (file.startsWith('packages/agents/src/providers/')) continue;
      expect(await src(file), file).not.toMatch(/image_url|data:image\/png;base64|chat\.completions/);
    }
  });

  it('the visual review skill has no tools, no build output and no files', async () => {
    const skill = await src(REVIEW_SKILL);
    expect(skill).not.toMatch(/ToolAccess|tools\b|execute\(|BuildOutput|GeneratedFile\[\]\s*>|writeSiteFiles|node:fs/);
  });

  it('only the visual review phase invokes the visual review skill, and only evaluation runs the phase', async () => {
    const skillCallers: string[] = [];
    const phaseCallers: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      if (/reviewVisualQuality\(/.test(code) && file !== REVIEW_SKILL) skillCallers.push(file);
      if (/reviewScreenshotSetVisually\(/.test(code) && file !== PHASE) phaseCallers.push(file);
    }
    expect(skillCallers).toEqual([PHASE]);
    expect(phaseCallers).toEqual([EVALUATE]);
  });
});

describe('the review reads exact evidence and holds no authority', () => {
  it('reads the screenshot set by the exact reference, and each image by its exact blob key, re-hashed', async () => {
    const phase = await src(PHASE);
    expect(phase.match(/deps\.registry\.\w+\(/g)).toEqual(['deps.registry.resolve(', 'deps.registry.put(']);
    expect(phase).toContain('ScreenshotSet.parse(await deps.registry.resolve(input.projectId, input.screenshotSet))');
    expect(phase).toContain('bytes = await deps.blobs.get(image.blob);');
    expect(phase).toContain("if (createHash('sha256').update(bytes).digest('hex') !== image.sha256 || bytes.length !== image.bytes) {");
    expect(phase).not.toMatch(/sort:\s*\{\s*version|registry\.get\(|findOne\(|\.blobs\.find|latest/i);
  });

  it('holds no tool, file, Git, job, promotion, release or deployment authority, and applies nothing', async () => {
    const phase = await src(PHASE);
    const imports = [...phase.matchAll(/from '([^']+)'/g)].map((m) => m[1]!).sort();
    expect(imports).toEqual(['@statxai/agents', '@statxai/contracts', '@statxai/workspace', 'node:crypto']);
    expect(phase).not.toMatch(/ToolGateway|tool-gateway|test_runner|filesystem|writeSiteFiles|commit\(|JobEngine|job-engine|promot|release-publication|deploy|StateStore|materialise/i);
  });

  it('evaluation reviews exactly the screenshot set it just wrote, and returns the exact review', async () => {
    const evaluate = await src(EVALUATE);
    const site = body(evaluate, 'export async function evaluateSite(', '\nfunction firstErrors(');
    const order = ['await persistScreenshotSet({', 'await reviewScreenshotSetVisually(', 'await reviewSite('].map((m) => site.indexOf(m));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(site).toContain('screenshotSet: screenshots.ref,');
    expect(site).toMatch(/const visualQualityReview = screenshots\s*\?\s*await reviewScreenshotSetVisually\(/);
    expect(site).toMatch(/\n\s+visualQualityReview,\n/);
  });

  it('Sol receives the exact review from the current evaluation, never a lookup', async () => {
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator).toContain('visualReview: evaluation.visualQualityReview,');
    expect(orchestrator).toContain('await adjudicateDefects(ctx(), mustFix, { gateRun, reviewSummary, visualReview: evaluation.visualQualityReview });');
    const release = await src('packages/orchestrator/src/phases/release.ts');
    expect(release).toContain('visualQualityReview: context.visualReview?.ref ?? null,');
    expect(release).toContain('visualReview: context.visualReview ? summarizeVisualReview(context.visualReview) : null,');
    const adjudicate = await src('packages/orchestrator/src/phases/adjudicate.ts');
    expect(adjudicate).toContain('visualReview: evidence.visualReview ? summarizeVisualReview(evidence.visualReview) : null,');
    for (const file of await allProductionFiles()) {
      expect(await src(file), file).not.toMatch(/name: 'visual-quality-review'\s*\}/);
    }
  });

  it('no production code applies a visual review: no refinement exists yet', async () => {
    const consumers: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      // The one permitted name is the typed successor identity, which records a review ref and performs nothing.
      expect(code, file).not.toMatch(/refineVisual|applyVisual|visualRefinement(?!SuccessorProvenance)/i);
      if (/visualQualityReview|VisualQualityReviewOutcome|summarizeVisualReview/.test(code)) consumers.push(file);
    }
    // Who touches a review: the phase that makes it, evaluation that returns it, Sol's evidence, and build-successor
    // identity that names its exact ref — nothing that builds or writes.
    expect(consumers.sort()).toEqual([
      'packages/contracts/src/build-lineage.ts',
      'packages/orchestrator/src/run-binding/frontend-backend.ts',
      'packages/orchestrator/src/orchestrator.ts',
      'packages/orchestrator/src/phases/adjudicate.ts',
      EVALUATE,
      'packages/orchestrator/src/phases/release.ts',
      PHASE,
      'packages/orchestrator/src/release.ts',
    ].sort());
    for (const file of consumers.filter((f) => f !== 'packages/orchestrator/src/orchestrator.ts')) {
      expect(await src(file), file).not.toMatch(/writeSiteFiles\(|buildSite\(|buildFromPlan\(|repairSite\(/);
    }
    // In the orchestrator the review is only ever handed to Sol.
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator.match(/visualQualityReview/g)).toHaveLength(2);
  });
});
