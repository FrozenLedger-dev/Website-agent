/**
 * Structural enforcement of the model runtime boundary.
 *
 * Reviewer discipline is not the control. Outside a small, named allowlist, no
 * production source may hold a provider adapter, construct a model client or
 * reach a vendor SDK — so a new model call cannot bypass skill/tier authority
 * or usage reporting without this test failing.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_SKILL_TIERS } from '../src/index.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The only production files allowed below the runtime boundary, and why. */
const ALLOWED = new Set([
  'packages/agents/src/runtime.ts', // the runtime itself, which owns the adapter
  'packages/agents/src/client.ts', // the provider adapter beneath it
  'packages/agents/src/providers/openai.ts', // the one vendor implementation
  'packages/agents/src/providers/types.ts', // the provider contract
  'packages/agents/src/index.ts', // re-exports only
  'scripts/model-check.ts', // operator connectivity diagnostic, not a production skill
]);

/** Anything that reaches beneath the runtime. */
const BELOW_RUNTIME = /\bModelClient\b|\bcreateProvider\b|\.complete\(\s*\{|chat\.completions|from ['"]openai['"]|new OpenAI\b|OpenAiProvider/;

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'test') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

async function productionFiles(): Promise<string[]> {
  const roots = ['packages', 'apps', 'scripts'].map((r) => join(REPO, r));
  const files: string[] = [];
  for (const root of roots) files.push(...(await sources(root)));
  return files.filter((f) => !f.includes(`${join('packages', 'contracts')}`) || true);
}

describe('the model runtime boundary', () => {
  it('no production source outside the allowlist reaches beneath the runtime', async () => {
    const offenders: string[] = [];
    for (const file of await productionFiles()) {
      const rel = relative(REPO, file);
      if (ALLOWED.has(rel)) continue;
      if (BELOW_RUNTIME.test(stripComments(await readFile(file, 'utf8')))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('every skill invokes only through the runtime, under its own name and tier', async () => {
    const dir = join(REPO, 'packages', 'agents', 'src', 'skills');
    const seen = new Set<string>();

    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.ts'))) {
      const skill = basename(name, '.ts');
      const code = stripComments(await readFile(join(dir, name), 'utf8'));

      expect(Object.keys(MODEL_SKILL_TIERS), `${name} is not a registered skill`).toContain(skill);

      if (skill === 'terra-refine') {
        // The one skill that reaches the runtime through Terra's shared bounded build loop
        // rather than its own invoke — and only ever under its own name.
        expect(code, name).not.toMatch(/runtime\.invoke\(|ModelClient|new ModelRuntime/);
        expect(code.match(/invokeTerraBuild\(/g), name).toHaveLength(1);
        expect([...code.matchAll(/\bskill:\s*'([^']+)'/g)].map((m) => m[1]), name).toEqual(['terra-refine']);
        seen.add(skill);
        continue;
      }

      expect(code, name).toMatch(/runtime\.invoke\(\{/);
      const invokes = code.match(/runtime\.invoke\(\{/g)!.length;
      // Terra's shared build loop names its skill per request, defaulting to its own; only build-producing Terra skills may be named.
      const names = [...code.matchAll(/\bskill:\s*(?:request\.skill \?\? )?'([^']+)'/g)].map((m) => m[1]);
      const tiers = [...code.matchAll(/\btier:\s*'([^']+)'/g)].map((m) => m[1]);
      expect(names, name).toEqual(Array(invokes).fill(skill));
      expect(tiers, name).toEqual(Array(invokes).fill(MODEL_SKILL_TIERS[skill as keyof typeof MODEL_SKILL_TIERS]));
      if (skill === 'terra-build') expect(code, name).toMatch(/readonly skill\?: 'terra-build' \| 'terra-refine';/);
      seen.add(skill);
    }

    expect([...seen].sort()).toEqual(Object.keys(MODEL_SKILL_TIERS).sort());
  });

  it('phases never report usage themselves, and the run constructs the one runtime', async () => {
    const orchestrator = join(REPO, 'packages', 'orchestrator', 'src');
    const constructions: string[] = [];
    for (const file of await sources(orchestrator)) {
      const code = stripComments(await readFile(file, 'utf8'));
      expect(code, relative(REPO, file)).not.toMatch(/\.track\(|\btrack\s*:/);
      if (/new ModelRuntime\(/.test(code)) constructions.push(relative(REPO, file));
    }
    expect(constructions).toEqual(['packages/orchestrator/src/orchestrator.ts']);
  });

  it('the runtime holds no control-plane authority', async () => {
    const code = stripComments(await readFile(join(REPO, 'packages', 'agents', 'src', 'runtime.ts'), 'utf8'));
    expect(code).not.toMatch(/@statxai\/(state|workspace|job-engine|orchestrator)|mongodb|node:fs|child_process|registry|store\b/);
  });
});
