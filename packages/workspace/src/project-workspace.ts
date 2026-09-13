/**
 * Per-project Git workspace (v1.2 §1, "Git repository per website/project").
 *
 * Layout follows Appendix A. The generated site lives under `app/`; the
 * canonical artifacts are materialised alongside it so a worker sees the
 * documented structure on disk.
 *
 * §9 requires publishing from a machine-accepted source revision rather than
 * mutable agent workspace state — `commit()` returns the SHA that the
 * deployment manifest records, and release reads that revision, not the
 * working tree.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { GeneratedFile } from '@statxai/contracts';
import { assertModelWritableFiles } from './site-build.js';

const exec = promisify(execFile);

export class PathEscapesWorkspace extends Error {
  constructor(path: string) {
    super(`Refusing to write outside the workspace: ${path}`);
    this.name = 'PathEscapesWorkspace';
  }
}

/**
 * One uncommitted working-tree change, as git reports it.
 *
 * `status` is git's raw two-character `XY` code — index status then
 * working-tree status — kept verbatim rather than interpreted into an enum
 * here, so a caller can ask the exact question it needs (`is this a
 * deletion?`, `is this untracked?`) without this module having to anticipate
 * every such question. `' D'` is a tracked file deleted in the working tree,
 * `' M'` one that was modified, `'??'` an untracked path.
 */
export interface DirtyEntry {
  readonly status: string;
  readonly path: string;
}

export class ProjectWorkspace {
  private constructor(
    readonly projectId: string,
    readonly root: string,
  ) {}

  get siteRoot(): string {
    return join(this.root, 'app');
  }

  static async open(projectId: string, workspacesRoot: string): Promise<ProjectWorkspace> {
    const root = resolve(workspacesRoot, projectId);
    await mkdir(join(root, 'app'), { recursive: true });
    await mkdir(join(root, 'client'), { recursive: true });
    await mkdir(join(root, 'design'), { recursive: true });
    await mkdir(join(root, 'specs', 'pages'), { recursive: true });
    await mkdir(join(root, 'validation'), { recursive: true });
    await mkdir(join(root, 'deployment'), { recursive: true });

    const ws = new ProjectWorkspace(projectId, root);
    await ws.git('init', '-q');
    await ws.git('config', 'user.email', 'sol@statxai.local');
    await ws.git('config', 'user.name', 'STATXAI Sol');
    return ws;
  }

