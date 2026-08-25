/**
 * What a delivery phase is given, and what it is allowed to remember.
 *
 * `runProject` was one 1,400-line function whose helpers all closed over the
 * same twenty-odd locals. That worked, but it meant a phase's inputs were
 * whatever happened to be in scope, so nothing could be read — or tested — on
 * its own. These types make the inputs explicit.
 *
 * The split is deliberate and is the point of the exercise:
 *
 * - {@link RunDeps} is what the run *has*: collaborators, fixed for its
 *   lifetime. Passing them explicitly is what lets a phase be exercised without
 *   standing up the whole delivery.
 * - {@link RunFacts} is what the run *is*: the canonical inputs. Nothing may
 *   revise these, which is the same guarantee the decision contracts give — a
 *   model reads the business profile and has no way to send one back.
 * - {@link RunProgress} is what the run has *done so far*. Mutable by
 *   necessity, and deliberately separate so that "an input" and "a result" are
 *   different kinds of thing rather than two fields in one bag.
 *
 * What is **not** here matters as much. There is no cached budget: budgets are
 * read from the store at the moment a decision needs them and spent inside a
 * transaction, because a snapshot is evidence for a decision and never
 * permission to skip the spend. There is no policy state, no decision cache and
 * no authority of any kind — a context carries facts, it does not conclude
 * anything.
 */
import type { AgentTier, BusinessProfile, SitePlan, TerminalOutcome } from '@statxai/contracts';
import type { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import type { ModelClient } from '@statxai/agents';
import type { BudgetLimits, StateStore } from '@statxai/state';
import type { ReleaseAuthorization } from '@statxai/policy-engine';
import type { Defect } from './defects.js';

export type Progress = (event: {
  phase: string;
  detail: string;
  level?: 'info' | 'warn' | 'ok' | 'fail';
}) => void;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}
export type UsageByTier = Partial<Record<AgentTier, UsageTotals & { ms: number }>>;

/** Collaborators, fixed for the run. */
export interface RunDeps {
  store: StateStore;
  registry: ArtifactRegistry;
  workspace: ProjectWorkspace;
  model: ModelClient;
  /** Emits a progress event and charges wall-clock to the phase it names. */
  say: Progress;
  /** Records a model call against the run and its tier. */
  track: (tier: AgentTier, r: { inputTokens: number; outputTokens: number; ms: number }) => void;
}

/** The canonical inputs. Nothing in a run may revise these. */
export interface RunFacts {
  projectId: string;
  profile: BusinessProfile;
  autonomyMode: string;
  /**
   * Read once, at the start. These are the *limits*, never the usage: what has
   * been spent is read from the store when a decision needs it, and spent
   * transactionally. A cached remainder here would be a second authority.
   */
  budgetLimits: BudgetLimits;
}

/**
 * What the run has done so far, as a phase sees it.
 *
 * Read-only, and detached: {@link snapshotProgress} hands out a deep copy, so a
 * phase cannot reach back into the run through a nested array, and a value it
 * read cannot change underneath it while it works. The `readonly` markers say
 * the same thing at compile time; the clone is what enforces it.
 *
 * A phase reports what it found and the caller decides what to remember. That
 * was already the convention — this makes it the mechanism.
 */
export interface RunProgress {
  /** Never null here: a phase is only handed progress once a plan exists. */
  readonly plan: SitePlan;
  readonly reviewCycle: number;
  readonly repairsApplied: number;
  readonly replansUsed: number;
  readonly qualityScore: number;
  readonly gatesCertified: readonly string[];
  readonly openDefects: readonly Defect[];
  /** Repairs applied since the last review, as evidence for the next one. */
  readonly repairedSinceReview: readonly { id: string; reason: string; acceptanceTest: string }[];
  readonly repairHistory: readonly { defectId: string; fingerprint: string; outcome: string }[];
  readonly terminalDecision: TerminalOutcome | undefined;
  readonly authorization: ReleaseAuthorization | null;
  /** Provenance for the manifest: who recommended, and on which artifact. */
  readonly approvalArtifactVersion: number | null;
  readonly approvalModel: string | null;
  readonly approvalDecision: 'accept' | 'reject' | 'human_review' | null;
  /** Set when the reviewer could not be consulted, which fails closed. */
  readonly reviewUnavailable: string | null;
  readonly usage: Readonly<UsageTotals>;
  readonly usageByTier: Readonly<UsageByTier>;
  readonly phaseMs: Readonly<Record<string, number>>;
}

