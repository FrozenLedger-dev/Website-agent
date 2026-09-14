/**
 * Structural enforcement of the bounded visual refinement boundary.
 *
 * Terra proposes; the harness decides, spends, validates, accepts and promotes.
 * `terra-refine` is its own skill with no authority of its own; the one policy
 * and the one durable budget decide whether it runs; the exact source comes from
 * a proven commit, never through a tool; and Sol judges only after refinement
 * has stopped.
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
const imports = (code: string) => [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

const REFINE = 'packages/agents/src/skills/terra-refine.ts';
const REVIEW = 'packages/agents/src/skills/terra-review.ts';
const AUTHORIZE = 'packages/orchestrator/src/visual-refinement/authorize.ts';
const POLICY = 'packages/orchestrator/src/visual-refinement/policy.ts';
const HANDLER = 'packages/orchestrator/src/job-handlers/frontend-backend.ts';
const ORCHESTRATOR = 'packages/orchestrator/src/orchestrator.ts';

describe('terra-refine is a distinct skill with no authority', () => {
  it('is its own file and skill, and terra-review stays review-only', async () => {
    const refine = await src(REFINE);
    const review = await src(REVIEW);
    expect(refine).toContain("skill: 'terra-refine',");
    expect(refine).not.toContain("'terra-review'");
    expect(review).not.toMatch(/BuildOutput|terra-refine|invokeTerraBuild|ToolAccess/);
    expect(review.match(/schema: (\w+),/g)).toEqual(['schema: ReviewOutcomeInput,', 'schema: VisualQualityAssessment,']);
  });

  it('holds no write, Git, job, acceptance, promotion or storage authority — it can only return a proposal', async () => {
    const refine = await src(REFINE);
    expect(imports(refine).sort()).toEqual(['../runtime.js', './terra-build.js', './terra-review.js', '@statxai/contracts'].sort());
    expect(refine).not.toMatch(/writeSiteFiles|ProjectWorkspace|node:fs|commit\(|JobEngine|accept|promot|registry|BlobStore|StateStore/i);
  });

  it('returns the strict BuildOutput through the one bounded Terra loop, with the build loop’s own bounds unchanged', async () => {
    const build = await src('packages/agents/src/skills/terra-build.ts');
    const loop = body(build, 'export async function invokeTerraBuild(', '\n}\n');
    expect(loop).toContain('schema: (tools ? TerraBuildAction : BuildOutput) as z.ZodType<unknown>,');
    expect(loop).toContain("skill: request.skill ?? 'terra-build',");
    expect(loop).toContain('for (let turn = 0; turn < (tools ? TERRA_MAX_MODEL_TURNS : 1); turn += 1) {');
    // Images travel with every turn of the loop, not just the first.
    expect(loop).toContain('...(request.images !== undefined ? { images: request.images } : {}),');
    expect(loop.indexOf('...(request.images')).toBeGreaterThan(loop.indexOf('for (let turn = 0;'));
    const access = await src('packages/agents/src/tool-access.ts');
    expect(access).toMatch(/TERRA_MAX_MODEL_TURNS = 4;[\s\S]*TERRA_MAX_TOOL_CALLS = 3;[\s\S]*TERRA_MAX_TEST_RUNS = 2;/);
  });
});

describe('tools stay exactly what a build has', () => {
  it('no browser, Git or write tool is registered with the gateway, and the handler supports only filesystem and test_runner', async () => {
    // `ToolId` has always named more tools than exist; what matters is which adapters are registered.
    const registered: string[] = [];
    for (const file of await productionFiles('packages/orchestrator/src/tool-gateway')) {
      registered.push(...[...(await src(file)).matchAll(/\btool: '([a-z_]+)'/g)].map((m) => m[1]!));
    }
    expect([...new Set(registered)].sort()).toEqual(['filesystem', 'test_runner']);
    for (const file of await allProductionFiles()) {
      if (file === 'packages/contracts/src/primitives.ts') continue;
      expect(await src(file), file).not.toMatch(/browser_preview/);
    }
    const handler = await src(HANDLER);
    expect(handler).toContain("export const FRONTEND_BACKEND_SUPPORTED_TOOLS: readonly ToolId[] = Object.freeze(['filesystem', 'test_runner']);");
    const gateway = body(handler, 'export function createFrontendBackendToolGateway(', '\n}\n');
    expect(gateway).toContain('createScaffoldFilesystemAdapter({ root: defaultTemplateRoot() }),');
    expect(gateway.match(/create\w+Adapter\(/g)).toEqual(['createScaffoldFilesystemAdapter(', 'createTestRunnerAdapter(']);
  });

  it('the filesystem tool is not widened to the canonical tree: canonical source is read only by the authorisation, at a proven commit', async () => {
    const filesystem = await src('packages/orchestrator/src/tool-gateway/filesystem.ts');
    expect(filesystem).not.toMatch(/workspacesRoot|ProjectWorkspace|readModelSourceAtCommit|siteRoot/);
    const readers: string[] = [];
    for (const file of await allProductionFiles()) {
      if (/readModelSourceAtCommit\(/.test(await src(file)) && file !== 'packages/workspace/src/project-workspace.ts') readers.push(file);
    }
    expect(readers).toEqual([AUTHORIZE]);
    const authorize = await src(AUTHORIZE);
    const head = authorize.indexOf('const head = await workspace.currentCommit();');
    const ancestor = authorize.indexOf('await workspace.isAncestorCommit(build.promotionCommitSha, sourceCommit)');
    const receipt = authorize.indexOf('store.promotions.findOne({ _id: build.promotionId })');
    const read = authorize.indexOf('workspace.readModelSourceAtCommit(sourceCommit, VISUAL_REFINEMENT_SOURCE_LIMITS)');
    expect(Math.min(head, ancestor, receipt)).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(Math.max(head, ancestor, receipt));
    expect(authorize).toContain('if (head !== sourceCommit) throw refuse(');
  });
});

describe('the harness, never the model, owns iteration', () => {
  it('one pure policy decides, only the authorisation asks it, and only the run asks the authorisation', async () => {
    const policy = await src(POLICY);
    expect(imports(policy).sort()).toEqual(['@statxai/contracts', '@statxai/state']);
    expect(policy).not.toMatch(/await |registry|store\.|runtime|invoke/);
    const deciders: string[] = [];
    const authorizers: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      if (/decideVisualRefinement\(/.test(code) && file !== POLICY) deciders.push(file);
      if (/authorizeVisualRefinement\(/.test(code) && file !== AUTHORIZE) authorizers.push(file);
    }
    expect(deciders).toEqual([AUTHORIZE]);
    expect(authorizers).toEqual([ORCHESTRATOR]);
  });

  it('the budget is the durable store’s, spent in the same transaction as the intent — never a process-local counter', async () => {
    const authorize = await src(AUTHORIZE);
    const txn = body(authorize, 'await store.withTransaction(async (session) => {', '\n    });');
    expect(txn).toContain("await spend(store, projectId, 'visualRefinements', session);");
    expect(txn).toContain('await registry.put(projectId, VISUAL_REFINEMENT_SOURCE_ARTIFACT, source, session);');
    expect(txn).toContain('await store.visualRefinementIntents.insertOne(doc, { session });');
    expect(authorize.indexOf('const existing = await store.visualRefinementIntents.findOne({ _id: intentId });')).toBeLessThan(authorize.indexOf('decideVisualRefinement('));
    const orchestrator = await src(ORCHESTRATOR);
    expect(orchestrator).not.toMatch(/refinementsUsed|visualRefinements\s*[+-]=|refinementCount|let refinement\w*\s*=\s*\d/);
    const store = await src('packages/state/src/store.ts');
    expect(store).toContain('{ key: { projectId: 1, predecessorBindingId: 1 }, unique: true },');
  });

  it('refinement is asked only once nothing blocks, before Sol judges, and a promoted refinement is re-evaluated from scratch', async () => {
    const orchestrator = await src(ORCHESTRATOR);
    const nothingBlocking = orchestrator.indexOf('if (mustFix.length === 0) {');
    const authorize = orchestrator.indexOf('await authorizeVisualRefinement({');
    const seek = orchestrator.indexOf('await seekRelease(ctx(), {');
    const adjudicate = orchestrator.indexOf('await adjudicateDefects(ctx(), mustFix,');
    expect(nothingBlocking).toBeGreaterThan(-1);
    expect(authorize).toBeGreaterThan(nothingBlocking);
    expect(seek).toBeGreaterThan(authorize);
    expect(adjudicate).toBeGreaterThan(seek);
    const refinement = orchestrator.slice(authorize, seek);
    expect(refinement.indexOf('canonicalBuild = successor;')).toBeLessThan(refinement.indexOf('continue;'));
    expect(refinement).not.toMatch(/seekRelease|adjudicateDefects|publishRelease|evaluateSite\(/);
  });
});

describe('only the existing lifecycle validates, accepts and promotes', () => {
  it('a refinement reaches canonical state only through the coordinator, and is finalised only after it reports promoted', async () => {
    const orchestrator = await src(ORCHESTRATOR);
    const refinement = body(orchestrator, 'await authorizeVisualRefinement({', 'await seekRelease(ctx(), {');
    expect(refinement).not.toMatch(/validateFrontendBackendCandidate|acceptValidatedFrontendBackendCandidate|promoteAcceptedFrontendBackendCandidate|writeSiteFiles|publishBuildDirectly|buildFromPlan|clearSite/);
    const run = refinement.indexOf("const refined = await lifecycleCoordinator.run(intent.jobSpec, { kind: 'visual_refine', refinementCycle: intent.refinementCycle });");
    const promotedCheck = refinement.indexOf("if (refined.outcome !== 'promoted') {");
    const finalize = refinement.indexOf('await finalizeBindingPromoted(store, successor._id, {');
    expect(run).toBeGreaterThan(-1);
    expect(promotedCheck).toBeGreaterThan(run);
    expect(finalize).toBeGreaterThan(promotedCheck);
    expect(refinement).toContain("provenance: VisualRefinementSuccessorProvenance.parse({\n                kind: 'visual_refinement',");
    expect(refinement).not.toMatch(/kind: 'replan'/);
  });

  it('the handler’s refinement stages a candidate like a build, and validation refuses a refinement that changes the plan’s routes', async () => {
    const handler = await src(HANDLER);
    const prepare = body(handler, 'async function prepareVisualRefinement(', '\n  }\n');
    expect(prepare).not.toMatch(/ProjectWorkspace|writeSiteFiles|registry\.put|registry\.accept|store\./);
    expect(prepare).toContain('await reproduceReviewFrames({ registry: deps.registry, blobs: deps.blobs }, job.projectId, review)');
    expect(prepare.match(/deps\.registry\.\w+\(/g)).toEqual(['deps.registry.resolve(', 'deps.registry.resolve(']);
    const validation = await src('packages/orchestrator/src/job-validation/frontend-backend.ts');
    expect(validation).toContain('const conformance = isVisualRefinementSpec(job.spec) ? planConformanceFindings(candidate.files, plan) : [];');
    expect(validation.indexOf('assertModelWritableFiles(candidate.files);')).toBeLessThan(validation.indexOf('await ws.writeSiteFiles(candidate.files);'));
  });
});

describe('no latest lookups for refinement authority', () => {
  it('every refinement read is by exact reference or exact id', async () => {
    for (const file of [AUTHORIZE, POLICY, HANDLER, 'packages/orchestrator/src/job-specs/frontend-backend.ts']) {
      const code = await src(file);
      expect(code, file).not.toMatch(/registry\.get\(|registry\.list|sort:\s*\{\s*(version|createdAt|lineageSeq)|\.sort\(\{|latest/i);
    }
    const phase = await src('packages/orchestrator/src/phases/visual-review.ts');
    const reproduce = body(phase, 'export async function reproduceReviewFrames(', '\n}\n');
    expect(reproduce).toContain('ScreenshotSet.parse(await deps.registry.resolve(projectId, review.screenshotSet))');
    expect(reproduce).toContain('await deps.blobs.get(capture.image.blob)');
    expect(reproduce).toContain('recut.sha256 !== frame.sha256');
  });

  it('a refinement job’s identity pins the exact source, review and screenshot set, with nothing time- or randomness-derived', async () => {
    const spec = await src('packages/orchestrator/src/job-specs/frontend-backend.ts');
    const factory = body(spec, 'export function createFrontendBackendVisualRefinementJobSpec(', '\n}\n');
    expect(factory).toContain('[FRONTEND_BACKEND_INPUT.visualRefinementSource]: input.visualRefinementSourceRef,');
    expect(factory).toContain('[FRONTEND_BACKEND_INPUT.visualQualityReview]: input.visualQualityReviewRef,');
    expect(factory).toContain('[FRONTEND_BACKEND_INPUT.screenshotSet]: input.screenshotSetRef,');
    expect(factory).toContain('return { ...identity, jobId: computeJobId(identity) };');
    expect(spec).not.toMatch(/Date\.now|new Date|randomUUID|Math\.random/);
    const contract = await src('packages/contracts/src/visual-refinement.ts');
    for (const field of ['predecessorBindingId:', 'promotionCommitSha:', 'sourceCommit:', 'refinementCycle:', 'filesDigest:']) expect(contract).toContain(field);
  });
});

describe('Phase 5q owns the promoted refinement without replaying it', () => {
  it('recovery refuses no successor kind and never builds or refines', async () => {
    const recovery = await src('packages/orchestrator/src/run-recovery/frontend-backend.ts');
    expect(recovery).not.toMatch(/ActiveContinuationSuccessorNotOwned|refineSiteVisually|authorizeVisualRefinement|lifecycleCoordinator|prepareFrontendBackendBuildBinding/);
    const contract = await src('packages/contracts/src/job.ts');
    expect(contract).toContain("z.strictObject({ kind: z.literal('visual_refine'), refinementCycle: z.number().int().min(1).max(1_000) }),");
  });
});