  private async git(...args: string[]): Promise<string> {
    // `safe.directory` is set per-invocation rather than relying on global git
    // config. A project workspace can legitimately be owned by a different user
    // than the worker process — a run started as root against a checkout owned
    // by a developer, or a container writing a host-mounted volume — and git
    // refuses to operate on it ("detected dubious ownership"). That surfaced as
    // an entire delivery failing at commit time, after the build had succeeded.
    const { stdout } = await exec(
      'git',
      ['-c', `safe.directory=${this.root}`, '-C', this.root, ...args],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.trim();
  }

  /**
   * Resolve a site-relative path, refusing anything that escapes the site root.
   *
   * The path comes from model output, so `../../etc/passwd` and absolute paths
   * are live inputs, not hypotheticals.
   */
  private safeSitePath(path: string): string {
    // A leading slash means "site root" to a model, not "filesystem root".
    // Strip it before resolving, or `resolve()` discards the base entirely and
    // an obviously-intended "/about.html" is refused as an escape attempt.
    // Traversal is still caught by the containment check below.
    const target = resolve(this.siteRoot, path.replace(/^\/+/, ''));
    const rel = relative(this.siteRoot, target);
    if (rel.startsWith('..') || rel.startsWith(sep) || resolve(rel) === rel) {
      throw new PathEscapesWorkspace(path);
    }
    return target;
  }

  /**
   * The exact repo-root-relative path `path` resolves to — the same
   * containment-checked resolution `writeSiteFiles`/`readSiteFile` use,
   * exposed so a caller can compare a site-relative candidate path against
   * repo-root-relative output like {@link dirtyPaths}.
   */
  siteFileRepoPath(path: string): string {
    return relative(this.root, this.safeSitePath(path));
  }

  /**
   * Write model-generated site files. Returns the paths actually written.
   *
   * The model-candidate write boundary: every production path that lands model
   * output — validation, the direct build, repair, promotion — comes through
   * here, so the model-writable check runs once, for all of them, over the
   * whole set before a single file is written. Trusted harness content never
   * uses this: the scaffold is copied by `scaffoldSite`, and harness records go
   * through `materialiseArtifact`.
   */
  async writeSiteFiles(files: readonly GeneratedFile[]): Promise<string[]> {
    assertModelWritableFiles(files);
    const written: string[] = [];
    for (const file of files) {
      const target = this.safeSitePath(file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, 'utf8');
      written.push(file.path);
    }
    return written;
  }

  async readSiteFile(path: string): Promise<string> {
    return readFile(this.safeSitePath(path), 'utf8');
  }

  /** Every file currently in the site, as site-relative paths. */
  async listSiteFiles(): Promise<string[]> {
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const out: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else out.push(relative(this.siteRoot, full));
      }
      return out;
    };
    return (await walk(this.siteRoot)).sort();
  }

  /** Clear the site directory — used before a controlled full rebuild. */
  async clearSite(): Promise<void> {
    await rm(this.siteRoot, { recursive: true, force: true });
    await mkdir(this.siteRoot, { recursive: true });
  }

  /** Materialise a canonical artifact into its Appendix A location. */
  async materialiseArtifact(relPath: string, data: unknown): Promise<void> {
    const target = resolve(this.root, relPath);
    if (!target.startsWith(this.root + sep)) throw new PathEscapesWorkspace(relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  /**
   * Every uncommitted working-tree change, with git's own two-letter status
   * code preserved alongside the repo-root-relative path.
   *
   * The code is the part that distinguishes "somebody edited this file" from
   * "this file is already gone". A caller deciding whether it may delete a
   * path cannot tell those apart from the path alone, and treating them the
   * same is how local work gets silently erased — so the status travels with
   * the path rather than being discarded here.
   *
   * `git status --porcelain -z`: `-z` so a path is never subject to git's own
   * quoting/escaping, unlike the plain porcelain format `commit()` uses for
   * its own simpler empty-vs-nonempty check. A rename or copy entry is
   * reported by its destination path only; git does not detect renames in
   * unstaged working-tree status by default, so that is a defensive
   * allowance rather than behaviour anything here currently exercises.
   */
  async dirtyEntries(): Promise<DirtyEntry[]> {
    // `--untracked-files=all`: without it, a wholly-new untracked directory
    // (the common case for `app/` on a first-ever promotion, before
    // anything has committed it) is reported as one collapsed `app/` entry
    // rather than each file inside it — which would make every individual
    // file this method is meant to recognise look "unexpected."
    const { stdout } = await exec(
      'git',
      [
        '-c', `safe.directory=${this.root}`,
        '-C', this.root,
        'status', '--porcelain', '-z', '--untracked-files=all',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const fields = stdout.split('\0').filter((field) => field.length > 0);
    const entries: DirtyEntry[] = [];
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i]!;
      entries.push({ status: entry.slice(0, 2), path: entry.slice(3) });
      // Rename/copy entries carry the original path as a second field.
      if (entry[0] === 'R' || entry[0] === 'C') i++;
    }
    return entries;
  }

  /**
   * Every path with an uncommitted change in the working tree, repo-root
   * relative. The path-level view of {@link dirtyEntries}, unchanged for the
   * callers that only ever asked "is this path unexpectedly dirty?".
   */
  async dirtyPaths(): Promise<string[]> {
    return (await this.dirtyEntries()).map((entry) => entry.path);
  }

  /**
   * The managed generated-site files git actually tracks, repo-root relative.
   *
   * Git's index, never a directory walk: what a promotion must reason about
   * is the *committed* membership of the predecessor site, and a filesystem
   * scan would additionally sweep up untracked scratch files and ignored
   * build output (`.next/`, `out/`, `node_modules/`) that no promotion owns.
   *
   * A tracked file deleted in the working tree but not yet staged is still
   * listed here, because it is still in the index — which is what lets an
   * interrupted promotion recompute exactly the same set on its retry
   * instead of concluding the file was never its concern.
   *
   * Empty before a project's first site commit, which is exactly right: a
   * first promotion has no predecessor membership to reconcile against.
   */
  async trackedSiteFiles(): Promise<string[]> {
    const { stdout } = await exec(
      'git',
      [
        '-c', `safe.directory=${this.root}`,
        '-C', this.root,
        'ls-files', '-z', '--', relative(this.root, this.siteRoot),
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split('\0').filter((path) => path.length > 0);
  }

  /** Commit the working tree. Returns the commit SHA, or null if nothing changed. */
  async commit(message: string): Promise<string | null> {
    await this.git('add', '-A');
    const status = await this.git('status', '--porcelain');
    if (status === '') return null;
    await this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  async currentCommit(): Promise<string | null> {
    return this.git('rev-parse', 'HEAD').catch(() => null);
  }

  /**
   * Every commit SHA whose message contains `marker` as a full line, oldest
   * first as `git log` itself orders them — the general form, generalised
   * from Phase 5h's own single-match {@link findCommitByMarker} so a second
   * caller with its own deterministic marker (Phase 5k's build-binding
   * specification commit) can detect the "more than one exists" case that a
   * single match can't distinguish from "found the only one" — genuine
   * corruption, since this workspace's own callers only ever create at most
   * one commit per exact deterministic marker, by construction. Searches
   * the whole of history (`--all`), not merely whatever is currently
   * checked out: a commit a later one has since been built on top of is
   * still found here, deliberately (Phase 5h's own "promotion commit may
   * become an ancestor" requirement) — this never looks at, and never
   * changes, which commit is HEAD.
   *
   * Matching is exact-line, not substring: `%B` (the raw commit message) is
   * split on newlines, and `marker` must equal one of those lines exactly.
   * A commit whose message merely *mentions* the marker text as part of a
   * longer line does not match. `\x01`/`\x02` are used as field/record
   * separators in git's own `--format`, chosen because a real commit message
   * containing either is not a byte sequence any of this codebase's own
   * commits (or a plausible unrelated one) would ever produce.
   */
  async findCommitsByMarker(marker: string): Promise<string[]> {
    const FIELD_SEP = '\x01';
    const ENTRY_SEP = '\x02';
    let stdout: string;
    try {
      stdout = await this.git('log', '--all', `--format=%H${FIELD_SEP}%B${ENTRY_SEP}`);
    } catch {
      // No commits yet — `git log` on an empty repository exits non-zero.
      return [];
    }
    const shas: string[] = [];
    for (const rawEntry of stdout.split(ENTRY_SEP)) {
      const entry = rawEntry.trim();
      if (entry === '') continue;
      const sep = entry.indexOf(FIELD_SEP);
      if (sep === -1) continue;
      const sha = entry.slice(0, sep);
      const message = entry.slice(sep + FIELD_SEP.length);
      if (message.split('\n').some((line) => line.trim() === marker)) shas.push(sha);
    }
    return shas;
  }

  /**
   * The exact commit SHA whose message contains `marker` as a full line, or
   * `null` if no such commit exists. The first match from
   * {@link findCommitsByMarker} — every existing caller's markers are
   * deterministic and expected to identify at most one commit, so "first"
   * and "only" already coincide for them; a caller that must also tell
   * "exactly one" apart from "more than one" (genuine corruption) uses
   * {@link findCommitsByMarker} directly instead.
   */
  async findCommitByMarker(marker: string): Promise<string | null> {
    const shas = await this.findCommitsByMarker(marker);
    return shas[0] ?? null;
  }
}
