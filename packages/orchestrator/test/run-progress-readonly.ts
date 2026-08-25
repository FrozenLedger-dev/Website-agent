/**
 * Compile-time half of the phase boundary.
 *
 * Not a Vitest file — it is never executed. It exists so `pnpm typecheck` fails
 * if the phase-facing `RunProgress` stops being read-only: every line below is
 * expected to be an error, and `@ts-expect-error` inverts that, so *removing*
 * a readonly marker makes the build fail on the unused directive.
 *
 * The runtime clone in `run-context.test.ts` is what actually enforces this.
 * These say it to whoever writes the next phase, at the moment they write it.
 */
import type { RunProgress } from '../src/run-context.js';
import type { Defect } from '../src/defects.js';

declare const progress: RunProgress;
declare const defect: Defect;
declare const otherPlan: RunProgress['plan'];

export function aPhaseMayNotWriteToTheRun(): void {
  // @ts-expect-error a phase reports what it found; it does not advance the run
  progress.reviewCycle = 3;

  // @ts-expect-error nor rewrite the plan it was given
  progress.plan = otherPlan;

  // @ts-expect-error nor decide how the run ends
  progress.terminalDecision = 'mark_blocked';

  // @ts-expect-error nor grant a release
  progress.authorization = null;
}

export function aPhaseMayNotGrowTheRunsCollections(): void {
  // @ts-expect-error defects come back as a result, never appended in place
  progress.openDefects.push(defect);

  // @ts-expect-error repair history likewise
  progress.repairHistory.push({ defectId: 'x', fingerprint: 'y', outcome: 'z' });

  // @ts-expect-error and the re-verification queue
  progress.repairedSinceReview.push({ id: 'x', reason: 'y', acceptanceTest: 'z' });

  // @ts-expect-error gates certified a revision; a phase does not add to them
  progress.gatesCertified.push('claims');
}

export function aPhaseMayNotEditTelemetry(): void {
  // @ts-expect-error `track()` owns this, through the owner
  progress.usage.calls = 99;

  // @ts-expect-error as does the phase timer
  progress.phaseMs['evaluate'] = 99;
}

/** Reading, on the other hand, is the whole point. */
export function aPhaseMayRead(): number {
  return progress.reviewCycle + progress.openDefects.length + progress.usage.calls;
}
