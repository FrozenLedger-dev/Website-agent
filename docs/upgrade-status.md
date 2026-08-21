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

CI runs two jobs, so the signals stay separable:

| Job | Runs | Needs |
|---|---|---|
| Typecheck, lint and unit tests | `pnpm test:unit` — 415 | nothing |
| Mongo integration tests | `pnpm test:integration` — 50 | the compose replica set |

Together they cover the whole inventory exactly once: 415 + 50 = 465, which is
what `pnpm test` runs. The integration job starts the same `docker-compose`
service developers use, waits for the healthcheck that initiates the replica
set, and proves the deployment accepts transactions before running anything —
the failure mode is otherwise silent, and a suite that quietly skipped would
look identical to one that passed.

Neither job holds a credential. No OpenAI key, no deployment token, no
`.env.local`.

## Phase 3 — Policy engine — **IN PROGRESS**

| Item | Status |
|---|---|
| End-to-end refusal regression test | Done — `refusal.integration.test.ts`, 13 tests |
| CI covers the Mongo-backed suites | Done — a second job, so nothing is outside CI |
| Extract scattered harness policy into a policy layer (3a) | Done — `packages/policy-engine` — both CI checks green on `70a86ba` |
| Harden the policy the extraction froze (3b) | Done — repair eligibility on both budgets, and the routing workstream set |

The regression test is the opening safety net. The last three defects in the
approval area were all in the *result* rather than the decision — zeroed
telemetry, a dropped terminal outcome, and a denied release reporting itself as
`accept_non_blocking` — and every one was found by reading code, because each
test checked a piece in isolation while nothing asserted the boundary the caller
sees.

It runs the real orchestrator against a real store with the model and the build
toolchain stubbed, and asserts the whole `RunResult`, the persisted project
state, the artifacts, and that nothing deployed. Verified by mutation:
reintroducing the `accept_non_blocking` mapping fails four of its assertions.

## Phase 3a — the policy engine

The deterministic rules were already written and already tested; they were just
spread across four orchestrator modules, mixed in with the code that spends
budgets, writes MongoDB and calls models. `packages/policy-engine` is that half
lifted out unchanged.

    @statxai/contracts  →  @statxai/policy-engine  →  @statxai/orchestrator

One direction, and the package in the middle depends on nothing else. It calls
no model, opens no database, reads no environment variable, touches no file and
deploys nothing — which is enforced rather than asserted: a test reads its
sources back and fails on `process.env`, `node:fs`, `fetch`, `MongoClient`,
`Date.now` or an import of anything but the contracts.

Because it never imports the layer it advises, a defect reaches it as
`{ id, severity }` and an authorisation hands back **ids**, which the
orchestrator resolves to its own richer objects. That is the seam that keeps the
dependency one-way.

### What moved

| Area | Now authoritative in policy-engine |
|---|---|
| Routing | `permittedStrategies`, `authorizeRoute` |
| Adjudication | `legalAdjudicationActions`, `authorizeAdjudication`, `fallbackAction`, `firstBlockerId` |
| Replanning | `scopeViolations`, `isEmptyDelta`, `authorizeReplanRevision` |
| Release | `authorizeRelease`, `verifyAcknowledged`, `terminalForRefusal`, `RELEASE_POLICY_VERSION` |
| Severity | `isReleaseBlocked`, `legalTerminalOutcomes`, `decideTerminal`, `humanReviewPermitted` |

`SEVERITY_POLICY` and `blocksRelease` stayed in the contracts, because
`ReviewOutcome` refines its own `blocking` field against them and contracts
cannot import the policy engine without a cycle. The policy engine re-exports
them rather than restating them, and a test compares the two so a second table
cannot appear without failing.

### That there is only one copy

The risk in an extraction is not a bad move — it is a partial one: a copy left
behind that still compiles, still passes its own tests, and disagrees with the
real implementation six months later. `policy-boundary.test.ts` reads the
orchestrator's sources back and fails if any of them redeclares a policy export
or reaches past the package boundary with a deep import. Verified by mutation:
adding a second `isEmptyDelta` to the orchestrator fails it by name.

### Residual policy audit

**A — extracted.** Everything in the table above.

**B — deliberately left behind**, because it is not policy or cannot be pure:

| Left in the orchestrator | Why |
|---|---|
| `developerOverride` | Reads `process.env`. The *override* is applied by policy; collecting it is not policy's job |
| `isTruncationFailure` | Inspects a thrown runtime error, not a decision |
| `planDelta` | Measurement over a `SitePlan`, fed *into* policy; needs deep artifact knowledge |
| `mergeByFingerprint`, `fromGateFinding`, `filesForDefect` | Build defects from gate output and the workspace file list |
| `executeRoute`, `seekRelease`, `revisePlan` | Orchestration and I/O around a policy call |

**C — real policy that is still implicit.** Named here, not fixed:

1. ~~**Per-fingerprint repair eligibility.**~~ Fixed in Phase 3b, below.
2. ~~**A decomposition that names only the homepage.**~~ Fixed in Phase 3b,
   below, and more broadly than first recorded.
