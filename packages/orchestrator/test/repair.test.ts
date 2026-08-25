/**
 * Executing an authorised repair.
 *
 * The phase is where a model's output becomes a change on disk, so the
 * properties worth pinning are the ones that keep that narrow: the budget is
 * charged once per defect and inside a transaction, Luna is only asked about
 * files the harness chose, and only files the harness gave it may come back.
 *
 * These are unit tests with real scoping and a fake workspace, which the
 * extraction made possible — the phase takes its collaborators explicitly, so
 * they can be handed to it. The Mongo-backed end-to-end repair coverage in
 * `refusal.integration.test.ts` stays: it proves the loop reaches this code and
 * spends real budgets, which a fake cannot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as State from '@statxai/state';
import type * as Agents from '@statxai/agents';
import type { Defect } from '../src/defects.js';
import type { RunContext } from '../src/run-context.js';

/** Files Luna is asked to repair, in call order, with the context it was given. */
const lunaCalls: { defectId: string; contextPaths: string[] }[] = [];
/**
 * What Luna returns next. A queue, so a single call can be made to fail.
 *
 * `'echo'` means "repair the file you were asked about", which is what a
 * working call does. Tests that care about scope enforcement name paths
 * explicitly instead.
 */
type LunaReply = 'echo' | { files: { path: string; contents: string }[] } | Error;
let lunaReplies: LunaReply[];
/** Fingerprints whose spend the transaction refuses. */
let exhaustedFingerprints: string[];
const spends: string[] = [];
/** Whether each spend happened inside `withTransaction`, in call order. */
const spendsInTransaction: boolean[] = [];
let insideTransaction = false;
const written: { path: string; contents: string }[] = [];
const commits: string[] = [];

vi.mock('@statxai/state', async (importOriginal) => {
  const actual = await importOriginal<typeof State>();
  return {
    ...actual,
    spendRepairAttempt: vi.fn(async (_store, _projectId, fingerprint: string) => {
      spends.push(fingerprint);
      spendsInTransaction.push(insideTransaction);
      if (exhaustedFingerprints.includes(fingerprint)) {
        throw new actual.BudgetExhausted('repairsPerDefect');
      }
    }),
  };
});

vi.mock('@statxai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>();
  return {
    ...actual,
    ModelClient: class {},
    repairDefect: vi.fn(
      async (
        _client: unknown,
        _profile: unknown,
        defect: { id: string },
        context: { path: string }[],
      ) => {
        lunaCalls.push({ defectId: defect.id, contextPaths: context.map((f) => f.path) });
        const reply = lunaReplies.length > 1 ? lunaReplies.shift()! : lunaReplies[0]!;
        if (reply instanceof Error) throw reply;
        const files =
          reply === 'echo'
            ? [{ path: context[0]!.path, contents: 'repaired' }]
            : reply.files;
        return { value: { files, notes: '' }, model: 'gpt-5.6-luna', inputTokens: 1, outputTokens: 1, ms: 1 };
      },
    ),
  };
});

const SOURCES = [
  { path: 'app/page.tsx', contents: 'home' },
  { path: 'app/about/page.tsx', contents: 'about' },
  { path: 'app/layout.tsx', contents: 'layout' },
  { path: 'app/globals.css', contents: 'css' },
];

const defect = (over: Partial<Defect> = {}): Defect =>
  ({
    id: 'QA-001',
    category: 'business_accuracy',
    severity: 'P1',
    location: 'app/page.tsx',
    reason: 'States a guarantee the profile does not support.',
    acceptanceTest: 'No unsupported guarantee remains.',
    fingerprint: 'fp:QA-001',
    ...over,
  }) as Defect;

const context = (): RunContext =>
  ({
    deps: {
      store: {
        withTransaction: async (fn: (s: unknown) => Promise<void>) => {
          insideTransaction = true;
          try {
            return await fn({});
          } finally {
            insideTransaction = false;
          }
        },
      },
      registry: {},
      workspace: {
        writeSiteFiles: async (files: { path: string; contents: string }[]) => {
          written.push(...files);
        },
        commit: async (message: string) => {
          commits.push(message);
          return 'abc1234';
        },
      },
      model: {},
      say: () => {},
      track: () => {},
    },
    facts: { projectId: 'proj_test', profile: {}, autonomyMode: 'full_autonomous', budgetLimits: {} },
    progress: { reviewCycle: 2 },
  }) as unknown as RunContext;