/**
 * The single owner of run-local delivery progress, held by `runProject`.
 *
 * This is *in-process working state for one invocation*, and nothing more. It
 * is not the authority for anything durable: project state, budgets, defect
 * budget counters, artifact versions and release permission all live in the
 * store, the registry and the policy engine, and are read from there when a
 * decision needs them. Notably absent are budget *remainders* — a cached
 * remainder would be a second authority disagreeing with the transaction.
 *
 * `plan` is nullable only here. Telemetry starts accumulating before a plan
 * exists, so the owner outlives the gap; a phase never sees it.
 */
export interface MutableRunProgress {
  plan: SitePlan | null;
  reviewCycle: number;
  repairsApplied: number;
  replansUsed: number;
  qualityScore: number;
  gatesCertified: string[];
  openDefects: Defect[];
  repairedSinceReview: { id: string; reason: string; acceptanceTest: string }[];
  repairHistory: { defectId: string; fingerprint: string; outcome: string }[];
  terminalDecision: TerminalOutcome | undefined;
  authorization: ReleaseAuthorization | null;
  approvalArtifactVersion: number | null;
  approvalModel: string | null;
  approvalDecision: 'accept' | 'reject' | 'human_review' | null;
  reviewUnavailable: string | null;
  usage: UsageTotals;
  usageByTier: UsageByTier;
  phaseMs: Record<string, number>;
}

export function createRunProgress(): MutableRunProgress {
  return {
    plan: null,
    reviewCycle: 0,
    repairsApplied: 0,
    replansUsed: 0,
    qualityScore: 0,
    gatesCertified: [],
    openDefects: [],
    repairedSinceReview: [],
    repairHistory: [],
    terminalDecision: undefined,
    authorization: null,
    approvalArtifactVersion: null,
    approvalModel: null,
    approvalDecision: null,
    reviewUnavailable: null,
    usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
    usageByTier: {},
    phaseMs: {},
  };
}

/**
 * A phase's view of the owner: a deep copy, taken now.
 *
 * The previous version rebuilt an object from the run's locals, which copied
 * the top level and left every array and telemetry bucket pointing at the
 * owner's live data. A phase could therefore have mutated the run through
 * `openDefects.push(...)`, and a value it read early could differ from the same
 * value read later in the same call. Neither happened, but neither was
 * prevented.
 *
 * `structuredClone` rather than a hand-written copy: every field is plain
 * cloneable data, and an explicit clone would silently go shallow again the
 * next time the shape grows. Not `JSON.parse(JSON.stringify(...))`, which would
 * quietly turn `undefined` into a missing key and any future date into a
 * string.
 */
export function snapshotProgress(owner: MutableRunProgress): RunProgress {
  if (owner.plan === null) {
    // Reaching here would mean a phase was called before planning, which is a
    // wiring mistake rather than a runtime condition worth handling.
    throw new Error('snapshotProgress: no plan yet — a phase was called before planning ran.');
  }
  return structuredClone({ ...owner, plan: owner.plan });
}

/** Everything a phase may be handed. */
export interface RunContext {
  deps: RunDeps;
  facts: RunFacts;
  progress: RunProgress;
}

/**
 * What a phase needs when it does not reason about the run's progress.
 *
 * Planning and building are like this: they act on the canonical inputs and the
 * collaborators, and nothing about how many cycles have happened. Taking the
 * narrower type says so, and lets them run before there is any progress to
 * report.
 */
export type FixedContext = Pick<RunContext, 'deps' | 'facts'>;
