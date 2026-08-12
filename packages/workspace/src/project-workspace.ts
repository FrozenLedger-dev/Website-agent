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

const exec = promisify(execFile);

export class PathEscapesWorkspace extends Error {
  constructor(path: string) {
    super(`Refusing to write outside the workspace: ${path}`);
    this.name = 'PathEscapesWorkspace';
  }
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

  /** Write generated site files. Returns the paths actually written. */
  async writeSiteFiles(files: readonly GeneratedFile[]): Promise<string[]> {
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
}
