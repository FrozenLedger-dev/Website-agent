/**
 * Scaffolding and building the generated site.
 *
 * §7's first deterministic gate is "application build completes successfully".
 * With hand-written HTML that check was vacuous — there was nothing to build.
 * Here it is the real thing: a project that does not compile fails before any
 * model is asked to review it.
 *
 * That build executes the model's code, so it runs in the sandbox (`./sandbox.ts`).
 */
import { createHash } from 'node:crypto';
import { exportDigestOf } from './export-digest.js';
import { copyFile, cp, lchown, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SANDBOX_LIMITS,
  prepareTrustedDependencies,
  runSandboxed,
  sandboxUser,
  type SandboxLimits,
} from './sandbox.js';

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
  /** Present only when the build was terminated for exceeding a sandbox limit. */
  limit?: 'time' | 'memory';
  /**
   * The canonical export digest (`exportDigestOf`) of exactly the files this
   * build wrote into `outDir` — present exactly when `ok`. What a later reader of
   * `outDir` must still find there to be reading this build's export.
   */
  exportDigest?: string;
}

/** Paths the model may write. Everything else is platform-owned. */
const WRITABLE_PREFIXES = ['app/', 'components/site/'] as const;

export class WriteOutsideModelScope extends Error {
  /** Every refused path in the rejected set, in input order. */
  readonly paths: readonly string[];

  constructor(
    readonly path: string,
    paths: readonly string[] = [path],
  ) {
    super(
      `Refusing to write ${paths.map((p) => `"${p}"`).join(', ')}: the model may only write ` +
        `${WRITABLE_PREFIXES.map((p) => `${p}**`).join(' and ')} (never components/ui/**).`,
    );
    this.paths = paths;
    this.name = 'WriteOutsideModelScope';
  }
}

/**
 * True when a path is the model's to write — checked exactly as spelled.
 *
 * `components/ui/**` is excluded deliberately: those are the shadcn primitives
 * the scaffold guarantees, and a builder that "fixes" one breaks every page
 * composing it. Config files, the lockfile and `package.json` are excluded
 * because installing or building from model-authored manifests would execute
 * model-authored scripts.
 *
 * Nothing is normalised first. A leading slash, a backslash, a drive letter,
 * an empty, `.` or `..` segment, or any hidden segment (so `.env` and `.git`)
 * is refused outright rather than rewritten into a path that would pass —
 * an unauthorised spelling never becomes an authorised one.
 */
export function isModelWritable(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return false;
  }
  if (path.startsWith('components/ui/')) return false;
  return WRITABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function assertModelWritable(path: string): void {
  if (!isModelWritable(path)) throw new WriteOutsideModelScope(path);
}

/**
 * The one check every model candidate passes before any of it is written.
 *
 * All or nothing: the whole set is examined first, and a single refused path
 * rejects the candidate with every refused path named — so a mixed candidate
 * never lands its permitted half.
 */
export function assertModelWritableFiles(files: readonly { readonly path: string }[]): void {
  const refused = files.map((file) => file.path).filter((path) => !isModelWritable(path));
  if (refused.length > 0) throw new WriteOutsideModelScope(refused[0]!, refused);
}

const SCAFFOLD_EXCLUDE = /(^|[/\\])(node_modules|\.next|out)([/\\]|$)/;

/** Whether a scaffold-relative path is outside what `scaffoldSite` ever copies into a candidate. */
export function isScaffoldExcludedPath(path: string): boolean {
  return SCAFFOLD_EXCLUDE.test(path);
}

/** Copy the scaffold into a project, leaving any already-generated files alone. */
export async function scaffoldSite(siteRoot: string, templateRoot = defaultTemplateRoot()): Promise<void> {
  const exists = await stat(templateRoot).catch(() => null);
  if (!exists) throw new Error(`Site template not found at ${templateRoot}`);

  await cp(templateRoot, siteRoot, {
    recursive: true,
    force: false, // never clobber generated pages on a re-scaffold
    filter: (source) => !SCAFFOLD_EXCLUDE.test(source),
  });
}

/**
 * Every site-relative path `scaffoldSite` would place under `siteRoot` —
 * the same walk-and-filter `cp` runs internally, exposed so a caller can
 * tell the platform scaffold's own legitimate output apart from anything
 * else that might be sitting in a workspace. `scaffoldSite` is
 * deterministic and never model- or candidate-influenced, so this listing
 * changes only when the bundled template itself does.
 */
export async function scaffoldTemplatePaths(templateRoot = defaultTemplateRoot()): Promise<string[]> {
  const paths: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (SCAFFOLD_EXCLUDE.test(full)) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      paths.push(full.slice(templateRoot.length + 1).split(sep).join('/'));
    }
  };

  await walk(templateRoot);
  return paths;
}

/** The line without which the stylesheet contains no Tailwind at all. */
const TAILWIND_IMPORT = '@import "tailwindcss"';

