/**
 * The `filesystem` tool: read one file of the platform scaffold, and nothing
 * else.
 *
 * What a Terra build is added to before it runs is exactly the platform
 * scaffold — `scaffoldSite` copies it into every candidate, and promotion makes
 * each candidate that scaffold plus Terra's own files. So this reads that tree,
 * rooted at a directory the harness supplies, and never a project workspace,
 * the canonical repository, or anything a model wrote.
 *
 * One operation, and it cannot mutate: this module opens files read-only and
 * imports nothing that writes. Paths are validated strictly rather than
 * normalised — an unsafe spelling is refused, never rewritten into a safe one —
 * and every resolved path, symlinks followed, must still sit inside the root.
 * Hidden files (and so any `.env`) are never readable.
 */
import { open, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { FilesystemReadInput, type FilesystemReadResult } from '@statxai/contracts';
import { isScaffoldExcludedPath } from '@statxai/workspace';
import type { ToolAdapter } from './gateway.js';

/**
 * Per-file content bound. The largest scaffold source a build would usefully
 * read is under 5 KB; the lockfile and the favicon are well over this, and come
 * back truncated or refused rather than filling a prompt.
 */
export const FILESYSTEM_MAX_FILE_BYTES = 12_000;

/** A path that is not a plain, safe, relative path inside the tool's root. */
export class FilesystemPathRefused extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`filesystem path "${path}" is refused: ${reason}`);
    this.name = 'FilesystemPathRefused';
  }
}

function refuseUnsafe(path: string): void {
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new FilesystemPathRefused(path, 'absolute paths are not allowed');
  if (path.includes('\\') || path.includes('\0')) throw new FilesystemPathRefused(path, 'unsupported characters');
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new FilesystemPathRefused(path, 'empty, "." and ".." segments are not allowed');
    }
    if (segment.startsWith('.')) throw new FilesystemPathRefused(path, 'hidden files are not readable');
  }
  if (isScaffoldExcludedPath(path)) throw new FilesystemPathRefused(path, 'not part of the scaffold');
}

export interface ScaffoldFilesystemOptions {
  /** The scaffold root, from trusted harness configuration. */
  readonly root: string;
  readonly maxFileBytes?: number;
}

export function createScaffoldFilesystemAdapter(
  options: ScaffoldFilesystemOptions,
): ToolAdapter<FilesystemReadInput, FilesystemReadResult> {
  const maxFileBytes = options.maxFileBytes ?? FILESYSTEM_MAX_FILE_BYTES;

  return {
    tool: 'filesystem',
    input: FilesystemReadInput,
    describe: (input) => ({ path: input.path }),

    async execute({ path }, signal) {
      signal?.throwIfAborted();
      refuseUnsafe(path);

      const root = await realpath(options.root);
      let target: string;
      try {
        target = await realpath(join(root, path));
      } catch {
        return { tool: 'filesystem', ok: false, path, error: 'not_found' };
      }
      if (!target.startsWith(root + sep)) throw new FilesystemPathRefused(path, 'resolves outside the scaffold');

      const info = await stat(target);
      if (!info.isFile()) return { tool: 'filesystem', ok: false, path, error: 'not_a_file' };

      signal?.throwIfAborted();
      const handle = await open(target, 'r');
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(Math.min(info.size, maxFileBytes));
        await handle.read(buffer, 0, buffer.length, 0);
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();

      if (buffer.includes(0)) return { tool: 'filesystem', ok: false, path, error: 'not_text' };

      return {
        tool: 'filesystem',
        ok: true,
        path,
        content: buffer.toString('utf8'),
        bytes: info.size,
        truncated: info.size > maxFileBytes,
      };
    },
  };
}