const run = async (targets: Defect[]) => {
  const { executeRepairs } = await import('../src/phases/repair.js');
  return executeRepairs(context(), {
    targets,
    sources: SOURCES,
    sourceOf: { 'index.html': 'app/page.tsx', 'about.html': 'app/about/page.tsx' },
  });
};

beforeEach(() => {
  lunaCalls.length = 0;
  spends.length = 0;
  spendsInTransaction.length = 0;
  insideTransaction = false;
  written.length = 0;
  commits.length = 0;
  exhaustedFingerprints = [];
  lunaReplies = ['echo'];
});

describe('the repair budget', () => {
  it('spends once per defect, before Luna is asked', async () => {
    await run([defect()]);

    expect(spends).toEqual(['fp:QA-001']);
    expect(lunaCalls).toHaveLength(1);
  });

  it('spends inside a transaction, not merely before the call', async () => {
    // Asserting the order alone left the wrapper untested: dropping
    // `withTransaction` while keeping the spend would have passed. The
    // transaction is the authority — a spend outside one can be observed
    // half-applied, and the guarded per-fingerprint increment stops being
    // atomic with the project-wide one.
    await run([defect(), defect({ id: 'QA-002', fingerprint: 'fp:QA-002' })]);

    expect(spendsInTransaction).toEqual([true, true]);
  });

  it('spends once for a defect that spans several files', async () => {
    // The unit of budget is the defect, not the file and not the model call: a
    // claim repeated across three pages is still one defect.
    lunaReplies = [{ files: [] }];
    await run([defect({ reason: 'The claim also appears on about.html.' })]);

    expect(spends).toEqual(['fp:QA-001']);
    expect(lunaCalls.length).toBeGreaterThan(1);
  });

  it('does not ask Luna about a defect whose spend was refused', async () => {
    exhaustedFingerprints = ['fp:QA-001'];
    const outcome = await run([defect()]);

    expect(spends).toEqual(['fp:QA-001']);
    expect(lunaCalls).toEqual([]);
    expect(outcome.exhausted).toBe(true);
    expect(outcome.repairsAppliedDelta).toBe(0);
    // Nothing was attempted, so nothing is queued for re-verification and no
    // history entry claims an attempt happened.
    expect(outcome.repairedSinceReview).toEqual([]);
    expect(outcome.repairHistoryEntries).toEqual([]);
  });

  it('carries on with the other authorised targets', async () => {
    exhaustedFingerprints = ['fp:QA-001'];
    const outcome = await run([
      defect(),
      defect({ id: 'QA-002', fingerprint: 'fp:QA-002', location: 'app/about/page.tsx' }),
    ]);

    expect(spends).toEqual(['fp:QA-001', 'fp:QA-002']);
    expect(lunaCalls.map((c) => c.defectId)).toEqual(['QA-002']);
    expect(outcome.exhausted).toBe(true);
    expect(outcome.repairsAppliedDelta).toBe(1);
  });
});

describe('what Luna is allowed to see and to change', () => {
  it('is asked about one file at a time, with the companions as context', async () => {
    await run([defect()]);

    expect(lunaCalls).toHaveLength(1);
    expect(lunaCalls[0]?.contextPaths).toEqual([
      'app/page.tsx',
      'app/layout.tsx',
      'app/globals.css',
    ]);
  });

  it('makes one call per file rather than one call for the whole scope', async () => {
    // A defect can legitimately span pages, but one call returning four whole
    // pages exceeds the output ceiling and truncates, failing the repair
    // wholesale.
    lunaReplies = [{ files: [] }];
    await run([defect({ reason: 'The same claim appears on about.html too.' })]);

    // Scope order follows `filesForDefect`, which resolves exported paths named
    // in the reason before source paths named in the location.
    expect(lunaCalls.map((c) => c.contextPaths[0])).toEqual([
      'app/about/page.tsx',
      'app/page.tsx',
    ]);
  });

  it('refuses a returned file that was not in the context it was given', async () => {
    // The invariant the tool gateway will later generalise: what Luna may write
    // is its output intersected with the paths the harness handed it. Enforced
    // here, not asked for in a prompt.
    lunaReplies = [
      {
        files: [
          { path: 'app/page.tsx', contents: 'repaired' },
          { path: 'app/about/page.tsx', contents: 'not in context' },
          { path: '../../etc/passwd', contents: 'nope' },
        ],
      },
    ];
    const outcome = await run([defect()]);

    expect(written.map((f) => f.path)).toEqual(['app/page.tsx']);
    expect(outcome.repairHistoryEntries[0]?.outcome).toContain('2 refused');
  });

  it('writes nothing at all when every returned path is out of scope', async () => {
    lunaReplies = [{ files: [{ path: 'app/about/page.tsx', contents: 'wrong file' }] }];
    const outcome = await run([defect()]);

    expect(written).toEqual([]);
    expect(outcome.repairsAppliedDelta).toBe(0);
  });
});