/**
 * Restore the platform-owned head of `app/globals.css`.
 *
 * The builder is told to append brand tokens and never replace the file, and it
 * replaces the file anyway — in four of five deliveries across different
 * industries, in one case writing a comment claiming it had appended. What is
 * lost is the `@import "tailwindcss"` line and the `@theme inline` block that
 * binds the brand variables to Tailwind's tokens, so the build emits a few
 * kilobytes of custom properties and no utilities whatsoever.
 *
 * The failure is invisible in source and near-invisible in the export: the page
 * markup is full of `lg:flex-row`, a stylesheet does exist, and the site simply
 * renders as unstyled text. Three such sites were released at scores of 98 and
 * 99 and deployed to production.
 *
 * So this is not left to the prompt. The head of the stylesheet is platform
 * infrastructure exactly as `components/ui/**` and `package.json` are, and it is
 * re-asserted before every build. The brand tokens the model wrote are kept —
 * only the part it was never entitled to remove is put back.
 */
export async function ensureStylesheetPrelude(
  siteRoot: string,
  templateRoot = defaultTemplateRoot(),
): Promise<boolean> {
  const target = join(siteRoot, 'app/globals.css');
  const current = await readFile(target, 'utf8').catch(() => null);
  if (current === null) return false;
  if (current.includes(TAILWIND_IMPORT)) return false;

  const template = await readFile(join(templateRoot, 'app/globals.css'), 'utf8');

  // Everything above the first `:root` is the platform's: the imports, the dark
  // variant and the @theme mapping. `:root` onwards is where brand tokens live,
  // and those are the model's to write.
  const boundary = template.search(/^:root\b/m);
  const prelude = boundary === -1 ? template : template.slice(0, boundary);

  /**
   * The base layer is platform-owned too, and belongs at the end because its
   * `@apply` rules depend on the tokens above it.
   *
   * Found by verifying rather than assuming: a run with the head restored still
   * had this missing, and the page survived only because the builder had also
   * written `bg-background text-foreground` on `<body>` by hand. That is the
   * same luck that made the original baseline look healthy for weeks.
   */
  const base = /@layer\s+base\s*\{[\s\S]*?\n\}/.exec(template)?.[0] ?? '';
  const restoreBase = base !== '' && !/@layer\s+base\b/.test(current);

  const rebuilt = [prelude.trimEnd(), '', current.trim(), ...(restoreBase ? ['', base] : [])];
  await writeFile(target, `${rebuilt.join('\n')}\n`, 'utf8');
  return true;
}

export interface BuildSiteOptions {
  /** Aborting kills the sandboxed build and rejects with the abort reason. */
  readonly signal?: AbortSignal;
  readonly limits?: Partial<SandboxLimits>;
  /** Where the trusted dependency cache and disposable build workspaces live. */
  readonly sandboxRoot?: string;
  readonly templateRoot?: string;
}

/** Everything in a build that is not the candidate's: dependency cache and per-run workspaces. */
export function defaultSandboxRoot(): string {
  return join(tmpdir(), 'statxai-sandbox');
}

/**
 * Produce the static export of the site at `siteRoot`.
 *
 * The build runs in the sandbox ({@link executeCandidateBuild}), never on the
 * host: the model's code executes there with no harness credentials, no host
 * filesystem and no network beyond Google Fonts. The only thing it hands back
 * is the export, copied into `siteRoot/out`, and bounded, sanitized output.
 *
 * Resolves `ok: false` for a candidate that does not build, times out or runs
 * out of memory — a verdict on the candidate, reported as `BUILD-001` as
 * before. Rejects when aborted, and with `SandboxUnavailable` when the sandbox
 * cannot be provided: neither is something a repair of the site could fix.
 */
export async function buildSite(siteRoot: string, options: BuildSiteOptions = {}): Promise<BuildResult> {
  const started = Date.now();
  const outDir = join(siteRoot, 'out');

  // A stale export would otherwise be gated and deployed if the build failed
  // partway, which is the one outcome worse than failing outright.
  await rm(outDir, { recursive: true, force: true });

  // Every build goes through here — the first one and every rebuild after a
  // repair — so a stylesheet cannot lose its Tailwind import by any route.
  await ensureStylesheetPrelude(siteRoot, options.templateRoot);

  const run = await executeCandidateBuild(siteRoot, options);
  const verdict = run.timedOut
    ? `Build terminated: it exceeded the ${Math.round(run.limits.timeoutMs / 1000)}s time limit.`
    : run.oomKilled
      ? `Build terminated: it exceeded the ${Math.round(run.limits.memoryBytes / 1024 ** 2)} MB memory limit.`
      : '';

  return {
    ok: run.ok,
    durationMs: Date.now() - started,
    output: tail([run.output, verdict].filter(Boolean).join('\n')),
    outDir,
    ...(run.ok && run.exportDigest ? { exportDigest: run.exportDigest } : {}),
    ...(run.timedOut ? { limit: 'time' as const } : run.oomKilled ? { limit: 'memory' as const } : {}),
  };
}

/** The build command. Harness-chosen: no manifest script, so nothing the candidate wrote picks it. */
export const NEXT_BUILD_COMMAND = ['node', 'node_modules/next/dist/bin/next', 'build'] as const;

