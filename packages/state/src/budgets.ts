/**
 * Bounded autonomous approval & retry budgets (v1.2 §7).
 *
 * These are safety and cost controls: they keep the system autonomous while
 * forcing a deterministic outcome once repeated attempts stop making progress.
 * Every spend is a conditional update inside the caller's transaction, so a
 * budget can never be spent on work that did not also commit.
 */
import type { ClientSession } from 'mongodb';
import { defectBudgetId, type BudgetLimits, type BudgetUsage } from './documents.js';
import { BudgetExhausted, type StateStore } from './store.js';

/** Countable project-level budgets. `repairsPerDefect` is keyed separately. */
export type ProjectBudgetKey = keyof BudgetUsage;

/**
 * Recommended MVP defaults from the §7 table.
 *
 * Note for the architecture review — these six numbers do not fully close.
 * A review cycle returning 5 blocking issues spends 5 of the 8 total repair
 * jobs; a second cycle returning 4 exhausts the budget mid-cycle, so the third
 * permitted rejection cycle is unreachable in any realistic multi-issue run.
 * Implemented exactly as documented, since they are configurable per project
 * and this is a tuning question for the pilot (§10, step 8) rather than a code
 * change.
 */
export const DEFAULT_BUDGET_LIMITS: Readonly<BudgetLimits> = Object.freeze({
  reviewRejections: 3,
  repairsPerDefect: 2,
  totalRepairJobs: 8,
  fullRebuilds: 1,
  replans: 2,
  failedDeployments: 2,
});

export const ZERO_USAGE: Readonly<BudgetUsage> = Object.freeze({
  reviewRejections: 0,
  totalRepairJobs: 0,
  fullRebuilds: 0,
  replans: 0,
  failedDeployments: 0,
});

export async function createBudget(
  store: StateStore,
  projectId: string,
  limits: Partial<BudgetLimits> = {},
  session?: ClientSession,
): Promise<void> {
  await store.budgets.insertOne(
    {
      _id: projectId,
      limits: { ...DEFAULT_BUDGET_LIMITS, ...limits },
      used: { ...ZERO_USAGE },
      updatedAt: new Date(),
    },
    session ? { session } : {},
  );
}

/**
 * Spend one unit of a project-level budget, or throw {@link BudgetExhausted}.
 *
 * The guard compares two fields of the same document, which in MongoDB requires
 * `$expr`. Written the intuitive way — `{ 'used.replans': { $lt: '$limits.replans' } }`
 * — the right-hand side is the literal string "$limits.replans", and MongoDB
 * does not compare across BSON types, so the filter matches nothing whether the
 * budget is exhausted or not: every spend would be refused as though the
 * project had started with an empty budget.
 */
export async function spend(
  store: StateStore,
  projectId: string,
  key: ProjectBudgetKey,
  session?: ClientSession,
): Promise<void> {
  const result = await store.budgets.updateOne(
    { _id: projectId, $expr: { $lt: [`$used.${key}`, `$limits.${key}`] } },
    { $inc: { [`used.${key}`]: 1 }, $set: { updatedAt: new Date() } },
    session ? { session } : {},
  );
  if (result.matchedCount === 0) throw new BudgetExhausted(key);
}

/**
 * Spend a repair attempt against a specific defect.
 *
 * Two budgets bind at once (§7): the per-defect cap and the release-cycle
 * total. Both are checked in the caller's transaction, so exhausting either
 * rolls back the whole attempt including the job claim that prompted it.
 *
 * A Luna → Terra specialist escalation also spends this budget: it is still a
 * repair attempt against the same defect. Flip `countsAgainstTotal` if policy
 * should treat escalations as free.
 */
export async function spendRepairAttempt(
  store: StateStore,
  projectId: string,
  fingerprint: string,
  reviewCycle: number,
  session: ClientSession,
  options: { countsAgainstTotal?: boolean } = {},
): Promise<void> {
  const budget = await store.budgets.findOne({ _id: projectId }, { session });
  if (!budget) throw new Error(`No budget for project ${projectId}`);

  if (options.countsAgainstTotal ?? true) {
    await spend(store, projectId, 'totalRepairJobs', session);
  }

  const _id = defectBudgetId(projectId, fingerprint);
  const now = new Date();

  // Materialise the counter first so the guarded increment below is a plain
  // conditional update rather than an upsert racing a unique index.
  await store.defectBudgets.updateOne(
    { _id },
    {
      $setOnInsert: {
        projectId,
        fingerprint,
        repairsUsed: 0,
        firstSeenCycle: reviewCycle,
        updatedAt: now,
      },
    },
    { upsert: true, session },
  );

  // The limit is a literal read from the same snapshot, so no $expr is needed.
  const result = await store.defectBudgets.updateOne(
    { _id, repairsUsed: { $lt: budget.limits.repairsPerDefect } },
    { $inc: { repairsUsed: 1 }, $set: { updatedAt: now } },
    { session },
  );
  if (result.matchedCount === 0) throw new BudgetExhausted('repairsPerDefect');
}

export async function remaining(
  store: StateStore,
  projectId: string,
): Promise<Record<ProjectBudgetKey, number> | null> {
  const budget = await store.budgets.findOne({ _id: projectId });
  if (!budget) return null;
  const keys = Object.keys(budget.used) as ProjectBudgetKey[];
  return Object.fromEntries(keys.map((k) => [k, budget.limits[k] - budget.used[k]])) as Record<
    ProjectBudgetKey,
    number
  >;
}