3. `REPAIR_COMPANIONS` decides what a repair is always allowed to see. That is a
   permission, but it is tied to the Next.js workspace layout rather than to
   policy.
4. `decideTerminal`'s preference order is an `if` ladder rather than a declared
   ranking. Correct today, and pinned by a test asserting it only ever returns
   something the legal set contained.

## Phase 3b — per-fingerprint repair eligibility

The first behaviour change the extraction made cheap.

Two allowances govern a repair. `totalRepairJobs` is project-wide;
`repairsPerDefect` is charged against the defect's **fingerprint** and outlives
a cycle. Having the first does not imply having the second — but
`legalAdjudicationActions` only ever saw the first, so it offered `repair` from
a count of open blockers. Sol chose it, and `spendRepairAttempt` then refused
each target one at a time, inside the transaction, after the cycle had already
been committed to.

The cost was a whole extra cycle. On a defect that survives two repairs, the
run used to adjudicate a third, fail to charge for it, evaluate again, and only
then block — with its review-rejection allowance spent. Measured end to end:
**four adjudication cycles and three review rejections before; three and two
after.**

### What changed

`PolicyDefect` now carries its `fingerprint`, and `AdjudicationConstraints`
carries the per-defect limit plus what each fingerprint has already spent. The
orchestrator reads those counters — policy cannot open the collection itself —
and policy answers the question it was always being asked:

- `repairableDefects` names the blockers that can still be charged for;
- `repair` is offered only when at least one of them exists;
- an authorised repair is narrowed to the eligible targets, with the dropped
  ones recorded on the decision rather than discarded;
- the fallback repairs an *eligible* blocker, not merely the most severe — the
  same failure was reachable from the recovery path.

The persisted constraint snapshot keeps `blockingDefectIds` rather than the
defects themselves; they already live on the review outcome for the same cycle.
It keeps `repairsUsedByFingerprint` in full, because that is the evidence for
why an action was not offered.

### Both budgets, not one

The same gap existed on the *other* allowance. `spendRepairAttempt` charges one
`totalRepairJobs` unit **per target**, so a repair naming five defects needs
five units — but policy only checked that repair was affordable at all. With
three units left, all five were authorised: three executed, two were refused
inside the transaction, and the artifact recorded five targets the harness
already knew it could not charge for.

`repairCapacity` now caps the authorised set, trimming most-severe-first with
ids breaking ties, so the choice is reproducible and does not depend on the
order Sol listed them in. The dropped targets are recorded on the decision.
Measured end to end on five blocking defects against the default budget: cycle
one authorises five, cycle two authorises three rather than five.

The invariant this closes, on both budgets:

    authorised repair targets == targets the harness can charge for

The transaction remains authoritative, in case state drifted since the facts
were read.

### Sol is told which defects are repairable

Policy knew per-defect eligibility and the model did not. `sol-adjudicate`
received the whole open blocking list and was told to choose ids from it, so
Sol could name an exhausted defect in good faith and the harness would refuse it
and substitute a different one — the harness making the semantic choice Sol is
there to make.

The evidence now carries `repairEligibility` (attempts remaining per defect) and
`maxRepairTargets` (the smaller of the two allowances). Both are read-only
facts: there is no field through which Sol could change either. A test asserts
the facts agree with what authorisation actually does, so Sol is never reasoning
from a fiction.

### That the two agree

The failure was two components answering slightly different questions, so a
test now pins them to the same one: policy's eligibility rule is checked against
the exact predicate `spendRepairAttempt` guards with (`repairsUsed <
repairsPerDefect`), for every count around the limit. Mutation-verified in both
directions — restoring the old rule fails five policy tests and all three
end-to-end ones.

### The workstream set a decomposition must describe

The routing invariant recorded in the audit turned out to be wider than
"decompose while naming only the homepage". `executeDecomposed` builds the
anchor — layout plus the homepage — and then every *remaining* sitemap page, so
the workstream set has exactly one correct value: the sitemap minus `/`, each
route named once. Policy validated only unknown routes, which let four shapes
through:

| Shape | Was |
|---|---|
| a route the sitemap does not have | refused |
| `/`, which the anchor already builds | authorised |
| the same route twice | authorised |
| omitting a route the decomposition would build | authorised |

None broke a build, because execution reads the sitemap and ignores the
workstreams. What they broke was the record — the `route-decision` artifact kept
a plan the delivery did not follow, which is the evidence an audit trail exists
to preserve. `workstreamFaults` now checks the set exactly and reports every
fault rather than the first, so a refusal does not have to be fixed one shape at
a time.

Writing the tests first paid: the duplicate check was written as
`named.filter((r) => !seen.add(r))`, and `Set.add` returns the set rather than
whether it inserted, so that predicate was always false and the check never
fired.

### One duplicated rule removed

The release-refusal branch still assigned a terminal outcome with
`decideTerminal`, dead since the refusal path started exiting through
`terminalForRefusal`. Removed — it was a second copy of a rule the policy engine
owns, which is exactly what the boundary test exists to prevent.

## Phases 4–17

Not started.
