/**
 * The model runtime — the one harness-owned boundary every production model
 * invocation crosses.
 *
 * Skills describe what to ask; the harness decides how a model is invoked.
 * Before this, every skill held a `ModelClient` directly and usage accounting
 * depended on each caller remembering to report it afterwards. Now:
 *
 *   skill  ->  ModelRuntime.invoke  ->  ModelClient (provider adapter)  ->  Provider
 *
 * What this boundary owns:
 *   - which skills exist, and which orchestration tier each one runs at —
 *     an invocation naming a skill at any other tier is refused;
 *   - an identity for each invocation, for evidence and tracing only;
 *   - reporting usage, exactly once per successful invocation, to the one
 *     observer the run supplied — a skill cannot skip it, and a caller cannot
 *     add to it;
 *   - forwarding cancellation down to the provider.
 *
 * What stays where it was: tier -> model resolution, schema projection and
 * strict parsing, the refusal/malformed-output distinction and the single
 * truncation retry all live in `ModelClient`, unchanged; request timeouts and
 * transport retries live in the provider, unchanged.
 *
 * What it deliberately does not own: project state, artifacts, budgets, jobs,
 * Git, promotion or release. It returns a typed result, and harness code
 * decides what that result is allowed to change. It runs no tool loop.
 */
import { randomUUID } from 'node:crypto';
import type * as z from 'zod/v4';
import type { AgentTier } from '@statxai/contracts';
import { ModelClient, type CallResult } from './client.js';
import type { Effort, ModelImage, Provider } from './providers/types.js';

/**
 * Every production model skill, by its existing name, and the one tier it runs
 * at. The authority for which tier a skill may invoke — not a preference.
 */
export const MODEL_SKILL_TIERS = {
  'sol-plan': 'sol',
  'sol-route': 'sol',
  'sol-adjudicate': 'sol',
  'sol-replan': 'sol',
  'sol-approve': 'sol',
  'terra-build': 'terra',
  'terra-review': 'terra',
  'terra-refine': 'terra',
  'terra-edit': 'terra',
  'luna-repair': 'luna',
} as const satisfies Record<string, AgentTier>;

export type ModelSkill = keyof typeof MODEL_SKILL_TIERS;

/** An invocation named a skill that does not exist, or a tier that skill does not run at. */
export class ModelSkillTierMismatch extends Error {
  constructor(
    readonly skill: string,
    readonly tier: string,
  ) {
    super(
      skill in MODEL_SKILL_TIERS
        ? `model skill "${skill}" runs at tier "${MODEL_SKILL_TIERS[skill as ModelSkill]}", not "${tier}"`
        : `"${skill}" is not a known model skill`,
    );
    this.name = 'ModelSkillTierMismatch';
  }
}

/** Per-call options a skill forwards from its caller. */
export interface ModelCallOptions {
  /** Cancels the invocation at the provider; an aborted call never resolves as a result. */
  readonly signal?: AbortSignal;
}

export interface ModelInvocation<T> extends ModelCallOptions {
  readonly skill: ModelSkill;
  readonly tier: AgentTier;
  /** Label used as the provider-side schema name, exactly as before. */
  readonly label: string;
  readonly system: string;
  readonly prompt: string;
  /** Images the model sees after the prompt. One invocation, however many images: still one usage event. */
  readonly images?: readonly ModelImage[];
  readonly schema: z.ZodType<T>;
  readonly maxTokens?: number;
  readonly effort?: Effort;
}

export interface ModelInvocationResult<T> extends CallResult<T> {
  /** Unique per invocation. Evidence and tracing only — never workflow authority. */
  readonly invocationId: string;
  readonly skill: ModelSkill;
  readonly tier: AgentTier;
}

/** One successful invocation's usage, reported once. */
export interface ModelUsageEvent {
  readonly invocationId: string;
  readonly skill: ModelSkill;
  readonly tier: AgentTier;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ms: number;
}

export interface ModelRuntimeOptions {
  /** The provider adapter. Created lazily when omitted, so constructing a runtime never needs credentials. */
  readonly client?: ModelClient;
  /** A provider for a runtime-owned adapter — the test and portability seam. Ignored when `client` is given. */
  readonly provider?: Provider;
  /** Receives usage for every successful invocation. */
  readonly onUsage?: (event: ModelUsageEvent) => void;
}

export class ModelRuntime {
  private client: ModelClient | undefined;
  private readonly provider: Provider | undefined;
  private readonly onUsage: (event: ModelUsageEvent) => void;

  constructor(options: ModelRuntimeOptions = {}) {
    this.client = options.client;
    this.provider = options.provider;
    this.onUsage = options.onUsage ?? (() => {});
  }

  async invoke<T>(invocation: ModelInvocation<T>): Promise<ModelInvocationResult<T>> {
    if (MODEL_SKILL_TIERS[invocation.skill] !== invocation.tier) {
      throw new ModelSkillTierMismatch(invocation.skill, invocation.tier);
    }

    const invocationId = randomUUID();
    this.client ??= new ModelClient(this.provider);

    const result = await this.client.call({
      tier: invocation.tier,
      label: invocation.label,
      system: invocation.system,
      prompt: invocation.prompt,
      ...(invocation.images !== undefined ? { images: invocation.images } : {}),
      schema: invocation.schema,
      ...(invocation.maxTokens !== undefined ? { maxTokens: invocation.maxTokens } : {}),
      ...(invocation.effort !== undefined ? { effort: invocation.effort } : {}),
      ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
    });

    this.onUsage({
      invocationId,
      skill: invocation.skill,
      tier: invocation.tier,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ms: result.ms,
    });

    return { ...result, invocationId, skill: invocation.skill, tier: invocation.tier };
  }
}
