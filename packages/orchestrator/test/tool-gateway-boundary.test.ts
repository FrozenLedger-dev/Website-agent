/**
 * Structural enforcement of the tool boundary.
 *
 * The two worker-exposed tools must stay reachable only through the gateway and
 * only by Terra's build: the filesystem only as reads, the test runner only as
 * advisory measurement through the sandboxed build — and the gateway and model
 * runtime must stay separate authorities.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('the tool boundary', () => {
  it('the tool adapters are constructed only by the gateway owner, and nothing calls them directly', async () => {
    const constructing: string[] = [];
    const executingAdapters: string[] = [];
    for (const file of [...(await productionFiles('packages')), ...(await productionFiles('apps')), ...(await productionFiles('scripts'))]) {
      const code = strip(await readFile(join(REPO, file), 'utf8'));
      if (/(?<!function )create(ScaffoldFilesystem|TestRunner)Adapter\(/.test(code)) constructing.push(relative(REPO, join(REPO, file)));
      if (/adapter\.execute\(/.test(code)) executingAdapters.push(relative(REPO, join(REPO, file)));
    }
    expect(constructing.sort()).toEqual(['packages/orchestrator/src/job-handlers/frontend-backend.ts']);
    expect(executingAdapters).toEqual(['packages/orchestrator/src/tool-gateway/gateway.ts']);
  });

  it('exactly two tool adapters exist — filesystem and test_runner — and every other ToolId is unregistered', async () => {
    const definitions: string[] = [];
    for (const file of await productionFiles('packages/orchestrator/src/tool-gateway')) {
      // An adapter is a `tool` id immediately followed by its input contract.
      for (const match of (await src(file)).matchAll(/\btool:\s*'([a-z_]+)',\s*input:/g)) definitions.push(match[1]!);
    }
    expect(definitions.sort()).toEqual(['filesystem', 'test_runner']);

    const fs = await src('packages/orchestrator/src/tool-gateway/filesystem.ts');
    expect(fs).toMatch(/import \{ open, realpath, stat \} from 'node:fs\/promises';/);
    expect(fs).not.toMatch(/\b(writeFile|appendFile|mkdir|rm|unlink|rename|copyFile|chmod|symlink|truncate|ftruncate|write)\(|child_process|\bexec\(|'w\+?'|'a\+?'/);
    expect(fs).toMatch(/open\(target, 'r'\)/);
  });

  it('test_runner executes candidate code only through runDeterministicGates — the sandboxed build — and starts nothing itself', async () => {
    const runner = await src('packages/orchestrator/src/tool-gateway/test-runner.ts');
    expect(runner).not.toMatch(/child_process|\bexec(File|Sync)?\(|\bspawn\(|process\.env|node_modules\/next|'pnpm'|'next'|'node'/);
    const imports = [...runner.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../phases/evaluate.js', './gateway.js', '@statxai/contracts', '@statxai/workspace', 'node:fs/promises', 'node:path'].sort());
    expect(runner).not.toMatch(/\b(buildSite|executeCandidateBuild|runSandboxed)\b/);

    const measure = runner.slice(runner.indexOf('async function measure('), runner.indexOf('  return {\n    tool:'));
    const order = [
      'assertModelWritableFiles(candidate.files);',
      'await mkdtemp(',
      'await scaffoldSite(ws.siteRoot);',
      'await ws.writeSiteFiles(candidate.files);',
      'await runDeterministicGates(ws.siteRoot, options.profile, options.plan, signal, options.siteModel ?? null)',
    ].map((marker) => measure.indexOf(marker));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(measure).toMatch(/finally \{\s*await rm\(root, \{ recursive: true, force: true \}\);/);
  });

  it('test_runner holds no validation, acceptance, promotion, release, job or project authority', async () => {
    const runner = await src('packages/orchestrator/src/tool-gateway/test-runner.ts');
    expect(runner).not.toMatch(
      /AUTHENTIC|authentic|validateFrontendBackendCandidate|job-validation|job-acceptance|job-promotion|release-publication|run-binding|@statxai\/(state|job-engine|agents)|JobEngine|StateStore|ArtifactRegistry|registry\.|accept|promot|releas|commit\(/i,
    );
    const evaluate = await src('packages/orchestrator/src/phases/evaluate.ts');
    const gates = evaluate.slice(evaluate.indexOf('export async function runDeterministicGates('), evaluate.indexOf('export type SourceFile'));
    expect(gates).not.toMatch(/store|registry|engine|AUTHENTIC|accept|promot/i);
  });

  it('production Terra build has one loop, offering exactly filesystem and test_runner, with independent budgets', async () => {
    const terra = await src('packages/agents/src/skills/terra-build.ts');
    expect(terra.match(/async function invokeTerraBuild\(/g)).toHaveLength(1);
    expect(terra.match(/runtime\.invoke\(\{/g)).toHaveLength(1);
    expect(terra.match(/return invokeTerraBuild\(/g)).toHaveLength(3);
    expect(terra).toMatch(/const LOOP_TOOLS: readonly ToolId\[\] = \['filesystem', 'test_runner'\];/);
    expect(terra).toMatch(/testing && tests >= TERRA_MAX_TEST_RUNS\) \{\s*throw new ToolLoopBudgetExhausted\('test_runs', TERRA_MAX_TEST_RUNS\);/);
    expect(terra).toMatch(/!testing && reads >= TERRA_MAX_TOOL_CALLS\) \{\s*throw new ToolLoopBudgetExhausted\('tool_calls', TERRA_MAX_TOOL_CALLS\);/);
    const access = await src('packages/agents/src/tool-access.ts');
    expect(access).toMatch(/export const TERRA_MAX_MODEL_TURNS = 4;/);
    expect(access).toMatch(/export const TERRA_MAX_TOOL_CALLS = 3;/);
    expect(access).toMatch(/export const TERRA_MAX_TEST_RUNS = 2;/);
  });

  it('a job-lifecycle replan builds under the same grant and the same handler', async () => {
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    expect(orchestrator).toMatch(/const successorSpec = createFrontendBackendJobSpec\(\{/);
    expect(orchestrator).toMatch(/lifecycleCoordinator\.run\(successorSpec/);
    // The factory's grant reaches the successor untouched.
    expect(orchestrator).not.toMatch(/allowedTools|successorSpec\s*=\s*\{|\.\.\.successorSpec/);
    const lifecycle = await src('packages/orchestrator/src/job-lifecycle/frontend-backend.ts');
    expect(lifecycle.match(/createTerraFrontendBackendHandler\(\{/g)).toHaveLength(1);
    const spec = await src('packages/orchestrator/src/job-specs/frontend-backend.ts');
    expect(spec).toMatch(/const ALLOWED_TOOLS = Object\.freeze\(\['filesystem', 'test_runner'\] as const\);/);
    expect(spec).toMatch(/allowedTools: \[\.\.\.ALLOWED_TOOLS\],/);
    // Tool access is supplied by the job handler alone, so the legacy direct build is given none.
    const suppliers: string[] = [];
    for (const file of await productionFiles('packages/orchestrator/src')) {
      if (/\btools: (\{|toolAccess\()/.test(await src(file))) suppliers.push(file);
    }
    expect(suppliers).toEqual(['packages/orchestrator/src/job-handlers/frontend-backend.ts']);
    // A visual refinement runs through the same coordinator, handler and grant: its spec is the factory's, untouched.
    expect(orchestrator).toMatch(/lifecycleCoordinator\.run\(intent\.jobSpec, \{ kind: 'visual_refine', refinementCycle: intent\.refinementCycle \}\)/);
    expect(spec.match(/allowedTools: \[\.\.\.ALLOWED_TOOLS\],/g)).toHaveLength(2);
    const handler = await src('packages/orchestrator/src/job-handlers/frontend-backend.ts');
    expect(handler.match(/toolAccess\('terra-(build|refine)'\)/g)?.sort()).toEqual(["toolAccess('terra-build')", "toolAccess('terra-refine')"]);
  });

  it('the handler takes permission from the claimed job, intersected with what it supports', async () => {
    const handler = await src('packages/orchestrator/src/job-handlers/frontend-backend.ts');
    expect(handler).toMatch(/grantedTools: effectiveTools\(job\.spec\.allowedTools, FRONTEND_BACKEND_SUPPORTED_TOOLS\)/);
    expect(handler).toMatch(/allowedTools: job\.spec\.allowedTools,/);
    expect(handler).toMatch(/supportedTools: FRONTEND_BACKEND_SUPPORTED_TOOLS,/);
    // The default gateway registers exactly the scaffold filesystem and the test runner.
    const factory = handler.slice(handler.indexOf('export function createFrontendBackendToolGateway('), handler.indexOf('function requiredRef('));
    expect(factory).toMatch(/new ToolGateway\(\{\s*adapters: \[\s*createScaffoldFilesystemAdapter\(\{ root: defaultTemplateRoot\(\) \}\),\s*createTestRunnerAdapter\(\{[\s\S]*?\}\),\s*\],\s*\}\)/);
    expect(handler).toMatch(/const gateway = deps\.tools \?\? createFrontendBackendToolGateway\(\{ profile, plan, advisoryWorkspacesRoot, siteModel \}\);/);
    const gateway = await src('packages/orchestrator/src/tool-gateway/gateway.ts');
    expect(gateway).toMatch(/return allowed\.filter\(\(tool\) => supported\.includes\(tool\)\);/);
  });

  it('only Terra build receives tool access, in every one of its call shapes', async () => {
    for (const skill of ['sol-plan', 'sol-route', 'sol-adjudicate', 'sol-replan', 'sol-approve', 'terra-review', 'luna-repair']) {
      expect(await src(`packages/agents/src/skills/${skill}.ts`), skill).not.toMatch(/ToolAccess|tools\b|execute\(/);
    }
    const terra = await src('packages/agents/src/skills/terra-build.ts');
    expect(terra.match(/runtime\.invoke\(\{/g)).toHaveLength(1);
    expect(terra.match(/return invokeTerraBuild\(/g)).toHaveLength(3);

    const build = await src('packages/orchestrator/src/phases/build.ts');
    for (const call of ['buildSite(', 'buildAnchor(', 'buildPage(']) {
      const at = build.indexOf(`await ${call}`) >= 0 ? build.indexOf(`await ${call}`) : build.indexOf(call, build.indexOf('rest.map'));
      expect(build.slice(at, at + 200), call).toMatch(/terraOptions\(ctx, signal\)/);
    }
  });

  it('nothing in the agents package touches a file system', async () => {
    for (const file of await productionFiles('packages/agents/src')) {
      expect(await src(file), file).not.toMatch(/node:fs|from 'fs'|readFile|ToolGateway/);
    }
  });

  it('the model runtime executes no tools, and the gateway invokes no model', async () => {
    const runtime = await src('packages/agents/src/runtime.ts');
    expect(runtime).not.toMatch(/ToolAccess|ToolGateway|execute\(|tool-access/);
    for (const file of await productionFiles('packages/orchestrator/src/tool-gateway')) {
      expect(await src(file), file).not.toMatch(/ModelRuntime|\.invoke\(|@statxai\/state|StateStore|promot|release/i);
    }
  });
});
