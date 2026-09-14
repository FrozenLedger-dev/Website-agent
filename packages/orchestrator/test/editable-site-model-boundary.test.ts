/**
 * Structural enforcement of the editable site model boundary.
 *
 * Three distinct objects (plan, model, build output); identity minted only by
 * the harness and never positional or source-derived; semantic patches pure,
 * exact-ref and source-free; every build and evaluation measured against an
 * exact pinned model; and no editor, UI or new tool anywhere.
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

const CONTRACT = 'packages/contracts/src/editable-site-model.ts';
const IDENTITY = 'packages/orchestrator/src/site-model/identity.ts';
const MATERIALIZE = 'packages/orchestrator/src/site-model/materialize.ts';
const PATCH = 'packages/orchestrator/src/site-model/patch.ts';
const PERSIST = 'packages/orchestrator/src/site-model/persist.ts';
const GATE = 'packages/gates/src/site-model-markers.ts';

describe('three authorities, never collapsed', () => {
  it('the editable model is its own contract: SitePlan and BuildOutput are unchanged and know nothing of it', async () => {
    const artifacts = await src('packages/contracts/src/artifacts.ts');
    expect(artifacts).not.toMatch(/EditableSiteModel|data-statx|SemanticPatch/);
    expect(body(artifacts, 'export const BuildOutput = z.object({', '});')).toBe("export const BuildOutput = z.object({\n  files: z.array(GeneratedFile).min(1),\n  notes: z.string(),\n");
    const contract = await src(CONTRACT);
    expect(imports(contract).sort()).toEqual(['./artifacts.js', './primitives.js', 'zod/v4']);
    expect(contract).not.toMatch(/SitePlan\.extend|BuildOutput|GeneratedFile/);
    expect(contract).toContain("export const EDITABLE_SITE_MODEL_ARTIFACT = 'editable-site-model';");
  });

  it('design tokens and section properties are bounded types, never free CSS', async () => {
    const contract = await src(CONTRACT);
    expect(contract).not.toMatch(/\b(css|style|className|tailwind)\s*:/i);
    const tokens = body(contract, 'export const DesignTokens = z.strictObject({', '\n});');
    expect(tokens).not.toMatch(/z\.string\(\)\.min\(1\)(?!\.max)/);
    expect(body(contract, 'export const SiteSection = z.strictObject({', '\n});')).toMatch(/layout: SectionLayout,\s*visibility: Visibility,/);
  });
});

describe('identity is the harness’s, never positional or source-derived', () => {
  it('IDs are hashed only in the identity module, from semantic keys under exact parents — never an index, a path or a text', async () => {
    const minters: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      // Semantic IDs only: other opaque ids (customer users, accounts) are not the editable model's identity.
      if ((/`\$\{prefix\}_\$\{/.test(code) && /'(pg|sec|blk|fld|ast)'/.test(code)) || /`(pg|sec|blk|fld|ast)_\$\{/.test(code)) minters.push(file);
      // No production file carries a hard-coded semantic ID.
      expect(code, file).not.toMatch(/\b(pg|sec|blk|fld|ast)_[a-f0-9]{16}\b/);
    }
    expect(minters).toEqual([IDENTITY]);
    const materialize = await src(MATERIALIZE);
    const derives = [...materialize.matchAll(/ids\.derive\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(derives.sort()).toEqual(["'fld', parent, key", "'pg', projectId, planned.route", "'sec', pageId, plannedSection.id"].sort());
    expect(materialize).not.toMatch(/\.map\(\((\w+), (i|index)\)|findIndex|indexOf|routeToSourcePath|heading\)\s*\)/);
    const patch = await src(PATCH);
    expect([...patch.matchAll(/derivedId\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["model.projectId, 'fld', blockId, slot.key"]);
    expect(patch).toContain("const blockId = ids.mint('blk');");
  });

  it('a minted ID skips everything used or retired, and a retired identity is carried forward forever', async () => {
    const identity = await src(IDENTITY);
    const mint = body(identity, '  mint(prefix: IdPrefix): string {', '\n  }\n');
    expect(mint).toContain('if (!this.used.has(id) && !this.retired.has(id)) {');
    expect(body(identity, '  derive(prefix: IdPrefix, parent: string, key: string): string {', '\n  }\n')).toContain('if (this.used.has(id) || this.retired.has(id)) return this.mint(prefix);');
    const materialize = await src(MATERIALIZE);
    expect(materialize).toContain('identity: { retired: [...base.identity.retired, ...retiredNow].sort(), minted: ids.minted },');
    const contract = await src(CONTRACT);
    expect(contract).toContain('if (retired.has(id)) issue(`retired ID ${id} is in use`);');
  });

  it('Terra never mints identity: prompts carry the model’s IDs, and agents contain no ID construction', async () => {
    for (const file of await productionFiles('packages/agents/src')) {
      expect(await src(file), file).not.toMatch(/createHash|randomUUID\(\)[\s\S]{0,40}(pg|sec|blk|fld)_|`(pg|sec|blk|fld|ast)_/);
    }
    // Read raw: the build prompts contain glob text that a comment stripper would mangle.
    const build = await readFile(join(REPO, 'packages/agents/src/skills/terra-build.ts'), 'utf8');
    expect(build).toContain('export function semanticIdentityBrief(model: EditableSiteModel, routes: readonly string[] | \'all\'): string {');
    expect(build.match(/options\.siteModel \? semanticIdentityBrief\(options\.siteModel, /g)).toHaveLength(3);
  });
});

describe('semantic patches are pure, exact and source-free', () => {
  it('the patch engine holds no store, registry, workspace, model, clock or randomness, and never mutates its base', async () => {
    const patch = await src(PATCH);
    expect(imports(patch).sort()).toEqual(['./identity.js', '@statxai/contracts', '@statxai/workspace'].sort());
    expect(patch).toMatch(/import \{ contentHash \} from '@statxai\/workspace';/);
    expect(patch).not.toMatch(/\bawait\b|\basync\b|Date\.|new Date|Math\.random|randomUUID|registry|store\.|writeSiteFiles|ProjectWorkspace|runtime/);
    expect(patch).toContain('const model = structuredClone(input.base);');
    expect(patch).not.toMatch(/input\.base\.(pages|assets|design|identity)[^;]*=/);
    expect(patch).toMatch(/if \(!sameExactRef\(patch\.baseModel, input\.baseRef\)\)/);
  });

  it('nothing applies a patch to source, and nothing but persistence commits one', async () => {
    const appliers: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      if (/applySemanticPatch\(|commitSemanticPatch\(/.test(code) && ![PATCH, PERSIST].includes(file)) appliers.push(file);
    }
    expect(appliers).toEqual([]);
    const persist = await src(PERSIST);
    expect(persist).not.toMatch(/ProjectWorkspace|writeSiteFiles|commit\(|lifecycle|runProject|deploy/);
  });

  it('no customer editor, UI or edit route exists', async () => {
    for (const file of [...(await productionFiles('apps/console/app')), ...(await productionFiles('apps/console/lib'))]) {
      expect(await src(file), file).not.toMatch(/editable-site-model|EditableSiteModel|SemanticPatch|data-statx|semantic_patch/);
    }
  });
});

describe('builds and evaluations measure an exact pinned model', () => {
  it('the model is materialised before the first build, reconciled on replan, and carried unchanged by refinement — always by exact ref', async () => {
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    const record = orchestrator.indexOf('await recordEditableSiteModel(registry, projectId, modelFromPlan({ projectId, sitePlanRef: initialSitePlanRef, plan: initialPlan }))');
    const spec = orchestrator.indexOf('editableSiteModelRef: siteModel.ref,');
    const prepare = orchestrator.indexOf('binding = await prepareFrontendBackendBuildBinding(store, {');
    expect(record).toBeGreaterThan(-1);
    expect(spec).toBeGreaterThan(record);
    expect(prepare).toBeGreaterThan(spec);
    expect(orchestrator).toContain('const baseModelRef = canonicalBuild.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel];');
    expect(orchestrator).toContain('reconcileModelWithPlan({ base: await resolveEditableSiteModel(registry, projectId, baseModelRef), baseRef: baseModelRef, sitePlanRef: revised.sitePlanRef, plan: revised.plan })');
    expect(orchestrator).toMatch(/editableSiteModel: frontendBackendExecutionMode === 'job_lifecycle' \? \(canonicalBuild\?\.jobSpec\.inputs\[FRONTEND_BACKEND_INPUT\.editableSiteModel\] \?\? null\) : null,/);
    const authorize = await src('packages/orchestrator/src/visual-refinement/authorize.ts');
    expect(authorize).toContain('{ editableSiteModelRef: build.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel] }');
  });

  it('no production code resolves a model by name or "latest"; every read is the exact, hash-checked ref', async () => {
    for (const file of await allProductionFiles()) {
      // The build-lineage contract may name the artifact a ref must be; it resolves nothing.
      if (file === CONTRACT || file === PERSIST || file === 'packages/contracts/src/build-lineage.ts') continue;
      const code = await src(file);
      expect(code, file).not.toMatch(/EDITABLE_SITE_MODEL_ARTIFACT|'editable-site-model'/);
    }
    const persist = await src(PERSIST);
    expect(persist.match(/registry\.\w+\(/g)?.sort()).toEqual(['registry.getDocument(', 'registry.put(']);
    expect(persist).toContain("if (doc.contentHash !== ref.contentHash) throw new EditableSiteModelRefInvalid(ref, 'the stored content does not match the ref');");
    const resolvers: string[] = [];
    for (const file of await allProductionFiles()) {
      if (/resolveEditableSiteModel\(/.test(await src(file)) && file !== PERSIST) resolvers.push(file);
    }
    expect(resolvers.sort()).toEqual([
      'packages/orchestrator/src/job-handlers/frontend-backend.ts',
      'packages/orchestrator/src/job-validation/frontend-backend.ts',
      'packages/orchestrator/src/orchestrator.ts',
      'packages/orchestrator/src/phases/evaluate.ts',
    ].sort());
  });

  it('the site-model gate runs inside the one deterministic measurement, fed the pinned model, for validation, evaluation and advisory tests alike', async () => {
    const evaluate = await src('packages/orchestrator/src/phases/evaluate.ts');
    const gates = body(evaluate, 'export async function runDeterministicGates(', '\n}\n');
    expect(gates).toContain('const identity = compiled.ok && siteModel ? siteModelMarkerFindings(siteModel, files) : [];');
    expect(gates).toContain('passed: measured.passed && identity.length === 0');
    expect(evaluate).toContain('await runDeterministicGates(deps.workspace.siteRoot, facts.profile, progress.plan, undefined, siteModel)');
    const validation = await src('packages/orchestrator/src/job-validation/frontend-backend.ts');
    expect(validation).toContain('await runDeterministicGates(ws.siteRoot, profile, plan, undefined, siteModel)');
    const runner = await src('packages/orchestrator/src/tool-gateway/test-runner.ts');
    expect(runner).toContain('options.siteModel ?? null');
    const gate = await src(GATE);
    expect(imports(gate).sort()).toEqual(['@statxai/contracts', 'node-html-parser']);
    expect(gate).not.toMatch(/nth-child|:nth|childNodes\[|indexOf\(|\.text\.includes|innerHTML/);
  });

  it('the marker attributes are the contract’s, and repair and refinement are told to preserve them', async () => {
    const contract = await src(CONTRACT);
    expect(body(contract, 'export const SITE_MODEL_MARKERS = Object.freeze({', '} as const);')).toMatch(/page: 'data-statx-page-id',\s*section: 'data-statx-section-id',\s*block: 'data-statx-block-id',\s*field: 'data-statx-field-id',\s*asset: 'data-statx-asset-id',/);
    expect(await src('packages/agents/src/skills/luna-repair.ts')).toContain('Never remove, rename, repeat or move a data-statx-* attribute');
    expect(await src('packages/agents/src/skills/terra-refine.ts')).toContain('Preserve semantic identity exactly');
  });
});

describe('no new authority', () => {
  it('the tool gateway still registers exactly filesystem and test_runner, and no browser or write tool exists', async () => {
    const registered: string[] = [];
    for (const file of await productionFiles('packages/orchestrator/src/tool-gateway')) {
      registered.push(...[...(await src(file)).matchAll(/\btool: '([a-z_]+)'/g)].map((m) => m[1]!));
    }
    expect([...new Set(registered)].sort()).toEqual(['filesystem', 'test_runner']);
    for (const file of await allProductionFiles()) {
      if (file === 'packages/contracts/src/primitives.ts') continue;
      expect(await src(file), file).not.toMatch(/browser_preview|site_model_edit|semantic_patch_tool/);
    }
  });
});
