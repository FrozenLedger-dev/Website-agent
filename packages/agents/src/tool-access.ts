/**
 * What a skill may know about tools: which ones the harness granted this
 * invocation, and one function that asks the harness to run one.
 *
 * Deliberately thin. A skill never holds an adapter, never checks a
 * permission and never touches a file system — `execute` is the harness's
 * gateway, which authorises every call again on its own terms. `grantedTools`
 * only decides whether tools are described to the model at all.
 */
import * as z from 'zod/v4';
import { BuildOutput, FilesystemReadInput, ToolId, type FilesystemReadResult } from '@statxai/contracts';

export interface ToolRequest {
  readonly tool: ToolId;
  readonly input: unknown;
}

export interface ToolAccess {
  readonly grantedTools: readonly ToolId[];
  execute(request: ToolRequest, signal?: AbortSignal): Promise<FilesystemReadResult>;
}

/** At most this many model invocations in one Terra build, final answer included. */
export const TERRA_MAX_MODEL_TURNS = 4;
/** At most this many file reads in one Terra build. */
export const TERRA_MAX_TOOL_CALLS = 3;
/**
 * Total file content fed back in one build. The largest scaffold source Terra
 * would usefully read is under 5 KB, so three of them fit several times over.
 */
export const TERRA_MAX_RETURNED_BYTES = 24_000;

/** The build used up one of its explicit bounds before answering. */
export class ToolLoopBudgetExhausted extends Error {
  constructor(
    readonly budget: 'model_turns' | 'tool_calls' | 'returned_bytes',
    readonly limit: number,
  ) {
    super(`Terra build exceeded its ${budget.replace('_', ' ')} limit of ${limit}`);
    this.name = 'ToolLoopBudgetExhausted';
  }
}

/**
 * One turn's response when tools are granted: exactly one tool request, or the
 * final build. Strictly shaped — a request carries a tool and its input and no
 * output; a final answer carries the complete `BuildOutput` and nothing else.
 */
export const TerraBuildAction = z
  .object({
    action: z.enum(['tool', 'final']),
    tool: ToolId.optional(),
    input: FilesystemReadInput.optional(),
    output: BuildOutput.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'tool' && (!value.tool || !value.input || value.output)) {
      ctx.addIssue({ code: 'custom', message: 'a tool action names a tool and its input, and carries no output' });
    }
    if (value.action === 'final' && (!value.output || value.tool || value.input)) {
      ctx.addIssue({ code: 'custom', message: 'a final action carries the output, and no tool request' });
    }
  });
export type TerraBuildAction = z.infer<typeof TerraBuildAction>;