describe('counting a repair', () => {
  it('counts the defect once however many files it wrote', async () => {
    // `repairsApplied` means defects repaired, not files written or calls made.
    lunaReplies = ['echo'];
    const outcome = await run([defect({ reason: 'Also on about.html.' })]);

    expect(written.map((f) => f.path)).toEqual(['app/about/page.tsx', 'app/page.tsx']);
    expect(outcome.repairsAppliedDelta).toBe(1);
  });

  it('counts each repaired defect separately', async () => {
    lunaReplies = ['echo'];
    const outcome = await run([
      defect(),
      defect({ id: 'QA-002', fingerprint: 'fp:QA-002', location: 'app/about/page.tsx' }),
    ]);

    expect(outcome.repairsAppliedDelta).toBe(2);
  });
});

describe('when a repair call fails', () => {
  it('does not abort the phase, and keeps going', async () => {
    lunaReplies = [new Error('upstream timeout'), 'echo'];
    const outcome = await run([
      defect(),
      defect({ id: 'QA-002', fingerprint: 'fp:QA-002', location: 'app/about/page.tsx' }),
    ]);

    expect(lunaCalls.map((c) => c.defectId)).toEqual(['QA-001', 'QA-002']);
    expect(outcome.repairsAppliedDelta).toBe(1);
  });

  it('records the failure rather than reducing it to a boolean', async () => {
    // The history is evidence for the next adjudication: a defect narrow repair
    // has already failed on reads differently from a first attempt.
    lunaReplies = [new Error('upstream timeout')];
    const outcome = await run([defect()]);

    expect(outcome.repairHistoryEntries).toEqual([
      { defectId: 'QA-001', fingerprint: 'fp:QA-001', outcome: 'failed (1 file(s))' },
    ]);
    expect(outcome.repairsAppliedDelta).toBe(0);
  });

  it('still queues the defect for re-verification, because it was attempted', async () => {
    lunaReplies = [new Error('upstream timeout')];
    const outcome = await run([defect()]);

    expect(outcome.repairedSinceReview).toEqual([
      {
        id: 'QA-001',
        reason: 'States a guarantee the profile does not support.',
        acceptanceTest: 'No unsupported guarantee remains.',
      },
    ]);
  });
});

describe('the repair cycle commit', () => {
  it('commits once for the cycle, naming it', async () => {
    await run([defect(), defect({ id: 'QA-002', fingerprint: 'fp:QA-002' })]);
    expect(commits).toEqual(['Luna: repair cycle 2']);
  });

  it('commits even when nothing was written', async () => {
    // Current behaviour, pinned rather than endorsed: the commit is attempted
    // unconditionally and the workspace decides whether there is anything to
    // record.
    exhaustedFingerprints = ['fp:QA-001'];
    await run([defect()]);
    expect(commits).toEqual(['Luna: repair cycle 2']);
  });
});

describe('what the phase does not do', () => {
  it('returns deltas rather than touching what it was handed', async () => {
    const targets = [defect()];
    const sources = [...SOURCES];
    const outcome = await run(targets);

    expect(targets).toHaveLength(1);
    expect(sources).toEqual(SOURCES);
    expect(outcome.repairsAppliedDelta).toBe(1);
  });

  it('decides no terminal outcome, only reports exhaustion', async () => {
    // Whether an exhausted repair ends the run is the loop's question, asked
    // through `decideTerminal`. This phase has no opinion.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = dirname(fileURLToPath(import.meta.url)).replace(/test$/, 'src');
    const code = await readFile(join(src, 'phases/repair.ts'), 'utf8');

    expect(code).not.toContain('decideTerminal');
    expect(code).not.toContain('authorizeAdjudication');
    expect(code).not.toContain('legalAdjudicationActions');
  });
});
