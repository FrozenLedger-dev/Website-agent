/**
 * Where the project state is written, and how often.
 *
 * The phase extraction lifted the `validating` transition into `evaluateSite`
 * and left a copy of it in the loop that calls it, so every evaluation cycle
 * performed two writes and two `updatedAt` bumps instead of one. The final
 * state was identical, which is exactly why the parity suite — which asserts
 * outcomes — could not see it.
 *
 * A duplicate transition is not a cosmetic problem. It doubles the writes on
 * the hottest path in a run, and it makes anything watching the state (a change
 * stream, an operator refreshing the console) see a transition that did not
 * happen. So the transition surface is pinned here as a count: every state, and
 * every place it is written from. Adding or moving one has to be deliberate.
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const stateWrites = async (): Promise<Record<string, string[]>> => {
  const dirs = [SRC, join(SRC, 'phases')];
  const found: Record<string, string[]> = {};

  for (const dir of dirs) {
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.ts'))) {
      const code = await readFile(join(dir, name), 'utf8');
      for (const match of code.matchAll(/state: '([a-z_]+)'/g)) {
        (found[match[1]!] ??= []).push(name);
      }
    }
  }
  return found;
};

describe('the project state transition surface', () => {
  it('writes each state from exactly the places it should', async () => {
    const writes = await stateWrites();
    const counts = Object.fromEntries(
      Object.entries(writes).map(([state, files]) => [state, files.length]),
    );

    expect(counts).toEqual({
      planning: 1,
      // Two, and they are mutually exclusive by construction (Phase 5j):
      // `orchestrator.ts` writes it only on the `job_lifecycle` branch of the
      // frontend_backend build boundary, `build.ts` only on the
      // `legacy_direct` branch — exactly one of the two ever runs for a
      // given build, the same "mutually exclusive" shape `blocked` below
      // already has.
      building: 2,
      validating: 1,
      releasing: 1,
      released: 1,
      awaiting_human_review: 1,
      // Two, and they are mutually exclusive terminal exits: the still-blocked
      // return happens before the release refusal is reachable, and the refusal
      // writes `blocked` only in the branch where it did not route to a person.
      blocked: 2,
    });
  });

  it('lets the phase that does the work own the transition into it', async () => {
    // The regression: the loop announced `validating` and then `evaluateSite`
    // announced it again. One owner per transition, so there is one write.
    const writes = await stateWrites();

    expect(writes['validating']).toEqual(['evaluate.ts']);
    // `.sort()`: which of the two mutually-exclusive owners `readdir` visits
    // first is not a claim this test makes.
    expect(writes['building']?.slice().sort()).toEqual(['build.ts', 'orchestrator.ts']);
    expect(writes['releasing']).toEqual(['publish.ts']);
    expect(writes['released']).toEqual(['publish.ts']);
  });

  it('invents no state the contract does not describe', async () => {
    // Phase 4a is an extraction; a new state would be a behaviour change.
    const writes = await stateWrites();
    expect(Object.keys(writes).sort()).toEqual([
      'awaiting_human_review',
      'blocked',
      'building',
      'planning',
      'released',
      'releasing',
      'validating',
    ]);
  });
});

/**
 * One mutable owner per run-progress fact.
 *
 * The refactor these guard against is the one that was there before: eighteen
 * parallel `let`s plus a `snapshot()` that rebuilt an object from them. Two
 * writable representations of the same fact drift, and the drift is silent —
 * the loop updates one, a phase reads the other.
 */
describe('the run has one owner for its progress', () => {
  const runProject = async () => {
    const code = await readFile(join(SRC, 'orchestrator.ts'), 'utf8');
    const start = code.indexOf('export async function runProject');
    return code.slice(start).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  };

  /** Every field the owner holds, read from the factory rather than listed. */
  const fields = async () => {
    const { createRunProgress } = await import('../src/run-context.js');
    return Object.keys(createRunProgress());
  };

  it('declares no mutable local beside the owner', async () => {
    const body = await runProject();

    for (const field of await fields()) {
      const parallel = new RegExp(`\\blet ${field}\\b`);
      expect(parallel.test(body), `runProject declares a second owner for ${field}`).toBe(false);
    }
  });

  it('creates the owner exactly once', async () => {
    const body = await runProject();
    expect(body.match(/createRunProgress\(\)/g) ?? []).toHaveLength(1);
  });

  it('hands phases a snapshot, never the owner itself', async () => {
    const body = await runProject();

    expect(body).toContain('progress: snapshotProgress(progress)');
    // `progress` reaching a phase directly would put the owner behind a
    // readonly type without detaching it, which is the worst of both.
    expect(body).not.toMatch(/progress:\s*progress\b/);
  });

  it('lets phases keep their own immutable locals', async () => {
    // The rule is one *mutable* owner per fact, not a ban on named values.
    // Destructured since Phase 5j threaded `sitePlanRef` alongside the plan
    // itself — `initialPlan` is still one immutable local, just no longer
    // the plain return value.
    const body = await runProject();
    expect(body).toContain('const { plan: initialPlan, sitePlanRef: initialSitePlanRef } = await producePlan');
  });
});
