/**
 * Provider seam.
 *
 * §1 states the platform "is not dependent on a single model vendor or model
 * name", and §2 lists model portability as a reason for the architecture. This
 * interface is where that stops being a claim: everything above it — the four
 * skill contracts, the gates, the orchestrator, the budgets — is written
 * against tiers, and only the implementations below know a vendor exists.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderRequest {
  model: string;
  system: string;
  prompt: string;
  /** JSON Schema in whichever dialect the provider accepts. */
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens: number;
  effort: Effort;
}

export type StopReason = 'complete' | 'truncated' | 'refusal';

export interface ProviderResponse {
  text: string;
  /** Model that actually served the request, which may be a dated alias. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: StopReason;
  refusalCategory?: string | null;
}

export interface Provider {
  readonly name: 'anthropic' | 'openai';
  /**
   * How this provider wants its JSON Schema. Providers differ on whether
   * optional properties are permitted, so the projection belongs here rather
   * than at the call site.
   */
  readonly schemaDialect: 'standard' | 'strict';
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
