# Upgrade checklist — actual status

Tracks the checklist in `Website Agent — Detailed Model + Harness Upgrade
Checklist.md` against what is really in the repository. Kept honest
deliberately: an item is only ticked when the behaviour exists at runtime, not
when the type exists.

## Phase 0 — Freeze and document the current MVP — **PARTIAL**

| Item | Status |
|---|---|
| Branch `architecture/model-harness-v2` | **Not done** — work is on `main` |
| Run the MVP against 3+ representative profiles | Done — 8 fixtures in `examples/`, 9 deliveries |
| Save source, build output, validation report, review, final state per run | **Not done** — data is in Mongo and workspaces, never collected into a baseline |
| Record one-shot success rate | **Not done** as a recorded figure |
| Record Terra calls per project | **Not done** — per-tier usage is now captured, but no baseline was written |
| Record Luna calls per project | **Not done** — same |
| Record whether replanning occurred | **Not done** — visible in run events, never tabulated |
| Record total generation time | Partial — per run, not aggregated |
| Record total tokens/cost | Partial — per run and per tier, not aggregated |
| Screenshots of current sites | **Not done** — no browser runtime exists (Phase 9) |
| `docs/runtime-responsibility-map.md` | Done |
| Document decisions inside `orchestrator.ts` | Done |
| Classify each as HARNESS/SOL/TERRA/LUNA | Done |
| Mark mismatches with the approved architecture | Done |

**Phase 0 is not closed.** The responsibility map — the part later phases depend
on — is written. The quantitative baseline is not, and without it there is
nothing to compare the refactor against. It needs a browser runtime for the
screenshot rows, so it cannot fully close before Phase 9.

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

## Phase 2 — Sol model skills — **IN PROGRESS**

| Skill | Status |
|---|---|
| `sol-route` | Done — Sol decides, the harness authorises, the decision is persisted |
| `sol-route` execution (2a.1) | Done — each strategy has its own call; nothing fabricates a truncation to steer control flow |
| `sol-adjudicate` | Done — the harness computes legal actions, Sol chooses, the harness authorises and executes |
| `sol-replan` | Not started |
| `sol-approve` | Not started |

## Phases 3–17

Not started.
