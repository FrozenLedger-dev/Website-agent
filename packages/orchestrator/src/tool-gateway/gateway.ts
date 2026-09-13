/**
 * The tool gateway — the one harness-owned boundary a worker-exposed tool
 * call crosses before anything executes.
 *
 *   skill asks  ->  ToolGateway.execute  ->  permission  ->  registered adapter
 *
 * Permission is the claimed job's own `JobSpec.allowedTools`, narrowed to what
 * the calling handler actually supports — an intersection, never a union — so
 * neither a spec nor a handler can grant what the other does not. A tool that
 * is permitted but has no registered adapter is unavailable, which is a
 * different answer from forbidden. Nothing is looked up dynamically: the
 * registry is the adapters the harness constructed.
 *
 * What is not a tool, and never registered here: candidate materialisation,
 * validation, acceptance, promotion, commits, state writes and release
 * publication. Those are the harness's own operations.
 *
 * The gateway holds no credentials and records evidence only through the sink
 * it is given — never the input or the result, only safe metadata.
 */
import type * as z from 'zod/v4';
import type { ToolId, WorkerRole } from '@statxai/contracts';
import type { ModelSkill } from '@statxai/agents';

/** Who is asking, and on whose authority. Built by harness code from the claimed job — never from model output. */
export interface ToolCallContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly skill: ModelSkill;
  readonly role: WorkerRole;
  /** The durable grant: the claimed job's own `JobSpec.allowedTools`. */
  readonly allowedTools: readonly ToolId[];
  /** What the calling handler implements. Narrows the grant; never widens it. */
  readonly supportedTools: readonly ToolId[];
}

export interface ToolAdapter<I = unknown, R = unknown> {
  readonly tool: ToolId;
  readonly input: z.ZodType<I>;
  execute(input: I, signal?: AbortSignal): Promise<R>;
  /** Non-secret facts about one call, for evidence. */
  describe(input: I): Readonly<Record<string, string>>;
}

export interface ToolEvidence {
  readonly projectId: string;
  readonly jobId: string;
  readonly skill: ModelSkill;
  readonly role: WorkerRole;
  readonly tool: ToolId;
  readonly outcome: 'succeeded' | 'denied' | 'unavailable' | 'invalid_input' | 'failed' | 'cancelled';
  readonly ms: number;
  readonly detail: Readonly<Record<string, string>>;
}

/** The caller is not permitted this tool. Raised before any adapter is touched. */
export class ToolPermissionDenied extends Error {
  constructor(
    readonly tool: string,
    readonly skill: string,
    readonly role: string,
    readonly jobId: string,
  ) {
    super(`tool "${tool}" is not permitted for ${skill} (${role}) in job "${jobId}"`);
    this.name = 'ToolPermissionDenied';
  }
}

/** Permitted, but no adapter implements it. */
export class ToolUnavailable extends Error {
  constructor(readonly tool: string) {
    super(`tool "${tool}" has no implementation available`);
    this.name = 'ToolUnavailable';
  }
}

/** The request does not satisfy the tool's input contract. */
export class ToolInputInvalid extends Error {
  constructor(
    readonly tool: string,
    detail: string,
  ) {
    super(`tool "${tool}" request is invalid: ${detail}`);
    this.name = 'ToolInputInvalid';
  }
}

/** What a caller may actually use: the grant intersected with what the handler supports. */
export function effectiveTools(allowed: readonly ToolId[], supported: readonly ToolId[]): ToolId[] {
  return allowed.filter((tool) => supported.includes(tool));
}

export interface ToolGatewayOptions {
  readonly adapters: readonly ToolAdapter<unknown, unknown>[];
  readonly onEvidence?: (evidence: ToolEvidence) => void;
}

export class ToolGateway {
  private readonly registry: ReadonlyMap<ToolId, ToolAdapter<unknown, unknown>>;
  private readonly onEvidence: (evidence: ToolEvidence) => void;

  constructor(options: ToolGatewayOptions) {
    const registry = new Map<ToolId, ToolAdapter<unknown, unknown>>();
    for (const adapter of options.adapters) {
      if (registry.has(adapter.tool)) throw new Error(`tool "${adapter.tool}" is registered twice`);
      registry.set(adapter.tool, adapter);
    }
    this.registry = registry;
    this.onEvidence = options.onEvidence ?? (() => {});
  }

  /** The tools this gateway can execute at all — availability, not permission. */
  get registeredTools(): ToolId[] {
    return [...this.registry.keys()];
  }

  async execute<R>(request: {
    readonly tool: ToolId;
    readonly input: unknown;
    readonly context: ToolCallContext;
    readonly signal?: AbortSignal;
  }): Promise<R> {
    const { tool, context, signal } = request;
    const started = Date.now();
    const record = (outcome: ToolEvidence['outcome'], detail: Readonly<Record<string, string>> = {}) =>
      this.onEvidence({
        projectId: context.projectId,
        jobId: context.jobId,
        skill: context.skill,
        role: context.role,
        tool,
        outcome,
        ms: Date.now() - started,
        detail,
      });

    signal?.throwIfAborted();

    if (!effectiveTools(context.allowedTools, context.supportedTools).includes(tool)) {
      record('denied');
      throw new ToolPermissionDenied(tool, context.skill, context.role, context.jobId);
    }

    const adapter = this.registry.get(tool);
    if (!adapter) {
      record('unavailable');
      throw new ToolUnavailable(tool);
    }

    const parsed = adapter.input.safeParse(request.input);
    if (!parsed.success) {
      record('invalid_input');
      throw new ToolInputInvalid(tool, parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    const detail = adapter.describe(parsed.data);
    try {
      const result = (await adapter.execute(parsed.data, signal)) as R;
      signal?.throwIfAborted();
      record('succeeded', detail);
      return result;
    } catch (error) {
      record(signal?.aborted ? 'cancelled' : 'failed', detail);
      throw error;
    }
  }
}
