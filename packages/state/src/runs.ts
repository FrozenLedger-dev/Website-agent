/**
 * Run records and progress events.
 *
 * Progress is persisted rather than printed. A run takes minutes and outlives
 * any single client, so the console reads from here instead of tailing a
 * process — and stdout from a detached worker is block-buffered anyway, which
 * makes it useless as a live signal.
 */
import type { StateStore } from './store.js';

export type RunStatus = 'running' | 'released' | 'blocked' | 'intake_insufficient' | 'failed';

export interface RunDocument {
  _id: string;
  projectId: string;
  businessName: string;
  autonomyMode: string;
  status: RunStatus;
  phase: string;
  qualityScore: number;
  reviewCycles: number;
  repairsApplied: number;
  commit: string | null;
  /** The public URL of the released site. Null until a release is deployed. */
  liveUrl: string | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number; calls: number };
  /**
   * The same usage split by orchestration tier.
   *
   * Kept alongside the flat total rather than replacing it: tiers map to
   * different models and therefore different rates, so a single aggregate
   * cannot be costed at all.
   */
  usageByTier: Partial<Record<'sol' | 'terra' | 'luna', TierUsage>>;
  /** Wall-clock milliseconds attributed to each phase of the delivery. */
  phaseMs: Record<string, number>;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface TierUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** Time spent inside model calls, which is not the same as phase wall-clock. */
  ms: number;
}

export interface RunEventDocument {
  runId: string;
  seq: number;
  phase: string;
  detail: string;
  level: 'info' | 'warn' | 'ok' | 'fail';
  at: Date;
}

export class RunRecorder {
  private seq = 0;

  constructor(
    private readonly store: StateStore,
    readonly runId: string,
  ) {}

  static async start(
    store: StateStore,
    params: { runId: string; projectId: string; businessName: string; autonomyMode: string },
  ): Promise<RunRecorder> {
    await store.runs.insertOne({
      _id: params.runId,
      projectId: params.projectId,
      businessName: params.businessName,
      autonomyMode: params.autonomyMode,
      status: 'running',
      phase: 'discover',
      qualityScore: 0,
      reviewCycles: 0,
      repairsApplied: 0,
      commit: null,
      liveUrl: null,
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      usageByTier: {},
      phaseMs: {},
      startedAt: new Date(),
      finishedAt: null,
    });
    return new RunRecorder(store, params.runId);
  }

  async event(phase: string, detail: string, level: RunEventDocument['level'] = 'info'): Promise<void> {
    this.seq += 1;
    await this.store.runEvents.insertOne({
      runId: this.runId,
      seq: this.seq,
      phase,
      detail,
      level,
      at: new Date(),
    });
    await this.store.runs.updateOne({ _id: this.runId }, { $set: { phase } });
  }

  async finish(patch: Partial<Omit<RunDocument, '_id'>>): Promise<void> {
    await this.store.runs.updateOne(
      { _id: this.runId },
      { $set: { ...patch, finishedAt: new Date() } },
    );
  }
}
