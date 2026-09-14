/**
 * How a run ends when it succeeds: the durable authority it concludes into.
 *
 * - `release` — the run seeks release authorisation and publishes, exactly as
 *   every run always has;
 * - `draft` — the run brings the site to the same release-ready state, then
 *   concludes the exact final build as an available canonical draft and stops:
 *   no release judgement, authorisation or publication.
 *
 * Part of the run's immutable intent, recorded before any build work, and never
 * switched mid-run. A run or binding that predates this records nothing, which
 * means `release`.
 */
import * as z from 'zod/v4';

export const RunCompletionTarget = z.enum(['release', 'draft']);
export type RunCompletionTarget = z.infer<typeof RunCompletionTarget>;

/** The target a run asked for, with absence meaning `release`. Anything else is refused. */
export function normalizeRunCompletionTarget(value: unknown): RunCompletionTarget {
  return value === undefined ? 'release' : RunCompletionTarget.parse(value);
}
