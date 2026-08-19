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

## Phase 1 — Decision contracts — **COMPLETE**

| Item | Status |
|---|---|
| `SolRouteDecision` | Done |
| `SolAdjudicationDecision` | Done |
| `SolReplanRequest` / `SolReplanResult` | Done |
| `SolApprovalRecommendation` | Done |
| Validate all outputs with Zod | Done |
| Reject malformed output before it reaches project state | Done — every contract has a runtime caller that validates before project state is touched |
| **Store every accepted decision as a versioned artifact** | Done — `route-decision`, `adjudication-decision`, `replan-decision`, `approval-recommendation` and `release-authorization` |

Every contract now has a runtime caller and a versioned artifact.

### Replan scope, settled during Phase 2c

The adjudication's scope reaches Sol, and the harness computes the delta the
revision actually made — routes added, removed and revised, whether the brand
system moved, whether the acceptance criteria changed. Overreach that is
objectively checkable is recorded on the artifact as `scopeViolations`.

Objectively detectable overreach is **enforced**: a `page` scope may not add or
remove routes, move the brand system, or rewrite the strategy or value
proposition; a `design` scope may move the brand but not the routes, strategy or
value proposition; `site` permits all of them. A revision that exceeds its scope
is not a narrow change that went slightly wide — it is a different decision from
the one adjudication authorised.

A revision whose measured delta is empty is refused too: Sol reporting changes
the plan does not contain would otherwise rebuild the site that just failed.

Both refusals persist the decision, including the violation, and then withhold
activation — the plan is not accepted, the site is not cleared, and Sol is not
called again. What stays **unenforced** is subjective overreach: whether a
page's copy changed more than it needed to is a judgement, and a wrong answer
would either block a good revision or wave through a bad one.

### Budget semantics settled during Phase 2b

- `reviewRejections` — how many rejected evaluations may trigger another
  corrective action. Repair and replan each spend one; `block` ends the run
  rather than answering it and spends none.
- `totalRepairJobs` — how much narrow repair was spent.
- `replans` — how many specification revisions were spent.

A fallback, taken when Sol cannot be consulted or its answer is refused, may
perform one narrow repair or block. It may never replan: replanning asserts the
specification is wrong, which is the judgement the harness failed to obtain.

## Phase 2 — Sol model skills — **COMPLETE**

| Skill | Status |
|---|---|
| `sol-route` | Done — Sol decides, the harness authorises, the decision is persisted |
| `sol-route` execution (2a.1) | Done — each strategy has its own call; nothing fabricates a truncation to steer control flow |
| `sol-adjudicate` | Done — the harness computes legal actions, Sol chooses, the harness authorises and executes |
| `sol-replan` | Done — revises the failed plan against the evidence; a failed call blocks rather than regenerating |
| `sol-approve` | Done — Sol recommends, the harness authorises separately, and the two are persisted apart |

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

### Release provenance, settled during Phase 2d

The manifest recorded `approvedBy: "sol:machine-approval"` for a decision no
model was consulted about — the harness checked that no blocking defect remained
and wrote Sol's name on its own arithmetic. That field is gone.

In its place, two: `recommendation` names Sol, its model and the artifact
version of its judgement; `authorization` names `harness-policy`, the policy
version and the action taken. Both authors are fixed by a literal in the schema,
so neither can be recorded as the other, and there is no field left in which a
model appears to have authorised or executed a release.

The harness checks deterministic facts — build, blocking defects, gates —
*before* reading the recommendation, so a model saying `accept` over a failing
gate never reaches the release path. A missing recommendation is not an
approval: full autonomy stops, and modes with a human defer to one.

### An acceptance must account for what is open

`acknowledgedIssues` is the stated basis on which a site ships with known
defects, so an `accept` that omits an open non-blocking issue is refused. The
first version detected ids Sol invented but not issues it simply left out, which
catches only the careless half: a recommendation silent about three open P2s
reads identically to one that never looked.

Invented ids are still recorded rather than refused — they are a data-quality
signal, not the basis of the decision — while omissions block.

### A deliberate semantic, flagged rather than settled

With no deployment target configured, `authorizeRelease` returns
`{authorized: true, action: 'release'}` and the project is marked `released`
against local preview. "Released" therefore currently means *machine-accepted
and authorised*, not *published to a host*.

That is the intended reading for now, and the tests require it. If it should
instead mean *published*, the change belongs in the policy-engine phase as a
deliberate decision, not as an incidental consequence of one of its refactors.

## Phases 3–17

Not started.
