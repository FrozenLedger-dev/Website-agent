/**
 * Structural enforcement of the untrusted-build sandbox.
 *
 * Generated website code executes during a build. Every production path that
 * builds it — the official candidate validator and canonical evaluation —
 * must reach that execution through the sandbox, and nothing else in
 * production may run a package manager, Node or Next against a site directly.
 * The sandbox module itself must hold no authority beyond running a process.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** Comments removed, strings kept: block comments, and line comments that start a line. */
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true })) {
    if (['node_modules', 'test', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionFiles(path)));
    else if (/\.(tsx?|mjs|cjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

async function allProductionFiles(): Promise<string[]> {
  const packages = await readdir(join(REPO, 'packages'));
  const dirs = [...packages.map((p) => `packages/${p}/src`), 'apps/console/app', 'apps/console/lib', 'scripts'];
  return (await Promise.all(dirs.map(productionFiles))).flat();
}

/** Between the start of one top-level declaration and the next. */
function body(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return code.slice(from, to);
}

const SANDBOX = 'packages/workspace/src/sandbox.ts';
const SITE_BUILD = 'packages/workspace/src/site-build.ts';
const PROJECT_WORKSPACE = 'packages/workspace/src/project-workspace.ts';

describe('no privileged build path exists outside the sandbox', () => {
  it('only the sandbox module and the git-only workspace spawn processes', async () => {
    const spawning: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      if (/child_process|\bexeca\b|node:worker_threads|\bBun\.spawn|\bDeno\.Command/.test(code)) spawning.push(file);
    }
    expect(spawning.sort()).toEqual([PROJECT_WORKSPACE, SANDBOX].sort());
  });

  it('the project workspace spawns git and nothing else', async () => {
    const code = await src(PROJECT_WORKSPACE);
    const calls = [...code.matchAll(/\bexec(?:File)?\(\s*([^,\s]+)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(["'git'"]));
  });

  it('nothing in production names a site build command except the sandboxed executor', async () => {
    const offenders: string[] = [];
    for (const file of await allProductionFiles()) {
      if (file === SITE_BUILD) continue;
      const code = await src(file);
      // Executable forms only — an argv head or the Next bin path — not prose naming the step.
      if (/['"`](?:pnpm|npm|npx|yarn|next|node|tsx|bun|deno)['"`]\s*,\s*\[|next\/dist\/bin\/next/.test(code)) {
        offenders.push(file);
      }
    }
    // The sandbox's own trusted dependency install is the one permitted package-manager call.
    expect(offenders).toEqual([SANDBOX]);
    const sandbox = await src(SANDBOX);
    expect([...sandbox.matchAll(/'pnpm',/g)]).toHaveLength(1);
    expect(body(sandbox, 'async function installTrustedDependencies(', '\nasync function exists(')).toContain("'pnpm',");
  });

  it('site-build spawns nothing itself: buildSite runs the build through runSandboxed only', async () => {
    const code = await src(SITE_BUILD);
    expect(code).not.toMatch(/child_process|(?<!\.)\bexec(File)?\(|\bspawn\(/);

    const build = body(code, 'export async function buildSite(', '\nexport const NEXT_BUILD_COMMAND');
    expect(build).toContain('await executeCandidateBuild(siteRoot, options)');

    const executor = body(code, 'export async function executeCandidateBuild(', '\nasync function materializeCandidateWorkspace(');
    expect(executor).toMatch(/await runSandboxed\(\{[\s\S]*command: NEXT_BUILD_COMMAND,[\s\S]*network: 'font-egress',/);
    expect(executor).toContain('await prepareTrustedDependencies(templateRoot, sandboxRoot)');
    expect(executor).toMatch(/finally \{\s*await rm\(runRoot, \{ recursive: true, force: true \}\);/);
    expect(code).toMatch(/export const NEXT_BUILD_COMMAND = \['node', 'node_modules\/next\/dist\/bin\/next', 'build'\] as const;/);
  });

  it('the build workspace is the trusted scaffold plus model-writable files only', async () => {
    const code = await src(SITE_BUILD);
    const materialize = body(code, 'async function materializeCandidateWorkspace(', '\nasync function chownTree(');

    expect(materialize).toMatch(/await cp\(templateRoot, workspace,/);
    expect(materialize).toContain('if (!entry.isFile()) continue;');
    expect(materialize).toContain('if (!isModelWritable(path)) continue;');
    expect(materialize.indexOf('await cp(templateRoot')).toBeLessThan(materialize.indexOf('isModelWritable(path)'));
    // The dependency tree comes from the scaffold's manifest, never the site's.
    const sandbox = await src(SANDBOX);
    const install = body(sandbox, 'async function installTrustedDependencies(', '\nasync function exists(');
    expect(install).toContain('readFile(join(manifestRoot, file))');
    expect(sandbox).toMatch(/TRUSTED_MANIFEST_FILES = \['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'\] as const/);
  });
});

describe('both generated-code build sites use the sandboxed build', () => {
  it('runDeterministicGates compiles through @statxai/workspace buildSite', async () => {
    const code = await src('packages/orchestrator/src/phases/evaluate.ts');
    expect(code).toMatch(/import \{[^}]*\bbuildSite as compileSite,[\s\S]*?\} from '@statxai\/workspace';/);
    const gates = body(code, 'export async function runDeterministicGates(', '\nexport type SourceFile');
    expect(gates).toMatch(/const compiled = await compileSite\(siteRoot, /);
    expect(gates.indexOf('signal?.throwIfAborted()')).toBeGreaterThan(gates.indexOf('compileSite('));
    expect(gates.indexOf('signal?.throwIfAborted()')).toBeLessThan(gates.indexOf('runGates('));
  });

  it('canonical evaluation measures the canonical site through runDeterministicGates', async () => {
    const code = await src('packages/orchestrator/src/phases/evaluate.ts');
    const evaluate = body(code, 'export async function evaluateSite(', '\nfunction firstErrors(');
    expect(evaluate).toContain('await runDeterministicGates(deps.workspace.siteRoot, facts.profile, progress.plan, undefined, siteModel)');
    expect(evaluate).not.toMatch(/compileSite\(|buildSite\(/);
  });

  it('the official validator writes through the write boundary, then builds through runDeterministicGates', async () => {
    const code = await src('packages/orchestrator/src/job-validation/frontend-backend.ts');
    const validate = body(code, 'export async function validateFrontendBackendCandidate(', '\nasync function ensureRoot(');

    const order = [
      'assertModelWritableFiles(candidate.files);',
      'await mkdtemp(',
      'await scaffoldSite(ws.siteRoot);',
      'await ws.writeSiteFiles(candidate.files);',
      'await runDeterministicGates(ws.siteRoot, profile, plan, undefined, siteModel)',
      'AUTHENTIC_SUCCESSFUL_VALIDATIONS.set(result',
    ].map((marker) => validate.indexOf(marker));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(validate).not.toMatch(/compileSite\(|buildSite\(/);
  });

  it('no other production module imports the site build', async () => {
    const importers: string[] = [];
    for (const file of await allProductionFiles()) {
      const code = await src(file);
      const fromWorkspace = [...code.matchAll(/import\s*\{([^}]*)\}\s*from '@statxai\/workspace'/g)].map((m) => m[1]!);
      if (fromWorkspace.some((names) => /\b(buildSite|executeCandidateBuild|runSandboxed)\b/.test(names))) importers.push(file);
    }
    expect(importers.sort()).toEqual(['packages/orchestrator/src/phases/evaluate.ts', 'scripts/scaffold-check.ts']);
  });
});

describe('the sandbox holds no authority and forwards no environment', () => {
  it('imports only Node built-ins', async () => {
    for (const file of [SANDBOX]) {
      const imports = [...(await src(file)).matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((name) => !name.startsWith('node:'))).toEqual([]);
    }
  });

  it('site-build imports only Node built-ins and the sandbox — no job, acceptance, promotion or release authority', async () => {
    const code = await src(SITE_BUILD);
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    // The one export digest is a pure hash module; nothing else is reached.
    expect(imports.filter((name) => !name.startsWith('node:')).sort()).toEqual(['./export-digest.js', './sandbox.js']);
    expect([...(await src('packages/workspace/src/export-digest.ts')).matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['node:crypto']);
    for (const file of [SANDBOX, SITE_BUILD]) {
      expect(await src(file)).not.toMatch(
        /@statxai\/(state|job-engine|orchestrator|contracts|agents|gates)|mongodb|JobEngine|StateStore|accept\w*Candidate|promot\w+\(|releas\w+\(/,
      );
    }
  });

  it('reads the harness environment only by explicit name', async () => {
    const code = await src(SANDBOX);
    const reads = [...code.matchAll(/process\.env\b(\[[^\]]*\]|\.\w+)?/g)].map((m) => m[0]);
    // `pickEnv` reads named keys; the sanitizer reads values only to redact them.
    expect(reads).toEqual(['process.env[key]', 'process.env']);
    expect(code).toContain('env: NodeJS.ProcessEnv = process.env,');
    expect(code).not.toMatch(/\.\.\.process\.env|env:\s*process\.env|Object\.(entries|keys|assign)\(process\.env/);
    expect(await src(SITE_BUILD)).not.toMatch(/process\.env/);
  });

  it('every child process gets an explicit environment', async () => {
    const code = await src(SANDBOX);
    const execs = [...code.matchAll(/\b(execFile|spawn)\(/g)];
    expect(execs.length).toBe(3);
    for (const call of execs) {
      const window = code.slice(call.index, call.index + 400);
      expect(window).toMatch(/env: (dockerClientEnv\(\)|pickEnv\()/);
    }
    expect(code).toMatch(/const DOCKER_CLIENT_ENV = \['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'\];/);
  });

  it('the container environment is built, not filtered', async () => {
    const code = await src(SANDBOX);
    const env = body(code, 'export function sandboxEnvironment(', '\nexport function sandboxUser(');
    expect(env).not.toMatch(/process|pickEnv/);
    const create = body(code, 'export function sandboxCreateArgs(', '\nfunction bindMount(');
    expect(create).toContain("...Object.entries(spec.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),");
  });

  it('is not exposed as a model tool', async () => {
    for (const file of await allProductionFiles()) {
      if (!file.startsWith('packages/orchestrator/src/tool-gateway/') && !file.startsWith('packages/agents/src/')) continue;
      expect(await src(file), file).not.toMatch(/runSandboxed|executeCandidateBuild|\bbuildSite\b.*@statxai\/workspace/);
    }
  });
});
