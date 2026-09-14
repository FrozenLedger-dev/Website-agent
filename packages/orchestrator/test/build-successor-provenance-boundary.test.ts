/**
 * Structural enforcement of typed build-successor provenance.
 *
 * A predecessor never implies a replan: what a successor is comes from one
 * reader over the typed contract. The one-successor slot is keyed on the
 * predecessor alone, lineage is walked structurally, and successors are
 * prepared only by the two harness decisions that own a reason — the replan
 * and the visual refinement — and recovered through the same typed reader.
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

const BINDING = 'packages/orchestrator/src/run-binding/frontend-backend.ts';
const RECOVERY = 'packages/orchestrator/src/run-recovery/frontend-backend.ts';
const CONTRACT = 'packages/contracts/src/build-lineage.ts';
const STORE = 'packages/state/src/store.ts';

describe('the successor reason is typed and exhaustive', () => {
  it('the contract is a discriminated union of exactly replan, visual_refinement and semantic_edit, each with exactly named refs', async () => {
    const code = await src(CONTRACT);
    expect(code).toMatch(/discriminatedUnion\('kind', \[ReplanSuccessorProvenance, VisualRefinementSuccessorProvenance, SemanticEditSuccessorProvenance\]\)/);
    expect(code.match(/kind: z\.literal\('[a-z_]+'\)/g)).toEqual(["kind: z.literal('replan')", "kind: z.literal('visual_refinement')", "kind: z.literal('semantic_edit')"]);
    expect(code).toContain("const ExactEditableSiteModelRef = refNamed('editable-site-model').extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) });");
    expect(code).toMatch(/kind: z\.literal\('semantic_edit'\),\s*baseEditableSiteModel: ExactEditableSiteModelRef,\s*editableSiteModel: ExactEditableSiteModelRef,\s*\}\)/);
    expect(code).toMatch(/z\s*\.strictObject\(\{\s*kind: z\.literal\('semantic_edit'\)/);
    expect(code).toContain("replanDecision: refNamed('replan-decision')");
    expect(code).toContain("visualQualityReview: refNamed('visual-quality-review')");
    expect(code).toContain("screenshotSet: refNamed('screenshot-set')");
    expect(code).toMatch(/z\.strictObject\(\{\s*kind: z\.literal\('replan'\)/);
    expect(code).toMatch(/z\.strictObject\(\{\s*kind: z\.literal\('visual_refinement'\)/);
    // Identity only: it can name a review or screenshot set, never read one.
    expect([...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['zod/v4', './primitives.js']);
  });
});

describe('a predecessor never implies a replan', () => {
  it('the stored reason fields are read in exactly one place — readBuildLineage — everywhere in production', async () => {
    const reader = body(await src(BINDING), 'export function readBuildLineage(', '\nfunction issues(');
    expect(reader).toContain('binding.replanDecision');
    expect(reader).toContain('binding.successorProvenance');

    for (const file of await allProductionFiles()) {
      let code = await src(file);
      if (file === BINDING) code = code.replace(reader, '');
      expect(code, `${file} reads a stored successor reason outside readBuildLineage`).not.toMatch(/(?<!['"`])\b(binding|tip|next|root|stored|doc|existing|rival)\??\.(replanDecision|successorProvenance)\b/);
    }
  });

  it('no production code branches on the presence of a predecessor to decide what a successor is', async () => {
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      expect(code, file).not.toMatch(/predecessorBindingId\s*(!==|===|!=|==)\s*undefined\s*\?\s*[^:]*replan/i);
      expect(code, file).not.toMatch(/if\s*\(\s*[\w.]*predecessorBindingId\s*\)[^;{]*\{?[^}]*replanDecision/);
    }
  });

  it('the lineage walk and Phase 5k consistency both classify through the reader', async () => {
    const code = await src(BINDING);
    // The active walk delegates to the one exact-root walk, which does the classifying.
    expect(body(code, 'export async function deriveActiveLineageTip(', '\n}\n')).toContain('return deriveLineageTipFromRoot(store, root, options);');
    const walk = body(code, 'export async function deriveLineageTipFromRoot(', '\n}\n');
    expect(walk).toContain("lineagePositionOf(root, rootId).kind !== 'initial'");
    expect(walk).toMatch(/lineagePositionOf\(next, rootId\)/);
    const verify = body(code, 'export function verifyBindingConsistency(', '\n}\n');
    expect(verify).toContain('readBuildLineage(binding)');
    expect(verify).toContain('stored.provenance.kind !== lineage.provenance.kind');
  });

  it('preparation validates the reason against the contract before anything is written, and persists each kind in its own encoding', async () => {
    const prepare = body(await src(BINDING), 'export async function prepareFrontendBackendBuildBinding(', '\n}\n');
    const validated = prepare.indexOf('BuildSuccessorProvenance.safeParse(');
    expect(validated).toBeGreaterThan(-1);
    expect(validated).toBeLessThan(prepare.indexOf('insertOne('));
    expect(prepare).toMatch(/provenance\.kind === 'replan'\s*\?\s*\{ replanDecision: input\.lineage\.provenance\.replanDecision \}\s*:\s*\{ successorProvenance: input\.lineage\.provenance \}/);
  });
});

describe('one lineage, whatever the reason', () => {
  it('the one-successor index is keyed on the predecessor alone, never on a reason', async () => {
    const code = await src(STORE);
    const index = body(code, 'key: { projectId: 1, predecessorBindingId: 1 }', '}\n');
    expect(index).toContain('unique: true');
    expect(index).toContain('partialFilterExpression: { predecessorBindingId: { $exists: true } }');
    expect(code).not.toMatch(/key: \{[^}]*(replanDecision|successorProvenance)/);
    expect(code).not.toMatch(/partialFilterExpression: \{[^}]*(replanDecision|successorProvenance)/);
  });

  it('lineage is never ordered by time or version', async () => {
    const walk = body(await src(BINDING), 'export async function deriveActiveLineageTip(', '\n}\n');
    expect(walk).not.toMatch(/sort|createdAt|updatedAt|promotedAt|limit\(/);
    const recovery = await src(RECOVERY);
    expect(recovery).not.toMatch(/frontendBackendBuildBindings[\s\S]{0,200}sort\(/);
  });
});

describe('Phase 5q owns every successor kind through the typed contract', () => {
  it('recovery proves the tip from its own stored reason; a semantic edit is owned by its handed-off draft, and a semantic-edit tip without one fails closed — never another kind', async () => {
    const code = await src(RECOVERY);
    const handedOff = code.indexOf('throw new ActiveContinuationSemanticEditOwned(projectId, owner.draft._id, owner.draft.claim.operationId);');
    const read = code.indexOf('readBuildLineage(tip)');
    const verified = code.indexOf('verifyBindingConsistency(', read);
    const refused = code.indexOf('throw new ActiveContinuationCorrupt(projectId, `semantic edit build "${tip._id}" is the active tip, but no canonical draft is handed to its edit`);', verified);
    expect(handedOff).toBeGreaterThan(-1);
    expect(handedOff).toBeLessThan(read);
    expect(read).toBeGreaterThan(-1);
    expect(verified).toBeGreaterThan(read);
    expect(refused).toBeGreaterThan(verified);
    expect(code.slice(verified, refused)).toContain("position.provenance.kind === 'semantic_edit'");
    expect(code).not.toMatch(/provenance\.kind\s*!==\s*'(replan|visual_refinement)'/);
    // Recovery never builds: it evaluates what promoted and lets the run decide what comes next.
    expect(code).not.toMatch(/prepareFrontendBackendBuildBinding\(|refineSiteVisually\(|authorizeVisualRefinement\(/);
  });
});

describe('successors are prepared only by the three harness decisions that own them', () => {
  it('the replan, the visual refinement and the semantic edit are the only successor callers, each with its own typed reason', async () => {
    const callers: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      if (/prepareFrontendBackendBuildBinding\(/.test(code) && file !== BINDING) callers.push(file);
    }
    expect(callers.sort()).toEqual(['packages/orchestrator/src/orchestrator.ts', 'packages/orchestrator/src/semantic-edit/apply.ts']);
    const edit = await src('packages/orchestrator/src/semantic-edit/apply.ts');
    expect(edit.match(/prepareFrontendBackendBuildBinding\(/g)).toHaveLength(1);
    expect(edit).toMatch(/const provenance = SemanticEditSuccessorProvenance\.parse\(\{ kind: 'semantic_edit', baseEditableSiteModel: intent\.baseEditableSiteModel, editableSiteModel: intent\.editableSiteModel \}\);/);
    expect(edit).toMatch(/lineage: \{ predecessorBindingId: predecessor\._id, provenance \}/);
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator.match(/provenance: [A-Za-z]+SuccessorProvenance\.parse\(\{\s*kind: '([a-z_]+)'/g)?.map((m) => m.replace(/\s+/g, ' '))).toEqual([
      "provenance: VisualRefinementSuccessorProvenance.parse({ kind: 'visual_refinement'",
      "provenance: ReplanSuccessorProvenance.parse({ kind: 'replan'",
    ]);
  });
});

describe('semantic-edit successors: created only by the semantic-edit application', () => {
  it('only the contracts, the lineage reader, recovery, draft authority and the semantic-edit application know the semantic_edit kind — and only the application creates one', async () => {
    const knowers: string[] = [];
    for (const file of await allProductionFiles()) {
      if (/semantic_edit|SemanticEditSuccessorProvenance/.test(await src(file))) knowers.push(file);
    }
    // The state document only types the persisted field; it creates nothing. Canonical draft
    // authority names `semantic_edit` only as a claim category, never as a successor.
    // The job contract names the edit's origin; the application is the one place a semantic-edit successor is made.
    expect(knowers.sort()).toEqual([CONTRACT, BINDING, RECOVERY, 'packages/state/src/documents.ts', 'packages/orchestrator/src/canonical-draft/authority.ts', 'packages/contracts/src/job.ts', 'packages/orchestrator/src/semantic-edit/apply.ts', 'packages/state/src/store.ts'].sort());
    expect(await src('packages/orchestrator/src/canonical-draft/authority.ts')).not.toMatch(/SemanticEditSuccessorProvenance|successorProvenance/);
    const binding = await src(BINDING);
    expect(binding).not.toMatch(/kind: 'semantic_edit'/);
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator).not.toMatch(/semantic|SemanticEdit/i);
  });

  it('no code decides a kind by elimination: not replan never means visual refinement, and a predecessor never means a kind', async () => {
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      expect(code, file).not.toMatch(/provenance\.kind\s*!==\s*'(replan|visual_refinement|semantic_edit)'\s*\?/);
      expect(code, file).not.toMatch(/provenance\.kind\s*===\s*'replan'\s*\?[^:]*:\s*\{\s*visualQualityReview/);
    }
    const binding = await src(BINDING);
    const reader = body(binding, 'export function readBuildLineage(', '\nfunction issues(');
    expect(reader).toContain('TypedSuccessorProvenance.safeParse(binding.successorProvenance)');
    expect(binding).toContain("const TypedSuccessorProvenance = z.discriminatedUnion('kind', [VisualRefinementSuccessorProvenance, SemanticEditSuccessorProvenance]);");
  });

  it('the semantic-edit reason carries no customer, session, patch, source or time — only the two exact models', async () => {
    const contract = await src(CONTRACT);
    const shape = body(contract, 'export const SemanticEditSuccessorProvenance = z', '  .refine(');
    expect(shape.match(/^\s{4}(\w+):/gm)?.map((m) => m.trim())).toEqual(['kind:', 'baseEditableSiteModel:', 'editableSiteModel:']);
    expect(shape).not.toMatch(/customer|session|account|email|patch|operation|source|commit|At\b|time/i);
  });

  it('the semantic edit has its own job origin, job spec and skill — and still no customer editor route exists', async () => {
    const job = await src('packages/contracts/src/job.ts');
    expect(job).toContain("z.strictObject({ kind: z.literal('semantic_edit'), intentId: z.string().regex(/^semantic-edit-[a-f0-9]{64}$/) }),");
    expect(await src('packages/orchestrator/src/job-specs/frontend-backend.ts')).toContain('export function createFrontendBackendSemanticEditJobSpec(');
    expect(await src('packages/agents/src/runtime.ts')).toContain("'terra-edit': 'terra',");
    const routes: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name === 'route.ts' || entry.name === 'page.tsx') routes.push(path);
      }
    };
    await walk('apps/customer/app');
    expect(routes.sort()).toEqual(['apps/customer/app/api/auth/callback/route.ts', 'apps/customer/app/api/auth/login/route.ts', 'apps/customer/app/api/auth/logout/route.ts', 'apps/customer/app/api/auth/me/route.ts']);
  });
});
