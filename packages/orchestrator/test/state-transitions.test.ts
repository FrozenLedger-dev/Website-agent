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
      building: 1,
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
    expect(writes['building']).toEqual(['build.ts']);
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
