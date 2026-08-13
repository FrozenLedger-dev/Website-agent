import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WriteOutsideModelScope,
  assertModelWritable,
  isModelWritable,
  readSourceFiles,
  scaffoldSite,
} from '../src/index.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'statxai-scaffold-'));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('model write scope', () => {
  it.each([
    'app/page.tsx',
    'app/layout.tsx',
    'app/services/page.tsx',
    'app/globals.css',
    'components/site/header.tsx',
  ])('allows %s', (path) => {
    expect(isModelWritable(path)).toBe(true);
  });

  it.each([
    // Installing model-authored dependencies would execute model-authored
    // postinstall scripts, so the dependency set is not the model's to change.
    'package.json',
    'pnpm-lock.yaml',
    'next.config.ts',
    'tsconfig.json',
    'postcss.config.mjs',
    'lib/utils.ts',
    // shadcn primitives are guaranteed by the scaffold; a builder that "fixes"
    // one breaks every page composing it.
    'components/ui/button.tsx',
  ])('refuses %s', (path) => {
    expect(isModelWritable(path)).toBe(false);
    expect(() => assertModelWritable(path)).toThrow(WriteOutsideModelScope);
  });

  it('normalises a leading slash before deciding', () => {
    expect(isModelWritable('/app/page.tsx')).toBe(true);
    expect(isModelWritable('/package.json')).toBe(false);
  });

  it('does not let a ui path masquerade as a site path', () => {
    expect(isModelWritable('components/site/../ui/button.tsx')).toBe(true);
    // The path guard in ProjectWorkspace resolves traversal; this check is
    // about ownership, so both layers are required and neither is sufficient.
  });
});

describe('scaffolding', () => {
  it('produces a buildable project without node_modules or stale output', async () => {
    const site = join(root, 'app');
    await scaffoldSite(site);

    const pkg = JSON.parse(await readFile(join(site, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies['next']).toBeDefined();
    expect(pkg.scripts['build']).toBe('next build');

    // Static export is what makes the gates meaningful: they parse the markup a
    // crawler receives, not the source that produced it.
    const config = await readFile(join(site, 'next.config.ts'), 'utf8');
    expect(config).toContain("output: 'export'");

    // shadcn primitives ship with the scaffold so the model never installs them.
    await expect(readFile(join(site, 'components/ui/button.tsx'), 'utf8')).resolves.toContain('export');

    // The template must never carry build artefacts into a project.
    await expect(readFile(join(site, 'node_modules/.modules.yaml'), 'utf8')).rejects.toThrow();
  });

  it('never clobbers already-generated pages on a re-scaffold', async () => {
    const site = join(root, 'rescaffold');
    await scaffoldSite(site);
    await writeFile(join(site, 'app/page.tsx'), 'export default function P() { return null; }');

    await scaffoldSite(site);

    expect(await readFile(join(site, 'app/page.tsx'), 'utf8')).toContain('function P()');
  });
});

describe('readSourceFiles', () => {
  it('returns the files a repair may edit, and nothing else', async () => {
    // Regression: repairs were fed the static export. When the build failed
    // there was no export, so a P0 build defect resolved to zero files — three
    // repair cycles ran without the model being shown a single line of code,
    // and the run blocked with the budget spent on nothing.
    const site = join(root, 'sources');
    await scaffoldSite(site);
    await mkdir(join(site, 'app/services'), { recursive: true });
    await mkdir(join(site, 'components/site'), { recursive: true });
    await writeFile(join(site, 'app/services/page.tsx'), 'export default function S() { return null; }');
    await writeFile(join(site, 'components/site/hero.tsx'), 'export function Hero() { return null; }');

    const paths = (await readSourceFiles(site)).map((f) => f.path);

    expect(paths).toContain('app/page.tsx');
    expect(paths).toContain('app/layout.tsx');
    expect(paths).toContain('app/globals.css');
    expect(paths).toContain('app/services/page.tsx');
    expect(paths).toContain('components/site/hero.tsx');

    // Platform-owned files are not repairable, so handing them to a repair
    // would only invite a model to "fix" a primitive every page composes.
    expect(paths).not.toContain('components/ui/button.tsx');
    expect(paths.some((p) => p.startsWith('lib/'))).toBe(false);
    expect(paths).not.toContain('package.json');
    expect(paths).not.toContain('next.config.ts');

    // Model-writable by path, but meaningless as text: read as UTF-8 it is
    // replacement characters, and a repair could only make it worse.
    expect(paths).not.toContain('app/favicon.ico');
  });

  it('reads contents, not just names', async () => {
    const site = join(root, 'sources-contents');
    await scaffoldSite(site);
    await writeFile(join(site, 'app/page.tsx'), 'export default function P() { return null; }');

    const files = await readSourceFiles(site);
    expect(files.find((f) => f.path === 'app/page.tsx')?.contents).toContain('function P()');
  });
});
