/**
 * Executable tool contracts.
 *
 * `ToolId` names every capability a job may be granted; this module gives a
 * contract to the ones that actually execute. There is exactly one today:
 * `filesystem`, and its only operation is reading one file. There is no write,
 * delete, list or execute operation — a request cannot even express one.
 */
import * as z from 'zod/v4';

/** One file, by site-root-relative path. Validated again, strictly, by the adapter. */
export const FilesystemReadInput = z.object({
  path: z.string().min(1).max(256),
});
export type FilesystemReadInput = z.infer<typeof FilesystemReadInput>;

/**
 * What a read returns — bounded, normalised, and never a host path.
 *
 * A file that is too large comes back truncated and says so. A file that does
 * not exist, is not a file, or is not text is an ordinary answer rather than a
 * crash, so the reader can choose another file.
 */
export type FilesystemReadResult =
  | {
      readonly tool: 'filesystem';
      readonly ok: true;
      readonly path: string;
      readonly content: string;
      /** The file's full size in bytes, whether or not all of it was returned. */
      readonly bytes: number;
      readonly truncated: boolean;
    }
  | {
      readonly tool: 'filesystem';
      readonly ok: false;
      readonly path: string;
      readonly error: 'not_found' | 'not_a_file' | 'not_text';
    };
