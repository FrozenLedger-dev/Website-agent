/**
 * Executable tool contracts.
 *
 * `ToolId` names every capability a job may be granted; this module gives a
 * contract to the ones that actually execute. There are exactly two:
 *
 * - `filesystem` reads one scaffold file. There is no write, delete, list or
 *   execute operation — a request cannot even express one.
 * - `test_runner` measures one proposed `BuildOutput` with the platform's own
 *   sandboxed build and deterministic gates. A request names only the candidate:
 *   no command, arguments, directory, environment, network, mount or limit —
 *   the harness decides how a candidate is tested, never the model.
 */
import * as z from 'zod/v4';
import { BuildOutput } from './artifacts.js';

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

/**
 * One proposed build to measure. Strict: anything beside the candidate — a
 * command, a working directory, an environment — is refused, not ignored.
 */
export const TestRunnerInput = z.strictObject({
  candidate: BuildOutput,
});
export type TestRunnerInput = z.infer<typeof TestRunnerInput>;

/**
 * What measuring a candidate found — advisory feedback, never validation.
 *
 * - `passed`: it compiled and no blocking (P0/P1) gate finding remains.
 * - `failed`: it did not compile, or a blocking gate finding remains.
 * - `timed_out`: the build hit the sandbox's time limit.
 * - `refused`: a file lies outside what the model may write; nothing was built.
 * - `unavailable`: the sandbox could not be provided; nothing was measured.
 *
 * Every text field is bounded and sanitized. `findingCount` is the total before
 * any finding was dropped to fit, and `truncated` says whether one was.
 */
export interface TestRunnerFinding {
  readonly gate: string;
  readonly severity: 'P0' | 'P1' | 'P2' | 'P3';
  readonly location: string;
  readonly message: string;
}

export interface TestRunnerResult {
  readonly tool: 'test_runner';
  readonly status: 'passed' | 'failed' | 'timed_out' | 'refused' | 'unavailable';
  readonly passed: boolean;
  /** Content hash of the exact candidate measured. */
  readonly candidateHash: string;
  readonly compile: { readonly ok: boolean; readonly diagnostics: string } | null;
  readonly findings: readonly TestRunnerFinding[];
  readonly findingCount: number;
  readonly refusedPaths: readonly string[];
  readonly truncated: boolean;
}

/** What any executable tool returns. */
export type ToolResult = FilesystemReadResult | TestRunnerResult;
