# Upgrade checklist — actual status

Tracks the checklist in `Website Agent — Detailed Model + Harness Upgrade
Checklist.md` against what is really in the repository. Kept honest
deliberately: an item is only ticked when the behaviour exists at runtime, not
when the type exists.

## Phase 0 — Freeze and document the current MVP — **PARTIAL**

| Item | Status |
|---|---|
| Responsibility map (`docs/runtime-responsibility-map.md`) | Done |
| Document decisions inside `orchestrator.ts` | Done |
| Classify each as HARNESS/SOL/TERRA/LUNA | Done |
| Mark mismatches with the approved architecture | Done |
| Three-project quantitative baseline | Done — `docs/phase0-baseline.md`, measured against `2aa95b5` in a detached worktree |
| One-shot success rate | Done — 3/3 |
| Model calls per project | Done — 7, 13, 9 |
| Token usage | Done — 609,583 in / 135,224 out across the three |
| Runtime | Done — 334.9s, 595.8s, 427.0s |
| Repairs, replans and outcomes | Done — 4/0/blocked, 6/2/blocked, 3/0/released |
| Screenshots of the generated sites | **Pending Phase 9** — needs the browser runtime |
| Visual-quality baseline | **Pending Phase 9** — same |
| Branch `architecture/model-harness-v2` | **Not done, and deliberately so.** The work is several commits into `main` and reviewed there; opening a branch now would satisfy the checklist's wording while making the history harder to follow, not easier. |

Phase 0 stays open only on the two items that need a browser.

## Phase 1 — Decision contracts — **PARTIAL**

| Item | Status |
|---|---|
| `SolRouteDecision` | Done |
| `SolAdjudicationDecision` | Done |
| `SolReplanRequest` / `SolReplanResult` | Done |
| `SolApprovalRecommendation` | Done |
| Validate all outputs with Zod | Done |
| Reject malformed output before it reaches project state | Partial — `sol-route` and `sol-adjudicate` use them; replan and approval have no caller |
| **Store every accepted decision as a versioned artifact** | Partial — `route-decision` and `adjudication-decision` are persisted; replan and approval are not, because those skills do not exist yet |

The contracts are declared and tested. Persistence arrives with each skill that
produces a decision, so this closes when Phase 2 does.

### Budget semantics settled during Phase 2b

- `reviewRejections` — how many rejected evaluations may trigger another
  corrective action. Repair and replan each spend one; `block` ends the run
  rather than answering it and spends none.
- `totalRepairJobs` — how much narrow repair was spent.
- `replans` — how many specification revisions were spent.

A fallback, taken when Sol cannot be consulted or its answer is refused, may
perform one narrow repair or block. It may never replan: replanning asserts the
specification is wrong, which is the judgement the harness failed to obtain.

## Phase 2 — Sol model skills — **IN PROGRESS**

| Skill | Status |
|---|---|
| `sol-route` | Done — Sol decides, the harness authorises, the decision is persisted |
| `sol-route` execution (2a.1) | Done — each strategy has its own call; nothing fabricates a truncation to steer control flow |
| `sol-adjudicate` | Done — the harness computes legal actions, Sol chooses, the harness authorises and executes |
| `sol-replan` | Not started |
| `sol-approve` | Not started |

## Continuous integration

`.github/workflows/ci.yml` runs typecheck, lint and `pnpm test:unit` on every
push and pull request. It provisions nothing and holds no credentials.

**Known gap.** Three suites — `packages/state/test/budgets.test.ts`,
`packages/job-engine/test/engine.test.ts` and
`packages/workspace/test/workspace.test.ts`, 32 tests — connect to a real Mongo
replica set and are not covered by CI. They are integration tests by intent: the
properties they pin are transaction semantics, and mocking the driver would
assert only that the code calls the functions it calls. Among them is the guard
on the `$expr` budget filter, which is the single most important invariant in
the repository, so a green tick does **not** mean that invariant was checked.

Closing it means giving CI a Mongo service container initialised as a
single-node replica set. That is a deliberate later decision, not an oversight.

## Phases 3–17

Not started.
