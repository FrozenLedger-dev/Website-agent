/**
 * Scaffolding and building the generated site.
 *
 * §7's first deterministic gate is "application build completes successfully".
 * With hand-written HTML that check was vacuous — there was nothing to build.
 * Here it is the real thing: a project that does not compile fails before any
 * model is asked to review it.
 */
import { execFile } from 'node:child_process';
import { cp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Locate templates/site from this package, wherever the process was started. */
export function defaultTemplateRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../..', 'templates/site');
}

export interface BuildResult {
  ok: boolean;
  durationMs: number;
  /** Combined stdout and stderr, tail-truncated — this is what a gate reports. */
  output: string;
  /** Directory containing the exported static site. */
  outDir: string;
}

/** Paths the model may write. Everything else is platform-owned. */
const WRITABLE_PREFIXES = ['app/', 'components/site/'] as const;

export class WriteOutsideModelScope extends Error {
  constructor(readonly path: string) {
    super(
      `Refusing to write "${path}": the model may only write ${WRITABLE_PREFIXES.map((p) => `${p}**`).join(' and ')}.`,
    );
    this.name = 'WriteOutsideModelScope';
  }
}

/**
 * True when a path is the model's to write.
 *
 * `components/ui/**` is excluded deliberately: those are the shadcn primitives
 * the scaffold guarantees, and a builder that "fixes" one breaks every page
 * composing it. Config files and `package.json` are excluded because installing
 * model-authored dependencies would execute model-authored postinstall scripts.
 */
export function isModelWritable(path: string): boolean {
  const normalised = path.replace(/^\/+/, '');
  if (normalised.startsWith('components/ui/')) return false;
  return WRITABLE_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

export function assertModelWritable(path: string): void {
  if (!isModelWritable(path)) throw new WriteOutsideModelScope(path);
}

/** Copy the scaffold into a project, leaving any already-generated files alone. */
export async function scaffoldSite(siteRoot: string, templateRoot = defaultTemplateRoot()): Promise<void> {
  const exists = await stat(templateRoot).catch(() => null);
  if (!exists) throw new Error(`Site template not found at ${templateRoot}`);

  await cp(templateRoot, siteRoot, {
    recursive: true,
    force: false, // never clobber generated pages on a re-scaffold
    filter: (source) => !/(^|[/\\])(node_modules|\.next|out)([/\\]|$)/.test(source),
  });
}

/**
 * Install dependencies and produce the static export.
 *
 * Dependencies are installed rather than vendored because the scaffold pins
 * them; the install is reproducible and its content is not model-influenced.
 */
export async function buildSite(siteRoot: string, timeoutMs = 10 * 60 * 1000): Promise<BuildResult> {
  const started = Date.now();
  const outDir = join(siteRoot, 'out');
  const transcript: string[] = [];

  const run = async (command: string, args: string[]) => {
    const { stdout, stderr } = await exec(command, args, {
      cwd: siteRoot,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        CI: '1',
        NEXT_TELEMETRY_DISABLED: '1',
        // The platform runs with NODE_ENV=development, and inheriting it puts a
        // development React inside a production prerender — which fails with a
        // null `useContext` in a page that names neither the cause nor the file.
        // A production build must say so explicitly.
        NODE_ENV: 'production',
      },
    });
    transcript.push(stdout, stderr);
  };

  try {
    // A stale export would otherwise be gated and deployed if the build failed
    // partway, which is the one outcome worse than failing outright.
    await rm(outDir, { recursive: true, force: true });

    // --frozen-lockfile is the point of shipping a lockfile: the scaffold's
    // dependency graph is the one that was proven to build. Without it, `^`
    // ranges resolve forward and a project fails on a transitive change that
    // has nothing to do with the site — which is how the prerender of
    // /_global-error started throwing on a scaffold that had built minutes
    // earlier.
    await run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline']);
    await run('pnpm', ['build']);

    const produced = await readdir(outDir).catch(() => []);
    if (produced.length === 0) {
      return { ok: false, durationMs: Date.now() - started, output: tail(transcript.join('\n')), outDir };
    }

    return { ok: true, durationMs: Date.now() - started, output: tail(transcript.join('\n')), outDir };
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stdout' in error
        ? `${String((error as { stdout?: string }).stdout ?? '')}\n${String((error as { stderr?: string }).stderr ?? '')}`
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      ok: false,
      durationMs: Date.now() - started,
      output: tail([...transcript, detail].join('\n')),
      outDir,
    };
  }
}

/** Build failures are legible at the end; the head is install noise. */
function tail(text: string, limit = 4_000): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…\n${trimmed.slice(trimmed.length - limit)}`;
}

export interface BuiltFile {
  /** Path relative to the export root, e.g. "index.html". */
  path: string;
  contents: string;
}

/**
 * Read the static export for gating.
 *
 * The gates run against this rather than the TSX source, because it is the
 * markup a visitor and a crawler actually receive. A page can look correct in
 * source and export as an empty shell; only the output settles it.
 */
export async function readBuiltFiles(siteRoot: string): Promise<BuiltFile[]> {
  const outDir = join(siteRoot, 'out');
  const files: BuiltFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(html|css)$/.test(entry.name)) continue;
      files.push({
        path: full.slice(outDir.length + 1).split(sep).join('/'),
        contents: await readFile(full, 'utf8'),
      });
    }
  };

  await walk(outDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Source a repair can meaningfully read and rewrite. */
const SOURCE_EXTENSIONS = /\.(tsx?|jsx?|css|mjs|json)$/i;

/**
 * Read the source files a repair may edit.
 *
 * Distinct from {@link readBuiltFiles}: gates read the export, but a repair has
 * to change the TSX that produced it. It is also the only file list available
 * when the build failed — which is exactly when a repair is needed and no
 * export exists.
 */
export async function readSourceFiles(siteRoot: string): Promise<BuiltFile[]> {
  const files: BuiltFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relative = full.slice(siteRoot.length + 1).split(sep).join('/');
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // Scoped to what the model owns, so a repair can never be handed a config
      // file or a shadcn primitive to "fix".
      if (!isModelWritable(relative)) continue;
      // `app/favicon.ico` is model-writable by path and meaningless as text. A
      // repair handed it as UTF-8 would see replacement characters and could
      // only make it worse.
      if (!SOURCE_EXTENSIONS.test(entry.name)) continue;
      files.push({ path: relative, contents: await readFile(full, 'utf8') });
    }
  };

  for (const prefix of WRITABLE_PREFIXES) {
    await walk(join(siteRoot, prefix.replace(/\/$/, '')));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ExportFile {
  path: string;
  contents: Buffer;
  /** Base64 is required on the wire for anything that is not source text. */
  binary: boolean;
}

const TEXT_EXTENSIONS = /\.(html|css|js|mjs|json|txt|xml|svg|webmanifest|map)$/i;

/**
 * Read the whole static export for deployment.
 *
 * Distinct from {@link readBuiltFiles}, which returns only the markup and CSS a
 * gate needs to parse. A deployment needs every byte — scripts, fonts, icons —
 * and must not lose bits by reading an image as UTF-8.
 */
export async function readExportFiles(siteRoot: string): Promise<ExportFile[]> {
  const outDir = join(siteRoot, 'out');
  const files: ExportFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      files.push({
        path: full.slice(outDir.length + 1).split(sep).join('/'),
        contents: await readFile(full),
        binary: !TEXT_EXTENSIONS.test(entry.name),
      });
    }
  };

  await walk(outDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
