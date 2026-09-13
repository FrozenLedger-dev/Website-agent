/**
 * Structural enforcement of the tool boundary.
 *
 * The one worker-exposed tool must stay reachable only through the gateway,
 * only by Terra's build, and only as reads — and the gateway and model runtime
 * must stay separate authorities.
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
  it('the filesystem adapter is constructed only by the gateway owner, and nothing calls it directly', async () => {
    const constructing: string[] = [];
    const executingAdapters: string[] = [];
    for (const file of [...(await productionFiles('packages')), ...(await productionFiles('apps')), ...(await productionFiles('scripts'))]) {
      const code = strip(await readFile(join(REPO, file), 'utf8'));
      if (/(?<!function )createScaffoldFilesystemAdapter\(/.test(code)) constructing.push(relative(REPO, join(REPO, file)));
      if (/adapter\.execute\(/.test(code)) executingAdapters.push(relative(REPO, join(REPO, file)));
    }
    expect(constructing.sort()).toEqual(['packages/orchestrator/src/job-handlers/frontend-backend.ts']);
    expect(executingAdapters).toEqual(['packages/orchestrator/src/tool-gateway/gateway.ts']);
  });

  it('exactly one tool adapter exists, and it cannot write', async () => {
    const definitions: string[] = [];
    for (const file of await productionFiles('packages/orchestrator/src/tool-gateway')) {
      // An adapter is a `tool` id immediately followed by its input contract.
      for (const match of (await src(file)).matchAll(/\btool:\s*'([a-z_]+)',\s*input:/g)) definitions.push(match[1]!);
    }
    expect(definitions).toEqual(['filesystem']);

    const fs = await src('packages/orchestrator/src/tool-gateway/filesystem.ts');
    expect(fs).toMatch(/import \{ open, realpath, stat \} from 'node:fs\/promises';/);
    expect(fs).not.toMatch(/\b(writeFile|appendFile|mkdir|rm|unlink|rename|copyFile|chmod|symlink|truncate|ftruncate|write)\(|child_process|\bexec\(|'w\+?'|'a\+?'/);
    expect(fs).toMatch(/open\(target, 'r'\)/);
  });

  it('the handler takes permission from the claimed job, intersected with what it supports', async () => {
    const handler = await src('packages/orchestrator/src/job-handlers/frontend-backend.ts');
    expect(handler).toMatch(/grantedTools: effectiveTools\(job\.spec\.allowedTools, FRONTEND_BACKEND_SUPPORTED_TOOLS\)/);
    expect(handler).toMatch(/allowedTools: job\.spec\.allowedTools,/);
    expect(handler).toMatch(/supportedTools: FRONTEND_BACKEND_SUPPORTED_TOOLS,/);
    // The default gateway registers the scaffold filesystem and nothing else.
    expect(handler).toMatch(/new ToolGateway\(\{ adapters: \[createScaffoldFilesystemAdapter\(\{ root: defaultTemplateRoot\(\) \}\)\] \}\)/);
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
