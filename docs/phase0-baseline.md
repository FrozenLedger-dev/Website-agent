# Phase 0 quantitative baseline

Recorded against **commit `2aa95b5`** — "Audit the model/harness split, and give
Sol decision contracts" — the last commit before a model decision changed what
runs. Executed in a detached git worktree at that commit so the measurement is
of that code and not of the working tree.

Three representative profiles from `examples/`, chosen because each stresses a
different part of the loop: an electrician whose profile supports every claim
pattern at once, a restaurant whose profile supports its prices, and a dental
practice where the tempting copy is exactly what the profile does not support.

Screenshots and visual-quality figures remain **pending**: they need the browser
runtime from Phase 9, which does not exist yet. Everything else the checklist
asks for at Phase 0 is below.

## Results

| Fixture | Outcome | Quality | Review cycles | Repairs | Replans | Model calls | Tokens in | Tokens out | Runtime |
|---|---|---|---|---|---|---|---|---|---|
| electrician | blocked | 74 | 4 | 4 | 0 | 7 | 136,467 | 31,831 | 334.9s |
| restaurant | blocked | 68 | 4 | 6 | 2 | 13 | 216,894 | 60,906 | 595.8s |
| dental | released | 98 | 3 | 3 | 0 | 9 | 256,222 | 42,487 | 427.0s |

**One-shot success rate: 3/3.** Every run built the whole site in a single
Terra call; decomposition was never entered, so the baseline says nothing about
that path.

**Release rate: 1/3.** Both failures ended the same way — `rollback_to_last_accepted`
after the rejection budget was exhausted.

Totals: 29 model calls, 609,583 tokens in, 135,224 out, 1,357.7s.

## What the failures were

**electrician** — gates clean on every cycle. The reviewer rejected four times
(74 at the end), and three repair cycles ran without converging. The rejection
budget ran out.

**restaurant** — the only run to replan. Three cycles of repair, then
`3 blocking defects exceed the 1 repair jobs remaining — revising the
specification`, a full rebuild from a fresh plan, and the rejection budget gone
before the new build could be judged. That single arithmetic comparison cost a
complete rebuild and roughly half this run's 595.8s.

**dental** — released at 98 after three repair cycles.

## What this baseline is for

Two of the three runs were blocked by the semantic logic Phase 2b replaces:

- `mustFix.length > repairsLeft → replan` fired on restaurant purely on
  arithmetic, with no judgement about whether the defects were the plan's fault.
- `blocking defects → always Luna, all of them` sent every defect to narrow
  repair regardless of whether narrow repair could fix it.

The comparison to draw after Phase 2b is not "is the score higher" but whether
the same evidence produces a *better-argued* action: fewer wasted replans, and
repair scoped to defects that repair can actually clear.

## Rerunning the restaurant case after Phase 2b

This is the regression case worth watching. The old rule reached its decision as
`3 > 1`, with no reasoning about the defects themselves. What matters on a rerun
is not whether the score is higher but whether the same evidence produces a
better-argued action: did Sol avoid the rebuild, and did total calls and runtime
fall from 13 and 595.8s.

## Reproducing

```bash
git worktree add --detach /tmp/baseline 2aa95b5
cd /tmp/baseline && pnpm install --prefer-offline && cp /path/to/.env.local .
node --env-file=.env.local --import tsx scripts/run-agent.ts examples/electrician.json
```

The worktree shares the same MongoDB, so baseline runs appear in the console
alongside current ones and are distinguished only by their project id.