/** An export larger than this is not a website this platform builds. */
const MAX_EXPORT_BYTES = 512 * 1024 ** 2;

export interface CandidateBuildResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly oomKilled: boolean;
  readonly output: string;
  readonly limits: SandboxLimits;
  /** The canonical digest of the export collected into `siteRoot/out`, when one was. */
  readonly exportDigest?: string;
}

/**
 * The sandboxed candidate executor: materialise the trusted scaffold plus the
 * candidate, run the harness's build command in the sandbox, return what happened.
 *
 * The build workspace is assembled fresh for every run — the platform
 * template first, then only the model-writable files of `siteRoot` — so a
 * `package.json`, config file or primitive sitting in `siteRoot` is never
 * what builds: dependency authority stays with the scaffold. `siteRoot` is
 * read, and its `out/` written, but nothing the build does can reach it; the
 * workspace is removed however the run ends.
 *
 * Owns no authority: it knows nothing of jobs, validation, acceptance,
 * promotion or release, and a successful build here accepts nothing.
 */
export async function executeCandidateBuild(siteRoot: string, options: BuildSiteOptions = {}): Promise<CandidateBuildResult> {
  const templateRoot = options.templateRoot ?? defaultTemplateRoot();
  const sandboxRoot = options.sandboxRoot ?? defaultSandboxRoot();
  const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...options.limits };
  options.signal?.throwIfAborted();

  const dependencies = await prepareTrustedDependencies(templateRoot, sandboxRoot);
  const runs = join(sandboxRoot, 'runs');
  await mkdir(runs, { recursive: true });
  const runRoot = await mkdtemp(join(runs, 'build-'));
  try {
    const workspace = join(runRoot, 'site');
    await materializeCandidateWorkspace(siteRoot, templateRoot, workspace);

    const run = await runSandboxed({
      workspace,
      dependencies,
      command: NEXT_BUILD_COMMAND,
      network: 'font-egress',
      limits,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    const collected = run.exitCode === 0 ? await collectExport(join(workspace, 'out'), join(siteRoot, 'out')) : null;
    const built = collected !== null && collected.files > 0;
    return { ok: built, exitCode: run.exitCode, timedOut: run.timedOut, oomKilled: run.oomKilled, output: run.output, limits, ...(built ? { exportDigest: collected.digest } : {}) };
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

/**
 * The trusted scaffold, overlaid with the model-writable regular files of
 * `siteRoot`. Symlinks are never followed or copied, so a link planted in a
 * site cannot pull a host file into the build.
 */
async function materializeCandidateWorkspace(siteRoot: string, templateRoot: string, workspace: string): Promise<void> {
  await cp(templateRoot, workspace, {
    recursive: true,
    filter: (source) => !SCAFFOLD_EXCLUDE.test(relative(templateRoot, source)),
  });

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(siteRoot, full).split(sep).join('/');
      if (!isModelWritable(path)) continue;
      const target = join(workspace, path);
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { force: true });
      await copyFile(full, target);
    }
  };
  for (const prefix of WRITABLE_PREFIXES) await walk(join(siteRoot, prefix.replace(/\/$/, '')));

  // The mount point for the read-only trusted dependency tree.
  await mkdir(join(workspace, 'node_modules'));

  // A root harness runs the sandbox as `nobody`, which must own what it builds in.
  const { uid, gid } = sandboxUser();
  if (process.getuid?.() === 0) await chownTree(workspace, uid, gid);
}

async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
  await lchown(dir, uid, gid);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await chownTree(full, uid, gid);
    else await lchown(full, uid, gid);
  }
}

/**
 * Copy the export out of the sandbox workspace — after the container is gone,
 * regular files only, within a size budget. Returns the number of files copied.
 */
async function collectExport(from: string, to: string): Promise<{ files: number; digest: string }> {
  let files = 0;
  let bytes = 0;
  const written: { path: string; sha256: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      bytes += (await lstat(full)).size;
      if (bytes > MAX_EXPORT_BYTES) throw new ExportTooLarge();
      const target = join(to, relative(from, full));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(full, target);
      // Digested from what was written, so the digest describes `to`, not the sandbox's copy.
      written.push({ path: relative(to, target).split(sep).join('/'), sha256: createHash('sha256').update(await readFile(target)).digest('hex') });
      files += 1;
    }
  };
  try {
    await walk(from);
  } catch (error) {
    // Not a site this platform builds: no partial export is left to be gated.
    if (!(error instanceof ExportTooLarge)) throw error;
    await rm(to, { recursive: true, force: true });
    return { files: 0, digest: exportDigestOf([]) };
  }
  return { files, digest: exportDigestOf(written) };
}

class ExportTooLarge extends Error {}

/** Build failures are legible at the end; the head is progress noise. */
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
 * A site-relative path the model owns and that is source text — exactly what
 * {@link readSourceFiles} returns from the working tree, as a predicate, so a
 * reader of the same files at an exact Git commit selects the same set.
 */
export function isModelSourceFile(path: string): boolean {
  return isModelWritable(path) && SOURCE_EXTENSIONS.test(path);
}

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
