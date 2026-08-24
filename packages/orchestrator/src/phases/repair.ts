/**
 * Running the repairs the harness has already authorised.
 *
 * An execution phase, deliberately. It is handed a target set that policy
 * authorised and the loop resolved, and it runs exactly that: it does not read
 * Sol's proposal, recompute what is legal, widen the targets, or pick a
 * different defect when one turns out to be unaffordable.
 *
 * Luna proposes file contents. Everything else is the harness's:
 *
 *   Sol adjudicates → policy authorises ids → the loop resolves them →
 *   this phase spends the budget transactionally → Luna writes a file →
 *   the harness filters what may land → the next evaluation judges it
 *
 * The phase reports what happened and the caller remembers it. It appends to no
 * array it was given, which is why its inputs are `readonly`.
 */
import { BudgetExhausted, spendRepairAttempt } from '@statxai/state';
import { repairDefect } from '@statxai/agents';
import { filesForDefect, REPAIR_COMPANIONS, type Defect } from '../defects.js';
import type { RunContext } from '../run-context.js';
import type { SourceFiles } from './evaluate.js';

export interface RepairInput {
  /** Already authorised. This phase neither chooses nor widens them. */
  targets: readonly Defect[];
  sources: SourceFiles;
  /** Export path → the source file that produced it. */
  sourceOf: Readonly<Record<string, string>>;
}

export interface RepairOutcome {
  /** Defects for which at least one permitted file was written. */
  repairsAppliedDelta: number;
  /** True when an authoritative spend was refused. Not a decision. */
  exhausted: boolean;
  /** Queued for explicit re-verification by the next review. */
  repairedSinceReview: { id: string; reason: string; acceptanceTest: string }[];
  repairHistoryEntries: { defectId: string; fingerprint: string; outcome: string }[];
}

export async function executeRepairs(
  ctx: RunContext,
  input: RepairInput,
): Promise<RepairOutcome> {
  const { deps, facts, progress } = ctx;

  let repairsAppliedDelta = 0;
  const repairedSinceReview: RepairOutcome['repairedSinceReview'] = [];
  const repairHistoryEntries: RepairOutcome['repairHistoryEntries'] = [];

  let exhausted = false;
  for (const defect of input.targets) {
    try {
      await deps.store.withTransaction((session) =>
        spendRepairAttempt(deps.store, facts.projectId, defect.fingerprint, progress.reviewCycle, session),
      );
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      deps.say({
        phase: 'repair',
        detail: `${defect.id} skipped — ${error.budget} exhausted`,
        level: 'warn',
      });
      exhausted = true;
      continue;
    }

    const scope = filesForDefect(
      defect.location,
      input.sources.map((f) => f.path),
      defect.reason,
      input.sourceOf,
    );
    const companions = input.sources.filter((f) => (REPAIR_COMPANIONS as readonly string[]).includes(f.path));

    /**
     * One call per file rather than one call for the whole scope.
     *
     * A defect can legitimately span several pages, but asking a single call
     * to return four complete pages exceeds the output ceiling and truncates
     * — the repair then fails wholesale. Per-file calls keep each response
     * small, and they are a better reading of §3's "smallest reasonable
     * scope" anyway. The budget is still spent once for the defect, because
     * it is one defect however many files it touches.
     */
    const editable = scope.filter((p) => !(REPAIR_COMPANIONS as readonly string[]).includes(p));
    const units = editable.length > 0 ? editable : scope;

    let written = 0;
    let refused = 0;
    let failed = 0;

    for (const target of units) {
      const context = [
        ...input.sources.filter((f) => f.path === target),
        ...companions.filter((f) => f.path !== target),
      ];
      try {
        const repaired = await repairDefect(deps.model, facts.profile, defect, context);
        deps.track('luna', repaired);

        // Luna may only rewrite files it was given. Enforced here rather than
        // trusted to the prompt.
        const allowed = new Set(context.map((f) => f.path));
        const permitted = repaired.value.files.filter((f) => allowed.has(f.path));
        refused += repaired.value.files.length - permitted.length;
        await deps.workspace.writeSiteFiles(permitted);
        written += permitted.length;
      } catch (error) {
        // A failed repair must not kill the delivery. The budget is already
        // spent, the defect stays open, and Sol escalates through the normal
        // path when the rejection budget runs out.
        failed += 1;
        deps.say({
          phase: 'repair',
          detail: `${defect.id} on ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
          level: 'warn',
        });
      }
    }

    // Queued for explicit re-verification in the next review, so a repair is
    // never assumed to have worked just because it was attempted.
    repairedSinceReview.push({
      id: defect.id,
      reason: defect.reason,
      acceptanceTest: defect.acceptanceTest,
    });
    if (written > 0) repairsAppliedDelta += 1;

    // Recorded so the next adjudication can tell a first attempt from a
    // defect that narrow repair has already failed to clear.
    repairHistoryEntries.push({
      defectId: defect.id,
      fingerprint: defect.fingerprint,
      outcome:
        failed > 0 && written === 0
          ? `failed (${failed} file(s))`
          : `${written} file(s) rewritten${refused > 0 ? `, ${refused} refused` : ''}`,
    });

    deps.say({
      phase: 'repair',
      detail:
        `${defect.id} [${defect.severity} ${defect.category}] across ${units.length} file(s) → ${written} written` +
        `${refused > 0 ? `, ${refused} out-of-scope refused` : ''}${failed > 0 ? `, ${failed} failed` : ''}`,
      level: failed > 0 ? 'warn' : 'info',
    });
  }

  await deps.workspace.commit(`Luna: repair cycle ${progress.reviewCycle}`);

  return { repairsAppliedDelta, exhausted, repairedSinceReview, repairHistoryEntries };
}
