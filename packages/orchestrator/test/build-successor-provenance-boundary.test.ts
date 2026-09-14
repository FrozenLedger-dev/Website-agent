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
  it('the contract is a discriminated union of exactly replan and visual_refinement, each with exactly named refs', async () => {
    const code = await src(CONTRACT);
    expect(code).toMatch(/discriminatedUnion\('kind', \[ReplanSuccessorProvenance, VisualRefinementSuccessorProvenance\]\)/);
    expect(code.match(/kind: z\.literal\('[a-z_]+'\)/g)).toEqual(["kind: z.literal('replan')", "kind: z.literal('visual_refinement')"]);
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
    const walk = body(code, 'export async function deriveActiveLineageTip(', '\n}\n');
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
  it('recovery proves the tip from its own stored reason and refuses no well-formed successor kind', async () => {
    const code = await src(RECOVERY);
    const read = code.indexOf('readBuildLineage(tip)');
    const verified = code.indexOf('verifyBindingConsistency(', read);
    expect(read).toBeGreaterThan(-1);
    expect(verified).toBeGreaterThan(read);
    expect(code).not.toContain('ActiveContinuationSuccessorNotOwned');
    expect(code).not.toMatch(/provenance\.kind\s*!==\s*'replan'/);
    // Recovery never builds: it evaluates what promoted and lets the run decide what comes next.
    expect(code).not.toMatch(/prepareFrontendBackendBuildBinding\(|refineSiteVisually\(|authorizeVisualRefinement\(/);
  });
});

describe('successors are prepared only by the two harness decisions that own them', () => {
  it('the replan and the visual refinement are the only successor callers, each with its own typed reason', async () => {
    const callers: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      if (/prepareFrontendBackendBuildBinding\(/.test(code) && file !== BINDING) callers.push(file);
    }
    expect(callers).toEqual(['packages/orchestrator/src/orchestrator.ts']);
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator.match(/provenance: [A-Za-z]+SuccessorProvenance\.parse\(\{\s*kind: '([a-z_]+)'/g)?.map((m) => m.replace(/\s+/g, ' '))).toEqual([
      "provenance: VisualRefinementSuccessorProvenance.parse({ kind: 'visual_refinement'",
      "provenance: ReplanSuccessorProvenance.parse({ kind: 'replan'",
    ]);
  });
});
