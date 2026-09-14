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
| Typecheck, lint and unit tests | `pnpm test:unit` — 458 | nothing |
| Mongo integration tests | `pnpm test:integration` — 96 | the compose replica set |

Together they cover the whole inventory exactly once: 458 + 96 = 554, which is
what `pnpm test` runs. The integration job starts the same `docker-compose`
service developers use, waits for the healthcheck that initiates the replica
set, and proves the deployment accepts transactions before running anything —
the failure mode is otherwise silent, and a suite that quietly skipped would
look identical to one that passed.

Neither job holds a credential. No OpenAI key, no deployment token, no
`.env.local`.

## Phase 3 — Policy engine — **COMPLETE**

| Item | Status |
|---|---|
| End-to-end refusal regression test | Done — `refusal.integration.test.ts`, 13 tests |
| CI covers the Mongo-backed suites | Done — a second job, so nothing is outside CI |
| Extract scattered harness policy into a policy layer (3a) | Done — `packages/policy-engine` |
| Harden the policy the extraction froze (3b) | Done — repair eligibility on both budgets, and the routing workstream set |
| Adjudication artifacts replay through the policy engine | Done — the snapshot carries every input a rule reads |

Phase 3 lineage, oldest first — each commit one capability, each green in CI:

| SHA | What it closed |
|---|---|
| `af17db5` | Extracted the deterministic policy into `@statxai/policy-engine` |
| `9f0bec4` | Recorded the routing invariant the comment claimed and the code did not |
| `fa2adf4` | Repair offered only for a defect whose own allowance can pay |
| `4e63e1a` | Repair capped by the project allowance too, and Sol told which defects are eligible |
| `b7fa05f` | A decomposition must describe the work it would actually do |
| `1a68619` | Adjudication artifacts carry enough to replay the decision |

**Head: `1a68619`.** Both GitHub checks green — "Typecheck, lint and unit
tests" and "Mongo integration tests". Phase 3 closes there.

Two items stay open by decision rather than by oversight:

- **`REPAIR_COMPANIONS`** decides what files a repair is always allowed to see.
  That is a permission, and it belongs with the tool gateway rather than with
  policy — deferred to the permission/tool-gateway phase, not to Phase 4.
- **`decideTerminal`'s preference order** is an `if` ladder rather than a
  declared ranking. Non-blocking technical debt: it is correct today, and a test
  pins it to only ever returning an outcome the legal set contained.

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

### An artifact that explains its own decision

The persisted snapshot first kept only the defect ids, on the reasoning that the
defects in full already lived on the review outcome. That was wrong.
`test-report` holds the raw gate findings and `visual-review` the raw reviewer
value; the *merged* defect — the one policy sees, carrying the fingerprint the
repair budget is charged against — is produced by `mergeByFingerprint` and
existed only in memory. So an adjudication artifact could not explain why one
target was kept and another trimmed without recomputing the merge from two other
artifacts.

It now carries the minimal policy input per blocking defect: id, severity and
fingerprint. The verbose fields stay out — they really are on the review
outcome, and no policy rule reads them.

Nothing derived is stored. `repairEligibility` and `maxRepairTargets` are
functions of the recorded fields, so a copy could only ever disagree with them.
Instead, an integration test replays every persisted decision back through the
policy engine and asserts it reproduces the recorded `legalActions`, action,
source, targets and refusal — which proves the snapshot is sufficient rather
than asserting it.

Two scenarios, because the two new fields bind in different places: severity
decides a capacity trim, fingerprint decides per-defect exhaustion. Verified by
dropping each independently — severity alone fails the trim replay, fingerprint
alone fails the exhaustion replay.

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

## Phase 4a — orchestrator phase extraction — **COMPLETE**

Both GitHub checks green on `647abed`.

An extraction. No intentional behaviour change: no model, policy, budget,
artifact, state, release, routing, repair, replan or deployment semantics move.

### Before

`runProject` was one function of **1,438 lines** doing everything: intake
validation, workspace setup, planning, routing, building, compiling, gating,
reviewing, adjudicating, repairing, replanning, approving, authorising,
deploying and reporting. Twelve helpers were declared inside it, all closing
over the same twenty-odd mutable locals — so a phase's inputs were whatever
happened to be in scope, and nothing could be read or tested on its own.

### After

`runProject` is **530 lines** and `orchestrator.ts` is **610**, down from 1,582.
What remains is workflow control: set up telemetry, validate intake, create the
project, plan, build, then the convergence loop, then finalise.

    orchestrator.ts   1,582 → 610
    runProject        1,438 → 530

The loop is deliberately still a loop, written out rather than hidden behind a
framework:

    evaluate
        ↓
    nothing blocking? ──yes──→ seek release ──→ break
        ↓ no
    adjudicate
        ↓
    block → break   replan → revise, rebuild, continue   repair → apply, continue

### The phases

| Module | Owns |
|---|---|
| `phases/planning.ts` | `producePlan`, `persistPlan`, `revisePlan` |
| `phases/build.ts` | route decision, one-shot and decomposed execution, scaffold |
| `phases/evaluate.ts` | compile, gates, review, defect merge, `test-report`, `visual-review` |
| `phases/adjudicate.ts` | constraints, legal actions, Sol, authorisation, `adjudication-decision` |
| `phases/release.ts` | recommendation, acknowledgement check, authorisation, both artifacts |
| `phases/publish.ts` | release commit, deploy with retry, `deployment-manifest` |
| `phases/conclude.ts` | the two exits, kept apart on purpose |

### The context

`run-context.ts` splits what a phase is handed three ways, because "an input"
and "a result" should not be two fields in one bag:

- **`RunDeps`** — collaborators, fixed for the run.
- **`RunFacts`** — the canonical inputs. Nothing may revise these, the same
  guarantee the decision contracts give.
- **`RunProgress`** — what the run has done so far.

`FixedContext` is `deps` + `facts`, for the phases that reason about no
progress at all — planning and building take it, which is both a smaller
surface and the reason they can run before any progress exists.

`snapshot()` assembles the progress a phase may read at the moment it is called,
as a **copy**: a phase reports what it found and the caller decides what to
remember. `seekRelease` returning its approval provenance rather than assigning
it is the clearest example.

**No budget is cached.** `RunFacts.budgetLimits` is the ceiling and never the
usage; what has been spent is read from the store when a decision needs it and
spent inside a transaction in `@statxai/state`. A snapshot is evidence for a
decision, never permission to skip the spend.

### Two discriminated results

Only where they made control flow clearer, per the brief:

- `EvaluationOutcome` is `evaluated | review_unavailable`. The review failure
  used to `break` out of a loop belonging to someone else; it is now a value the
  caller reads.
- `AdjudicationOutcome` carries the authorisation, Sol's proposal, the
  constraints and the legal set — the phase decides and records, and the loop
  spends the budgets and runs the action.

### What did not move

Authority. Policy still receives facts and returns decisions, and gained no
persistence, model call, workspace access, environment read, timestamp or
deployment call — `policy-boundary.test.ts` still enforces that. Budget spending
stays transactional in `@statxai/state`. The model skills stay model skills:
Sol plans, routes, adjudicates, replans and recommends; Terra builds and
reviews; Luna repairs.

### Parity

`refusal.integration.test.ts` is unchanged and green. `delivery.parity.
integration.test.ts` was added *first*, characterising the released path — which
had no end-to-end assertion at all — plus artifact lineage, phase order, budget
usage, the replan path and the undeployed-but-released case.

Fifteen source-reading tests moved with their subject: they pin ordering and
reachability by scanning source, so an extraction relocates what they read
without changing what they assert.

### One parity regression, found in review

The extraction lifted the `validating` transition into `evaluateSite` **and**
left a copy in the loop that calls it, so every evaluation cycle performed two
writes and two `updatedAt` bumps instead of one. The final state was identical,
which is exactly why a suite that asserts outcomes could not see it.

Fixed by letting the phase that does the work own the transition into it.
`state-transitions.test.ts` now pins the whole surface as a count — every state
and every file it is written from — so a duplicate fails by name. `blocked` is
the one state written twice, from two mutually exclusive terminal exits, and the
test says so rather than leaving the number unexplained.

### Deferred

- **Repair execution** — done in Phase 4b, below.
- **Intake and project setup** (~45 lines) is still inline. Cohesive enough to
  extract, small enough not to be urgent.
- ~~`runProject` declares the run's mutable state as locals with a `snapshot()`
  view rather than owning a `RunProgress` object.~~ Closed in 4c: one
  `MutableRunProgress` owner, `snapshotProgress()`, and a detached phase view.
- ~~**`snapshot()` is shallow.**~~ Closed in 4c: the view is a deep clone, and
  the phase-facing type is readonly for the fields and collections it holds
  directly — not recursively deep-readonly, which 4c.1 corrected. The
  `structuredClone` is what provides the runtime isolation.
- ~~**Artifact lineage is ordered by `createdAt` alone.**~~ Closed in 4d: every
  artifact carries a per-project lineage number allocated atomically by the
  store.

Phase 4 is **not** complete. Phase 5 — mapping these boundaries onto the job
engine — is not started, deliberately: the job engine keeps its own enqueue,
claim, transition, retry, lease and conflict handling, and nothing in Phase 4a
routes a run through it.

## Phase 4b — repair execution — **DONE**

The last substantial block of execution detail left in the delivery loop.

### Where it lived

Inline in the `repair` branch of `runProject`: about 105 lines spending the
per-defect budget in a transaction, scoping source files, adding the repair
companions, splitting a multi-file defect into one Luna call per file, filtering
what came back, writing it, tolerating individual failures, and recording the
evidence — followed by the cycle commit.

`orchestrator.ts` is now **508 lines**, from 610 after 4a and 1,582 before it.
The branch reads:

    resolve authorised targets
    → executeRepairs(...)
    → apply the returned deltas
    → the existing exhaustion rule
    → continue

### The boundary

    executeRepairs(ctx, { targets, sources, sourceOf }) → {
      repairsAppliedDelta,
      exhausted,
      repairedSinceReview,
      repairHistoryEntries,
    }

Inputs are `readonly`; the phase appends to nothing it was handed. It returns
**deltas** and the loop applies them, which makes "the phase reports, the caller
remembers" real for the first time rather than a convention. This is deliberately
scoped to the new boundary: the global `snapshot()` shallowness is still open.

### Who has which authority

    Sol adjudicates → policy authorises ids → the loop resolves them to defects
    → the phase spends the budget transactionally → Luna proposes file contents
    → the harness filters what may land → the next evaluation judges it

The phase is an **execution** phase. It does not read Sol's proposal, recompute
legal actions, call `authorizeAdjudication`, widen the target set, or substitute
a different defect for one it cannot afford — a test reads its source back and
fails if `decideTerminal`, `authorizeAdjudication` or `legalAdjudicationActions`
ever appear in it.

**Budget.** `store.withTransaction(spendRepairAttempt(...))` stays exactly where
it was, charged **once per defect** — not per file, not per model call. A defect
spanning three pages still costs one attempt. Policy eligibility remains
pre-authorisation evidence; the transaction is the authority, immediately before
execution. A refused spend skips that defect without calling Luna, records no
attempt evidence for it, sets `exhausted`, and continues with the rest.

**File scope.** `filesForDefect` and `REPAIR_COMPANIONS` move unchanged.
`REPAIR_COMPANIONS` stays deferred to the tool-gateway phase: it is a permission,
and this commit only relocated it.

**Luna's authority.** What may be written is Luna's output intersected with the
paths the harness put in that call's context:

    permitted = returned ∩ context

Everything else is counted as refused and recorded. Enforced in code, not asked
for in the prompt — which is the invariant the tool gateway will generalise.

**Failure.** One failed call does not abort anything: the budget is already
spent, the file is recorded as failed, the loop continues to the next file and
the next defect, and the defect stays open for the next evaluation to judge.
No refund, no automatic replan, no asking Sol mid-phase.

**Exhaustion is a result, not a decision.** The phase reports `exhausted`; the
loop still owns `decideTerminal`.

### Characterised, then mutation-checked

Seventeen focused unit tests, made possible by the extraction itself: the phase
takes its collaborators explicitly, so a fake workspace and a scripted Luna can
be handed to it with no Mongo. The end-to-end repair coverage in
`refusal.integration.test.ts` stays — it proves the loop reaches this code and
spends real budgets, which a fake cannot.

All six required mutations were applied and observed to fail:

| Mutation | Tests failed |
|---|---|
| remove the transactional spend | 4 |
| accept every path Luna returns | 2 |
| one call for the whole scope | 3 |
| count once per file written | 1 |
| let a Luna failure escape | 3 |
| skip the repair-cycle commit | 2 |

The first attempt at mutation 1 silently did not apply — the pattern's
indentation was wrong — and reported a clean pass. Every mutation since is run
through a helper that fails loudly when the pattern is not found.

### Characterised, not changed

Two behaviours were pinned as they were, not endorsed:

- The exhaustion guard read the **cumulative** `repairsApplied` — corrected in
  4b.1, below.
- The cycle commit is attempted unconditionally, including when nothing was
  written. The workspace decides whether there is anything to record. Still
  characterised rather than changed.

No new artifact, no `repair-decision`, no new project state. `adjudication-
decision` is still written before repair runs; the phase executes an already
persisted decision.

## Phase 4b.1 — ask the exhaustion guard about this cycle

    - if (repair.exhausted && repairsApplied === 0)
    + if (repair.exhausted && repair.repairsAppliedDelta === 0)

`repairsApplied` is the run's cumulative count, so a cycle that was refused
every spend and repaired nothing continued anyway as long as some earlier cycle
had succeeded: another evaluation, another rejection spent, the same defects
still open. The question the guard means to ask is about the cycle that just
ran, and 4b's per-cycle delta is what it can be asked with.

### Why nothing caught it

The branch is unreachable within a single run. Since Phase 3b, targets are
capped to the project allowance and filtered by per-fingerprint eligibility
before they reach the repair phase, so the authoritative spend cannot refuse one
that policy authorised. It fires only when the transaction disagrees with the
snapshot policy read — drift, a concurrent writer, a resumed run — which is
exactly the case worth getting right, and exactly the case no test could reach.

So the refusal is now simulated. `refusal.integration.test.ts` mocks
`spendRepairAttempt` as a pass-through with an opt-in refusal list, leaving all
its existing budget accounting real. The new scenario repairs successfully in
cycle one, has cycle two's only target refused, and asserts the run stops with
two review rejections spent rather than three.

Verified by reverting the condition: the old one spends the third rejection and
the test fails on the count.

### A test that was not proving what it said

`spends once per defect, transactionally` asserted the spend happened before
Luna, which left the wrapper untested — removing `withTransaction` while keeping
the spend would have passed. The fake store now records whether each spend
happened inside a transaction, and a mutation that drops only the wrapper fails
it. Split into two tests, since ordering and atomicity are different claims.

### Still open from 4b review

`RepairInput.sources` was the mutable array type — closed in 4c.

## Phase 4c — one owner for run progress — **DONE**

### Before

`run-context.ts` described `RunProgress` correctly, and `runProject` did not
have one: it kept **eighteen parallel mutable locals** and a `snapshot()` that
rebuilt an object from them on every phase call.

    plan · reviewCycle · repairsApplied · replansUsed · qualityScore
    gatesCertified · openDefects · repairedSinceReview · repairHistory
    terminalDecision · authorization · approvalArtifactVersion
    approvalModel · approvalDecision · reviewUnavailable
    usage · usageByTier · phaseMs

Two writable representations of the same facts, and the copy went one level
deep — every array and telemetry bucket in a "snapshot" still pointed at the
run's live data.

### After

    createRunProgress()   → the one mutable owner, held by runProject
    snapshotProgress(...) → a detached, read-only view, per phase call

`runProject` is **416 lines** (from 442). The number barely moved, and that is
fine: the point was ownership, not size. What changed is that there is now
exactly one writable representation of each fact.

**Telemetry moved onto the owner.** `track()` writes `progress.usage` and
`progress.usageByTier`; the phase timer writes `progress.phaseMs`. There is no
second telemetry object to keep in step. `phaseStarted` and `currentPhase` stay
private locals — timing machinery, not something a phase reports.

**`plan` is nullable on the owner and never on a phase's view.** Telemetry
starts accumulating before planning, so the owner outlives the gap;
`snapshotProgress` throws rather than handing a phase progress with no plan,
because that would be a wiring mistake rather than a runtime condition. Intake
failure still returns through `withoutDelivery` with the telemetry accumulated
so far, and never calls `snapshotProgress`.

### The detachment

`structuredClone`, not a hand-written copy — every field is plain cloneable
data, and an explicit clone would silently go shallow again the next time the
shape grows. Not `JSON.parse(JSON.stringify(...))`, which would turn `undefined`
into a missing key.

Both directions are tested, and the nesting with them: the owner advancing does
not alter a view already handed out, and writes forced through an unsafe cast
into a view — including `view.plan.sitemap.pages[0].title` — leave the owner
untouched.

### The readonly boundary

Phase-facing `RunProgress` is readonly at its own level: every field, and every
collection it holds directly. It is deliberately *not* deeply readonly — the
`SitePlan`'s nested members and the inner `usageByTier` buckets are still
mutable types, because making them otherwise would mean changing the contracts
package for the sake of an orchestrator boundary. The runtime clone is what
makes those safe; the types state the intent at the level where they can
without spreading.
`run-progress-readonly.ts` is a compile-time fixture: every line is an expected
error under `@ts-expect-error`, so *removing* a readonly marker fails the build
on the unused directive rather than passing quietly.

Turning it on immediately found three places passing a readonly array where a
mutable one was expected — the adjudication constraints, the concluded result,
and the manifest's checks. All three now copy at the point ownership changes
hands.

`RepairInput.sources` is closed too: `SourceFiles` is `readonly SourceFile[]`,
tightened at the orchestrator boundary rather than in the workspace's API.

### What the owner is not

It is in-process working state for one invocation. It is **not** authority for
project state, budgets, defect budget counters, artifact versions or release
permission — those stay in the store, the registry and the policy engine. A test
asserts the owner holds no budget remainder and no artifact-version cache, with
the one exception the manifest genuinely needs: `approvalArtifactVersion`.

### Phases still cannot write to the run

Audited before changing anything: no phase assigns to `ctx.progress` or pushes
into its collections, and none depends on a value becoming live-updated during
its own call. `conclude.ts` is the only phase reading telemetry, once, at the
exit — and nothing mutates it between the snapshot and that read.

The still-blocked exit was hand-building a `RunResult` from locals; it now goes
through `concluded()` like every other post-delivery return. Every telemetry bug
this file has had came from one exit path reporting a different run from the one
that happened.

### Mutation checks

| Mutation | Result |
|---|---|
| return the owner instead of a clone | 4 isolation tests fail |
| copy only the top level | the same 4 fail |
| reintroduce `let reviewCycle` beside the owner | single-owner guard fails |
| drop a readonly marker | typecheck fails on the unused directive |
| report telemetry from a stale object | parity test fails |
| stop applying repair history to the owner | **nothing failed** |

The last one was a real gap, not a passing grade. Repair history is evidence for
the *next* adjudication, and dropping it changed no total, no outcome and no
artifact anyone was checking — every later decision would simply have been made
as though nothing had been tried. Closed by asserting the history reaches the
next adjudication's recorded constraints; the mutation now fails.

### 4c.1 — a public contract tightened by accident

`RunResult` is the package's public type and it declared its telemetry by
aliasing the internal phase boundary:

    usage: RunProgress['usage']

So making the phase view readonly made the result readonly too, and a caller
doing `result.usage.calls += 1` stopped compiling — an API change nobody
decided on, arriving as a side effect of an internal one. Whether a result
*should* be readonly is a fair question, and if the answer is yes it belongs in
a commit that says so.

The result now states its own telemetry types, and both exits copy rather than
handing back a reference, so the caller owns what it is given. The compile-time
fixture asserts the mutability with no `@ts-expect-error`, which means aliasing
it back fails the build.

## Phase 4d — deterministic artifact lineage — **DONE**

### The question `version` cannot answer

Artifact versions are scoped to a name:

    site-plan@1 · site-plan@2      route-decision@1

Neither number says whether the plan was written before or after the route
decision. That question was answered by sorting on `createdAt`, which is
millisecond-resolution *observation*: two writes in the same millisecond are
indistinguishable by it, and the only reason it held is that the awaits between
artifact writes happened to be slow enough. Phase 5 introduces real job
concurrency, so it needed replacing before then rather than after.

|  | Before | After |
|---|---|---|
| Artifact identity | `projectId + name + version` | unchanged |
| Cross-artifact order | `createdAt` | `projectId + lineageSeq` |
| `createdAt` | the ordering authority | observation, informational only |

### How a number is allocated

`artifact_sequences`, keyed by project id, so Mongo's own `_id` uniqueness
gives exactly one counter per project with no extra index.

    findOneAndUpdate(
      { _id: projectId },
      { $inc: { lastAllocated: 1 }, $set: { updatedAt: now } },
      { upsert: true, returnDocument: 'after', session },
    )

One atomic operation, never read-then-write — that version looks equivalent and
is not: two writers reading `7` both write `8`. `ArtifactRegistry.put` allocates
it, so no caller supplies one, no phase chooses one and no model can suggest
one. A session passed to `put` is used for the allocation as well as the version
lookup and the insert, so an aborting transaction takes the allocation with it.

**Gaps are allowed and are not worth preventing.** The number is allocated
before the insert, so a writer that allocates 14 and then fails leaves 13, 15,
16 — a valid ordering with a hole in it. A sequence is an ordering token, not an
accounting balance, and reclaiming 14 would add a failure mode to remove a
cosmetic one.

### Indexes

    { projectId: 1, lineageSeq: 1 }
      unique
      partialFilterExpression: { lineageSeq: { $exists: true } }

Partial because artifacts written before this existed have no `lineageSeq`, and
a plain unique index would read every one of them as a duplicate `null` and
refuse to build against an existing database. The two existing artifact indexes
are unchanged.

### Artifacts written before

`listLineage` is a new method rather than a change to `list`, which groups by
name and has callers relying on that. Sequenced artifacts order by
`lineageSeq`; legacy ones sort first, by `createdAt` then `_id`.

That fallback is for **stable presentation**, and it is worth being blunt about
what it is not: when two legacy artifacts share a millisecond, their true write
order was never recorded and cannot be recovered. Nothing is backfilled, because
a backfilled number would be a confident invention.

### What did not change

- **`ArtifactRef`** keeps exactly `name`, `version`, `contentHash`. A worker
  pins an artifact by identity; where it sits in the project's history is
  platform metadata and no input should depend on it.
- **`contentHash`** — the sequence is not hashed, and neither are the
  timestamps. Identical data hashes identically before and after.
- **`accept()`** allocates nothing. Creating an artifact is one event in the
  history; accepting the version that already exists is not a second one.
- **`RunProgress`** did not gain the counter. Reading a cached number and
  incrementing it is precisely the concurrent-authority bug this removes — and
  4c made `RunProgress` run-local working state on purpose.
- **The counter is not in `ProjectDocument`.** A run deletes and recreates that
  record at startup, so a counter living there would reset and the second run's
  artifacts would claim to precede the first run's. A test pins that.

Deferred, deliberately: which job produced an artifact (`producerJobId` and
friends) belongs with the job-engine work, where those identities are real; and
parent edges are a DAG, which is a different capability from a total order.

### Mutation checks

| Mutation | Result |
|---|---|
| order lineage by `createdAt` again | identical-timestamp and race tests fail |
| read-then-write instead of `$inc` | both race tests fail — checked three times, not flaky |
| drop the unique partial index | duplicate-lineage test fails |
| one global counter | 5 tests fail |
| reset the counter mid-project | 5 tests fail |
| leak the sequence into `ArtifactRef` | public-shape test fails |
| allocate again on `accept()` | acceptance test fails |

### 4d.1 — a migration test that proved the wrong thing

The legacy-index test inserted its rows and *then* called `ensureIndexes()` —
but the suite already indexes in `beforeAll`, so the index existed before the
rows did. It proved an existing partial index tolerates missing values, which
was never in doubt. The question is whether the index can be **built** over rows
already in the database, which is the deployment case, and a plain unique index
cannot: it reads every missing `lineageSeq` as the same duplicate `null`.

Corrected with its own database, dropped first and deliberately left unindexed
until three legacy rows are in place:

    legacy rows exist  →  no lineage index yet  →  ensureIndexes()
      →  builds  →  rows untouched  →  new artifacts numbered
      →  duplicate positions still refused

The first assertion is that the index is *absent*, so the test cannot pass
trivially again. Verified by mutation twice: removing the partial filter fails
the build with `Index build failed`, and indexing before the inserts — the
original flaw — fails the absence assertion by name.

No runtime file changed. The Phase 4d design stands as approved.

## Phase 4e — discover and project setup — **DONE**

The last block of mechanics mixed into the delivery loop.

### Before

`runProject` opened with intake validation, then the workspace, then the
project reset, budget creation and the canonical profile artifact — seventeen
steps of startup before any orchestration began.

### After

    discoverProject({ projectId, intake, store, registry,
                      workspacesRoot, autonomyMode, say })
      → { ok: false, outcome: 'intake_insufficient' }
      | { ok: true, profile, workspace, budgetLimits }

`runProject` is **400 lines**, from 416, and opens with discover, plan, build,
the loop, then release. The number barely moved because the block moved rather
than shrank — what changed is that bootstrap mechanics are no longer interleaved
with orchestration.

### Why it is a pre-context phase

`RunContext` is made of a workspace, a canonical profile and budget ceilings —
and this is what produces them. Weakening `RunContext` with optional fields so
discover could share the later phases' signature would have handed every phase a
context that might be half-built. So it takes what it needs, returns what it
made, and `runProject` assembles `RunDeps` and `RunFacts` from that.

It also does not construct a `RunResult`. The phase reports; the caller decides
what an unusable brief means, which keeps the deliberate split between the
pre-delivery exit and the post-delivery one.

### Nothing happens until the brief is accepted

Two refusals, both deterministic, both leaving the project untouched:

| Refusal | Detail |
|---|---|
| fails the schema | `Intake rejected: <first issue>` |
| passes it, says too little | `Intake insufficient: <gaps joined by "; ">` |

No workspace opened, no project or budget deleted, no artifact written. That is
the property worth guarding hardest: startup deletes the project record, its
budget and its per-defect counters, so validating *after* that would let a
malformed retry destroy the previous run's work — silently, because the caller
sees `intake_insufficient` either way.

Two tests assert the side-effect log is empty on each branch, and the mutations
that move validation later fail them.

### What setup still does, in this order

    workspace.open
    projects.deleteOne · budgets.deleteOne · defectBudgets.deleteMany
    projects.insertOne (state: planning)
    createBudget
    registry.put business-profile → accept → materialise
      client/business-profile.json
    read the budget ceilings

Unchanged throughout. **Artifacts and `artifact_sequences` are deliberately not
reset** — history outlives the project record, so a second run for the same
project continues the lineage rather than restarting it. A test fails if either
is cleared.

The artifact and the file carry the **parsed** profile, never the raw intake:
everything downstream measures against it, so passing on unvalidated input would
let extra fields through as canonical fact.

### Refusal is not the same as failure

Only intake insufficiency returns a result. A workspace that will not open, a
registry that will not write, a budget missing straight after creation — all
throw. Reporting the second kind as the first would tell a customer their form
was incomplete when the deployment was broken.

The missing-budget case is the one place the wording changed: the previous `!`
would have thrown a `TypeError`; it now throws with a message naming the
project. Both reject, and neither invents ceilings nobody set.

No model participates. No new artifact, no new project state, no transaction
added around startup — if a later step throws, earlier side effects still exist,
exactly as before. No job-engine runtime was introduced.

### Mutation checks

| Mutation | Tests failed |
|---|---|
| open the workspace before validating | 3 |
| reset the project between the two checks | 2 |
| clear artifacts and the lineage counter | 2 |
| drop the acceptance | 1 |
| change the materialisation path | 2 |
| catch a platform failure as `intake_insufficient` | 1 |
| materialise the raw intake | 1 |

## Phase 4 — **COMPLETE**

Every planned extraction landed: 4a phases, 4b repair, 4b.1 the exhaustion
guard, 4c progress ownership, 4c.1 the public result contract, 4d artifact
lineage, 4d.1 its migration proof, and 4e discover.

**Closed at `141b2f1`** — 458 unit, 80 integration, 538 full, both GitHub checks
green. Phase 5 begins after that boundary.

`REPAIR_COMPANIONS` remains an implicit permission and belongs to the later
permission/tool-gateway phase — it was never Phase 4 work.

## Phase 5 — the job engine becomes the worker runtime

The engine has had enqueue, dependency-aware claiming, output-conflict
serialisation, leases, heartbeats, retry, reclamation and a transition audit
since the beginning — and no consumers. Phase 5 gives it work to do, starting
with the safety it needs before real model work runs through it.

### Phase 5a — a lease is execution authority — **DONE**

**Before.** The lease represented scheduling ownership, and only some methods
treated it as authoritative. `submitForValidation` and the running branch of
`fail` both filtered on state alone:

    { _id: jobId, state: { $in: ['running'] } }

so a worker whose lease had lapsed — and whose job had been reclaimed and handed
to someone else — could still submit its work, or fail the job the new holder
was in the middle of. `heartbeat` checked the holder but not the expiry, so a
worker could revive its own dead lease in exactly the window where another
worker was about to be given the job.

**After.** A running job may be advanced only by the worker that currently owns
it:

    { _id: jobId,
      state: 'running',
      'lease.holder': workerId,
      'lease.expiresAt': { $gt: now } }

The ownership test is in the update filter, not in a check before it. Reading
the lease and then writing on state alone leaves a window — short, and exactly
long enough for the reaper and a new claim to land between them. The guard and
its audit event stay in one transaction.

`JobLeaseConflict` is a distinct error, because "the job moved on" and "you lost
it" are different facts: the first may be retryable, the second means someone
else is doing the work and this worker must stop. Precedence is pinned — no
document is `JobNotFound`, wrong state is `JobStateConflict`, running-but-not-
yours is `JobLeaseConflict`.

**One definition of expiry.** Active is `expiresAt > now`, so a lease expiring
exactly now is already gone. `reclaimExpiredLeases` moved from `$lt` to `$lte`
to agree: the old pairing left a single instant where a lease was too dead to
use and too alive to reclaim. A test pins both sides of that boundary.

**Validation failure keeps its own authority.** A running job failing is the
worker reporting its own broken work and needs the lease. A validating job
failing is the harness rejecting finished work — submission already cleared the
lease, and requiring one would make validation impossible.

Sixteen tests against the real replica set, all deterministic — every method
takes `now`, so nothing waits on a clock. The strongest is not that a stale
worker throws but that it changes nothing: after a late failure is refused, the
live job's state, attempt, lease holder, lease expiry and failure field are all
compared and none has moved.

| Mutation | Tests failed |
|---|---|
| drop the holder guard | 6 |
| drop the expiry guard | 3 |
| let an expired lease heartbeat | 2 |
| fail a running job on state alone | 3 |
| reclaim with `$lt` | 1 |
| audit a rejected transition | 1 |

The audit mutation needed two attempts: written inside the transaction it was
rolled back by the abort, which is the design working. Written outside, the
audit non-effect test catches it.

Also corrected a misleading fixture: the engine tests called `accept(job, 'sol')`,
implying a model accepts work. Acceptance is the harness's, and they now say
`harness:validator`. No actor typing changed.

**`runProject` still does not execute through `JobEngine`.** Nothing imports it,
nothing is enqueued, no worker loop exists. Delivery behaviour is unchanged.

### Phase 5b — role-aware claiming — **DONE**

**Before.** `claim(workerId, options)` filtered candidates on `state: 'ready'`
alone. `role` was already stored on every `JobDocument` — denormalised
specifically to be a Mongo routing key — but nothing read it back. A worker id
is just a string; any worker could claim any job regardless of what it was.
`ROLE_TIER` (`WorkerRole` → `AgentTier`) existed in `@statxai/contracts` and
governed nothing at claim time.

**After.** `claim` takes the caller's `tier` as a required second argument and
narrows the candidate query itself: `role: { $in: rolesForTier(tier) }`.
`rolesForTier` is the inverse of `ROLE_TIER`, computed rather than restated, so
the two tables cannot drift apart. A Luna worker never sees a Terra job to race
for — the exclusion is in the same document read that finds a job runnable at
all, alongside `state: 'ready'`, not a check layered on top of it afterward.

    claim(workerId, tier, options?)
    candidates = { ...scope, state: 'ready', role: { $in: rolesForTier(tier) } }

Covered in `packages/job-engine/test/engine.test.ts` (`role-aware claiming`):
a Luna worker gets `null` against a Terra job and the job stays `ready`; a
Terra worker gets `null` against a `repair` job; each tier claims only its own
role; and a worker scanning past an ineligible-but-older job still reaches the
one it can take, rather than the scan stopping at the first `ready` document.
`packages/contracts/test/primitives.test.ts` pins `rolesForTier` against
`ROLE_TIER` directly — every role reachable, none double-claimed by two tiers,
and Luna's set is exactly `['repair']`.

**`runProject` still does not execute through `JobEngine`.** This closes the
authorisation gap the doc flagged before real workers exist; it does not wire
any worker up. Delivery behaviour is unchanged.

### Phase 5c — harness-owned in-process job runner — **DONE**

A runtime primitive only: a `JobRunner` that can claim, execute and settle one
job. Nothing yet decides *what* jobs to enqueue — `runProject` still does not
execute through `JobEngine`, and no production Terra or Luna skill is wired
into a runner. This closes "how does a claimed job actually run" without
touching "what work exists as a job" at all.

**Identity is fixed at construction, not per call.** `JobRunner` takes a
`JobWorkerIdentity` (`{ workerId, tier }`) once; `runOnce({ projectId? })`
always claims with that same identity, so a caller cannot quietly widen what a
worker may take by passing a different tier on one call. `rolesForTier(tier)`
— the same table 5b's `claim` filters candidates by — is checked again at
construction: every role that tier may claim must have a registered handler,
or the runner throws `JobRunnerConfigError` before touching the store. A tier
with no executable roles (`sol`) is rejected outright, so a Sol execution
runner cannot be built; Sol still only plans, routes and adjudicates.

**The handler never gets `JobEngine`.** A `JobHandler` receives the claimed
`JobDocument` and an `AbortSignal` and nothing else — no submit, no fail, no
accept, no way to transition the job itself. The runner alone decides what a
returned promise or a thrown error becomes:

    ready --JobEngine.claim()--> running --handler resolves--> JobEngine.submitForValidation() --> validating
    ready --JobEngine.claim()--> running --handler throws----> JobEngine.fail()                 --> ready | failed

A successful run ends in `validating` with a cleared lease — **not**
`accepted`; acceptance stays separate harness authority this slice does not
touch. Every transition still goes through `JobEngine`'s own guarded filters
and audit writes; the runner duplicates none of 5a's or 5b's logic.

**Heartbeats are the runner's job, not the handler's.** While a handler runs,
the runner renews the lease on an interval strictly under the lease duration
(default `leaseMs / 3`; both are validated at construction —
`heartbeatEveryMs` must be `> 0` and `< leaseMs`). `now: () => Date` and
`sleep: (ms, signal) => Promise<void>` are injectable seams threaded through
*every* engine call the runner makes (`claim`, `heartbeat`, `submitForValidation`,
`fail`), not just the ones an obvious reading would need — so a test can hold
simulated time fixed across a whole execution without a stray default
`new Date()` leaking real wall-clock state into a deterministic scenario.
Production defaults use real `Date`/`setTimeout`.

**Losing authority stops everything, one way or another:**

- `heartbeat()` returns `false` → the signal is aborted, the handler's
  outcome is discarded unread, and the result is `{ kind: 'authority_lost',
  reason: 'heartbeat_lost' }`. Neither `submitForValidation` nor `fail` is
  called.
- `heartbeat()` *throws* (a platform failure, not "someone else has it") is
  handled differently on purpose: the signal is still aborted and nothing is
  submitted or failed, but the error is **rethrown from `runOnce`**, not
  folded into a job outcome. A Mongo outage must not read as a build failure,
  and recovery is left to the existing lease reaper rather than invented here.
- Authority can still be lost in the gap between the last heartbeat and the
  final transition. `submitForValidation`/`fail` throwing `JobLeaseConflict`
  or `JobStateConflict` — 5a's own guard, unmodified — is caught and mapped to
  `{ kind: 'authority_lost', reason: 'transition_conflict' }`. The runner
  never retries with another actor and never attempts a different transition
  to force the outcome through.
- The heartbeat loop is always fully stopped and awaited (`stopped = true;
  controller.abort();` then `await heartbeatDone`) before any authoritative
  transition is attempted, and before `runOnce` returns — no timer or promise
  is left running afterward.

**Result contract** (`JobRunOnceResult`): `idle | submitted | handler_failed |
authority_lost`, control-plane only — no `RunResult`, no orchestrator release
outcome mixed in.

**Files:** `packages/job-engine/src/runner.ts` (new), `packages/job-engine/src/index.ts`
(export it), `packages/job-engine/test/runner.integration.test.ts` (new, 21
tests against the real replica set — named for the repo's own convention so
it's picked up by `vitest.integration.config.ts`'s glob without hand-editing
either config's suite list).

**Tests, end to end:** 462 unit, 121 integration, 583 total. The 5b boundary
was 462 unit + 100 integration = 562; 5c adds only the 21 new tests in
`runner.integration.test.ts` (unit count unchanged, integration 100 → 121).
Typecheck and lint both clean. Not
claiming GitHub CI ran on this — it did not; these are local results on the
commit described below.

**Mutation checks, run manually and reverted after each** (not part of the
committed diff): a caller-selected tier instead of the fixed identity (13/21
tests killed); removing handler-coverage validation (1/21); skipping the
success-path submit (2/21); auto-accepting after submit (1/21); reporting a
handler failure under a different actor (3/21 — partly via 5a's own
lease-holder guard rejecting the mismatched actor); removing heartbeat
renewal entirely (3/21, two by test timeout rather than a fast assertion);
allowing `heartbeatEveryMs >= leaseMs` (1/21); ignoring a lost heartbeat and
submitting anyway (1/21 — backstopped by 5a's own expiry guard on the submit
itself); converting a heartbeat platform error into `JobEngine.fail()` (1/21);
leaving the heartbeat loop running after a successful submission (4/21,
including the dedicated cleanup test); forcing a second transition after a
`JobLeaseConflict`/`JobStateConflict` on the final submit (1/21 — the forced
retry is itself rejected by 5a's guard, surfacing as an unhandled rejection
the test catches). Every mutation was killed by at least one test.

**`runProject` still does not execute through `JobEngine`.**

**No production Terra or Luna skill is wired into `JobRunner` yet.** The
handlers in every test are stubs; nothing here reads a Sol plan, calls a
model, writes source files, or runs a gate.

### Phase 5d — role-scoped worker capabilities — **DONE**

5c required a Terra `JobRunner` to have a handler for every role Terra is
*permitted* to run — correct for a general-purpose runner, but it meant a
specialised production worker (a Terra build worker with code for only
`frontend_backend`) could only be built with fake or throwing-stub handlers
for every other Terra role it would never actually claim. 5d closes that
without adding a second permission table:

    ROLE_TIER / rolesForTier(tier)      the maximum authority a tier has (5b, unchanged)
    claimableRoles ⊆ rolesForTier(tier)  one runner's fixed, narrower subset of it (5d)

Neither a model nor a `runOnce` caller chooses `claimableRoles` — it is
supplied once at `JobRunner` construction, exactly like `identity`, and
`runOnce({ projectId? })`'s type has no field that could widen it per call.

**`JobEngine.claim` signature:**

    claim(
      workerId: string,
      tier: AgentTier,
      options: { projectId?: string; leaseMs?: number; now?: Date; roles?: readonly WorkerRole[] } = {},
    ): Promise<JobDocument | null>

`roles`, when given, must be a non-empty subset of `rolesForTier(tier)` —
checked by a new private `resolveClaimRoles` *before* the claim transaction
opens, so a rejected request mutates nothing. Requesting a role outside the
supplied tier, or an empty array, throws `InvalidClaimRoles` (new,
engine-local — not added to `@statxai/contracts`, nothing persisted).
Duplicate roles in the request are canonicalised (`[...new Set(requested)]`),
not rejected. **Omitting `roles` entirely preserves 5b's original behaviour
exactly** — the caller may claim anything its tier can — so every existing
5a/5b call site (`claim(workerId, tier, { projectId, leaseMs, now })`, no
`roles`) needed no changes and still passes unmodified.

The resolved role set is what reaches the Mongo candidate query, unchanged in
shape from 5b:

    { ...projectScope, state: 'ready', role: { $in: resolvedRoles } }

— never "fetch every tier-compatible candidate, then skip unsupported roles
in JavaScript." That distinction is what keeps an older, out-of-subset job
from head-of-line blocking a worker's narrower queue: it never becomes a
candidate to begin with, the same property 5b already established for
tier-level filtering.

**`JobRunner` constructor:** gains a required `claimableRoles: readonly
WorkerRole[]` field, validated in this order before anything touches the
store: `leaseMs`/`heartbeatEveryMs` numeric sanity (unchanged from 5c) → the
tier itself has executable roles (Sol still rejected outright, unchanged from
5c) → `claimableRoles` is non-empty → every entry in `claimableRoles` belongs
to `rolesForTier(identity.tier)` (else `JobRunnerConfigError`, naming the
offending roles) → duplicates canonicalised → **handler completeness is
checked against `claimableRoles`, not `rolesForTier(tier)`** — the one
behaviour change from 5c. `runOnce` forwards `roles: this.claimableRoles` to
`claim`, never `rolesForTier(this.identity.tier)`.

**Extra handlers grant no authority.** A handler map may carry entries for
roles outside `claimableRoles` — construction does not forbid it — but
`claim` is scoped to `this.claimableRoles`, so such a role can never be
returned by `claim` and its handler is simply unreachable. Proven directly:
`role-scoped worker capabilities > never claims a role outside claimableRoles
even when a handler for it is registered` registers handlers for both
`frontend_backend` and `qa_review`, restricts `claimableRoles` to
`['frontend_backend']`, and asserts a ready `qa_review` job is left untouched
(`runOnce` returns `idle`).

**Files:** `packages/job-engine/src/engine.ts` (`claim`'s `roles` option,
`resolveClaimRoles`, `InvalidClaimRoles`), `packages/job-engine/src/runner.ts`
(`claimableRoles`), `packages/job-engine/test/engine.test.ts` (+9, a
`role-scoped claiming` suite), `packages/job-engine/test/runner.integration.test.ts`
(+10: a `role-scoped worker capabilities` suite, one heartbeat test switched
to a genuinely narrowed single-role runner so 5d cannot accidentally bypass
the 5c heartbeat runtime, and one structural source-scan guard). No change to
`@statxai/contracts`, `packages/orchestrator`, `packages/agents` or
`packages/workspace` — nothing outside `job-engine` needed touching, since
nothing outside it calls `claim` or constructs a `JobRunner` yet.

**Tests, end to end:** 462 unit (unchanged), 140 integration, 602 total —
up from the 5c figure of 462 + 121 = 583 by +19 integration tests (+9 in
`engine.test.ts`, +10 in `runner.integration.test.ts`). Typecheck and lint
both clean. Not claiming GitHub CI ran on this — it did not; these are local
results on the commit described below.

**Mutation checks, run manually against `engine.ts`/`runner.ts` and reverted
after each** (not part of the committed diff): `JobRunner` ignoring
`claimableRoles` and requesting the full tier instead (4/31 runner tests,
including the structural guard); `JobEngine` ignoring the requested subset
entirely (10/72 across both suites); `JobEngine` accepting a role outside the
supplied tier (4/72); a mixed valid/invalid request silently dropping the
forbidden role instead of rejecting the whole request (4/72); handler
completeness checked against `rolesForTier(tier)` instead of `claimableRoles`
(7/31); an extra registered handler implicitly widening claim authority
(2/31, including the structural guard); an empty `claimableRoles` accepted
(1/31); the role filter moved out of the Mongo query into a JavaScript
`break` that head-of-line-blocks on the first ineligible candidate (3/72,
catching both the 5b- and 5d-era head-of-line tests); `runOnce` accepting and
honouring a type-unsafe `roles` override in its options (2/31, including the
structural guard and a test written specifically to exercise that
type-unsafe path). Every mutation was killed by at least one test.

**`runProject` still does not execute through `JobEngine`.**

**No production Terra or Luna skill is wired into `JobRunner` yet.**

### Phase 5e — first real Terra frontend/backend job handler — **DONE**

5d made a specialised worker constructible without fake handlers for roles it
never claims. 5e is the first one that isn't a test double: a `JobHandler`
for `frontend_backend` that runs the actual production Terra build — the same
function the direct delivery loop calls, not a second implementation of it.

**Production handler:** `packages/orchestrator/src/job-handlers/frontend-backend.ts`,
`createTerraFrontendBackendHandler(deps: FrontendBackendHandlerDeps): JobHandler`,
where `deps` is `{ store, registry, model, workspacesRoot, say?, track? }` —
harness-owned collaborators fixed once, the same way a `JobRunner`'s
`identity` and `claimableRoles` are fixed. Exported from the package index.

**Shared build primitive:** `buildFromPlan` (`packages/orchestrator/src/phases/build.ts`),
**reused, not extracted** — it was already the one exported entry point for
"Sol routes, Terra builds"; the handler imports it directly and both callers
run the identical function. What *did* need extracting was cancellation
safety (below), added to `buildFromPlan` itself as an optional third
parameter, so both callers still share one function rather than one drifting
from the other.

**Required pinned inputs** (`JobSpec.inputs` keys, exported as
`FRONTEND_BACKEND_INPUT`): `businessProfile` and `sitePlan`, each an
`ArtifactRef`. Resolved with `registry.resolve(job.projectId, ref)` —
`get(projectId, name, version)` addressed by exact `_id`, never
`sort: version desc` — so a version accepted after the job was created cannot
change what it builds from. Project ownership is structural, not a checked
permission: the artifact `_id` is `artifactId(job.projectId, name, version)`,
so a ref cannot address another project's artifact regardless of what a job
claims. A missing required input throws `FrontendBackendInputInvalid` before
any model call.

**Output semantics:** exactly what the direct path already produces —
`ProjectWorkspace.writeSiteFiles` (real Git-backed source files),
`ArtifactRegistry.put`/`accept` for the `route-decision` record, and a real
`workspace.commit('Terra: build')`. Nothing new invented — no output
envelope, no second artifact kind.

**Specialised runner configuration:**

    identity: { workerId: 'terra-frontend-backend-1', tier: 'terra' }
    claimableRoles: ['frontend_backend']
    handlers: Map([['frontend_backend', createTerraFrontendBackendHandler(deps)]])

No handler is registered for `business_strategy`, `ux_information_architecture`,
`brand_ui_system`, `content_seo`, `crm_erp_integration`, `analytics_deployment`
or `qa_review` — 5d's `claimableRoles` narrowing is what makes that legal.

**The model is faked in tests; the handler is not.** Every test fakes only
`Provider.complete` (`ModelClient` is real, `buildSite`/`routeBuild` are
real). `createTerraFrontendBackendHandler` is never stubbed.

**Cancellation.** `ModelClient` does not accept an `AbortSignal` today — 5e
does not add one, per the brief's explicit instruction not to redesign it.
`buildFromPlan`, `decideStrategy`, `executeOneShot` and `executeDecomposed`
each take an optional `signal?: AbortSignal`, threaded from `ctx.signal`, and
call `signal?.throwIfAborted()` before every durable write: before the
project-state update, before the persisted route-decision artifact, before
`writeSiteFiles` (both one-shot and decomposed), before the decomposed
per-page write loop, and before the final commit. A response that arrives
after authority is lost is still passed to `deps.track` for telemetry — the
call really happened — but is checked against the signal immediately
afterward and discarded before it can reach a write. The direct delivery
loop never passes a signal, so every check is a no-op there; this changes
nothing about the path `runProject` still uses.

**When authority is lost while the model is in flight:** the handler's
`buildFromPlan` call throws (from a `throwIfAborted()` checkpoint) once the
pending response finally resolves; `JobRunner`'s existing 5c logic — which
checks its own heartbeat result before ever looking at what the handler did —
reports `authority_lost` without calling `submitForValidation` or `fail`, and
the checkpoint means the generated content never reached `writeSiteFiles` or
the workspace commit in the first place.

**Success lifecycle:** `claim()` → handler resolves → `JobRunner.submitForValidation()`
→ `validating`, lease cleared. **Not** `accepted` — acceptance stays separate
harness authority this slice does not touch.

**Build failure lifecycle:** the model boundary rejects → `buildFromPlan`
throws → `JobRunner.fail()` → existing retry semantics (`ready` while
attempts remain, `failed` once exhausted). No retry logic duplicated in the
handler.

**Files:** `packages/orchestrator/src/phases/build.ts` (optional `signal`
threaded through, zero behaviour change when omitted — proven by
`build.test.ts`'s own regression test), `packages/orchestrator/src/job-handlers/frontend-backend.ts`
(new), `packages/orchestrator/src/index.ts` (export it),
`packages/orchestrator/test/build.test.ts` (new, unit — the build
primitive's five cancellation checkpoints, isolated one at a time with
fakes, plus the direct-path regression),
`packages/orchestrator/test/job-handlers-boundary.test.ts` (new, unit — a
source-scan guard that the handler never imports `JobEngine` or calls a
job-transition method, in the style of `policy-boundary.test.ts`),
`packages/orchestrator/test/frontend-backend-job-handler.integration.test.ts`
(new, integration — the real handler under a real `JobRunner` against the
real replica set and a real temp Git workspace; only `Provider.complete` is
faked).

**Tests, end to end:** 469 unit, 147 integration, 616 total — up from the 5d
figure of 462 + 140 = 602: +7 unit (`build.test.ts` ×6,
`job-handlers-boundary.test.ts` ×1), +7 integration
(`frontend-backend-job-handler.integration.test.ts`). Typecheck and lint
both clean. Not claiming GitHub CI ran on this — it did not; these are local
results on the commit described below.

**Mutation checks, run manually and reverted after each** (not part of the
committed diff): handler resolves inputs by name only, ignoring the pinned
version (1/7 — the pinned-version test); handler replaced with a fake write
instead of calling `buildFromPlan` (5/7); handler's role guard removed
(1/7); a missing input silently falls back instead of failing closed (1/7);
`executeOneShot`'s pre-model check removed (0/7 in the integration suite —
the gap that motivated adding `build.test.ts`; 1/6 there, and the same
mutation is 0-catch in the integration suite precisely *because* a later
checkpoint in the same call happens to cover that scenario, which is itself
the reason each checkpoint now has its own isolated proof); the matching
post-model check removed (1/6 unit, and 1/7 integration — the stale content
actually reached disk); the handler smuggling in `JobEngine` and calling
`submitForValidation` directly (caught by the new structural boundary test);
the direct path's call site diverging from the shared primitive (2/8 in the
existing `delivery.parity.integration.test.ts`, unmodified — the artifact
lineage and phase-order assertions written for Phase 4a); `JobRunner`
auto-accepting after submit (1/7, re-verified at this layer though already
proven at 5c's). Every mutation was killed by at least one test.

**`runProject` still does not execute through `JobEngine`.**

**No production job is automatically enqueued yet.**

**No production Luna handler is wired yet.**

### Phase 5f — execution-token-fenced output publication — **DONE**

5e's cancellation checks (`signal.throwIfAborted()` before every durable
write) close the case where authority is *already* known lost. They do not
close the gap between the check and the write completing, and they do not
close the case 5f exists for: the *same* fixed `workerId` — the shape a
`JobRunner` always claims under — reclaiming its own job after its lease
expired. `lease.holder` alone cannot tell that worker's new execution apart
from the stale one it replaced.

**`workerId` alone is not execution authority; execution authority is the
exact claim generation.** `attempt` — verified monotonic: `claim()`'s own
`$inc`, never decremented anywhere in the engine, so a later claim of the
same job always has a strictly larger one — is reused as that generation
token rather than inventing a second counter. `JobRunner.runOnce` captures a
`JobExecutionToken { jobId, workerId, attempt }` exactly once, from the
`JobDocument` `claim()` itself returned, and every authority-bearing call the
execution makes reuses that same token — never rereading the job, never
letting a caller supply or override it.

**Every guarded running-job mutation now fences on it:**

    heartbeat(jobId, workerId, attempt, leaseMs?, options?)
    submitForValidation(jobId, workerId, attempt, options?)   // options.outputs?: readonly ArtifactRef[]
    fail(jobId, message, actor, attempt, options?)            // attempt fences the running branch only

The guarded Mongo filter (`transitionOwnedRunning`, and `heartbeat`'s own
`updateOne`) is now `{ _id, state: 'running', attempt, 'lease.holder':
workerId, 'lease.expiresAt': { $gt: now } }`. A same-worker stale attempt
fails closed with a new, distinctly-classified `JobAttemptConflict` — not
`JobLeaseConflict`, whose "held by X" message would be actively misleading
when X is this same worker's own later self. Error precedence:
not-found → wrong state → different holder (`JobLeaseConflict`) → same
holder, stale attempt (`JobAttemptConflict`) → expiry alone
(`JobLeaseConflict`, unchanged from 5a). `fail`'s validating branch accepts
`attempt` but does not use it — that branch has no lease to fence, unchanged
from 5c.

**Output attachment is the same atomic write as the transition, not a
second one.** `submitForValidation`'s `options.outputs`, when given, is
folded into the identical guarded `$set` that changes `state` and clears
`lease`. A stale submit that loses the race attaches nothing — the filter
matches no document, so neither the state change nor the output write
happens; there is no separate write for a mutation to make non-atomic. New
persisted field, `JobRecord.executionOutputs: ArtifactRef[] | null` (added to
`@statxai/contracts`, nullable/default-null like `lease`/`failure`) — what an
execution actually produced, set only by that guarded transition, distinct
from `JobSpec` (what work was expected, never mutated after enqueue).

**`JobHandler` may now return a result.** `JobHandler = (job, context) =>
Promise<JobHandlerResult | void>`, `JobHandlerResult = { readonly outputs?:
readonly ArtifactRef[] }`. A `void`-returning handler (every test stub in
5c/5d, and any future one) stays valid — output is optional on an optional
result. Before ever reaching the guarded submit, the runner validates every
returned ref's `name` starts with `jobOutputNamespace(jobId, attempt)` —
`` `job-output/${jobId}/${attempt}/` `` — rejecting the whole result
(`InvalidJobOutputRefs`, routed through the existing handler-failure path,
not a new result kind) otherwise. This is the one namespacing rule
`job-engine` enforces; it has no `ArtifactRegistry` dependency and no idea
what a "build candidate" is, only that output must own the execution that
produced it. Job ids are unique across the whole `jobs` collection, so a ref
genuinely namespaced this way could only have been produced by this exact
job's this exact attempt — no other job, in any project, and no other
attempt of this same job, can collide with it.

**Known limitation, stated rather than hidden:** this check validates the
job/attempt component of a ref's name; it cannot itself confirm which
*project* an artifact lives under, because `ArtifactRef` is project-relative
by construction everywhere else in the repo — `{ name, version, contentHash?
}`, no `projectId` — and always resolved against a project supplied
separately by the caller (`registry.resolve(projectId, ref)`,
`ArtifactDocument._id = artifactId(projectId, name, version)`). `job-engine`
does not hold a second, competing notion of project scope for refs; it
deliberately has no `ArtifactRegistry` access at all (§15 of the brief this
shipped under: "the generic job layer should understand references, not
website internals"). The invariant that has to hold, and does not need a
code change to state, is: `JobDocument.projectId` + an `executionOutputs`
ref together are what future resolution needs, and every future resolution
must use the *validating job's own* `projectId` — never one read from, or
guessed at from, the ref itself. A handler that staged under the *correct*
job/attempt namespace but called `registry.put` with the *wrong* project id
would still pass this namespace check; caught in this repo's own tests only
incidentally, by a fixture that resolves the candidate back under the real
project and finds nothing there. Phase 5g's promotion step is where that
invariant must be honoured explicitly (resolve every output through
`job.projectId`, never trust a project id carried any other way) — not a
reason to add `projectId` to `ArtifactRef` itself, which would be a
repo-wide contract change this phase has no evidence is actually needed.

**`frontend_backend` stages; it no longer publishes.** `buildFromPlan` split
into `prepareBuildFromPlan` (routes, builds, decompose-recovers — every model
call; writes nothing durable *itself*) and `publishBuildDirectly` (the site
files, then the commit). `buildFromPlan` is still exactly project-state
update → scaffold → prepare → publish, so the direct delivery loop is
unchanged — proven by a characterisation test pinning the full call
sequence, and unmodified by every existing `delivery.parity`/`refusal`
integration test still passing.

Route-decision persistence is *not* inside either half — an early version of
this split deferred it into `publishBuildDirectly` along with everything
else, which silently changed the direct path's own failure semantics: pre-5f
a route decision was durable the moment Sol (or the fallback) decided it,
before Terra was ever asked to build, so a build that failed after routing
still left that decision on record; deferred to publish, a failed build left
*nothing*, since publish is never reached on a thrown error. Caught in
review before landing. The fix: `prepareBuildFromPlan` takes an optional
`onRouteDecision` hook, invoked synchronously the instant each record is
decided (the original, and — should one-shot truncate — the recovery one),
in the exact relative position the old inline `recordRoute` call occupied.
`buildFromPlan` is the only caller that supplies it (wired to the same
persistence `publishBuildDirectly` used to do), restoring pre-5f timing on
the direct path exactly, including on failure — pinned by a regression test
that fails against the deferred version and passes against this one. Every
job execution calls `prepareBuildFromPlan` without the hook, unchanged: the
record is still collected into the returned candidate for whenever 5g
promotes it, but nothing reaches the registry before this execution's
authority is proven. The handler now
calls only `prepareBuildFromPlan`, stages the returned `BuildCandidate` as a
single artifact named `frontendBackendCandidateName(jobId, attempt)`, and
returns its ref as its `JobHandlerResult`. It never opens the canonical
`ProjectWorkspace` at all (`FrontendBackendHandlerDeps` no longer even
carries a `store` or `workspacesRoot`), never calls `registry.accept`, and
never transitions the job — proven by a structural test reading its source
back, in `policy-boundary.test.ts`'s style, for `JobEngine` references and
lifecycle-method calls.

**Staged output is deliberately orphanable, never garbage-collected here.**
A same-worker stale attempt that finishes staging after being superseded
leaves its candidate sitting under its own attempt's namespace, unaccepted
and unreferenced by any job — proven end to end against the real store and
Git-backed `ProjectWorkspace`, using the actual production handler, in
`frontend-backend-job-handler.integration.test.ts`. Retried attempts
(one fails, the next succeeds) stage to genuinely distinct namespaces, and an
attempt whose staging physically completes *after* a newer attempt has
already validated still cannot become canonical — the job's own
`executionOutputs`, set once by the transition that actually won, decides,
never "whichever candidate wrote last."

**Legacy `JobDocument` compatibility, checked rather than assumed.**
`executionOutputs` is `.nullable().default(null)` on the shared `JobRecord`
zod schema — the same pattern `lease`/`failure` already use. That default
only applies when a document is actually parsed through the schema, though,
and nothing in `job-engine` does that on read (`store.jobs.findOne`, and
`claim`'s own `findOneAndUpdate`, return whatever Mongo stored, trusted
directly via the `JobDocument` TypeScript interface — no `.parse()` in
between). A document written before this field existed therefore reads back
with `executionOutputs: undefined`, not a genuine `null`. Checked, not
papered over: nothing here ever *reads* an existing job's `executionOutputs`
— it is write-only, set only by the guarded `submitForValidation` transition
— so the gap between the schema's default and a legacy document's actual
shape never reaches a comparison that would tell the two apart. Pinned by a
real Mongo test that inserts a job exactly as `enqueue` would have written
one before this field existed (the field genuinely absent, not merely
`null`) and proves it still claims, heartbeats, submits, and accepts newly
staged outputs precisely like a current job — reading `?? null`, the same
idiom already used everywhere else in this codebase for exactly this shape
of field.

**Files:** `packages/contracts/src/job.ts` (`executionOutputs`),
`packages/job-engine/src/engine.ts` (`JobAttemptConflict`, attempt-fenced
`heartbeat`/`submitForValidation`/`fail`, atomic output attachment),
`packages/job-engine/src/runner.ts` (`JobExecutionToken`,
`jobOutputNamespace`, `InvalidJobOutputRefs`, `JobHandlerResult`, token
capture and reuse, output-ref validation), `packages/orchestrator/src/phases/build.ts`
(`prepareBuildFromPlan`/`publishBuildDirectly`/`PrepareContext` split, plus
the `onRouteDecision` hook that restores the direct path's exact pre-5f
route-decision timing), `packages/orchestrator/src/job-handlers/frontend-backend.ts`
(stages instead of publishes), plus the corresponding test files for each —
`packages/job-engine/test/engine.test.ts` gains the legacy-`JobDocument`
suite above, `packages/orchestrator/test/build.test.ts` gains the
route-decision-survives-failure regression test.

**Tests, end to end:** 472 unit, 172 integration, 644 total — up from the 5e
figure of 469 + 147 = 616 (+3 unit, +25 integration — the figure reported
before this review's fixes landed was 471 + 169 = 640; this review added one
unit regression test and three integration legacy-compatibility tests on
top). Typecheck and lint both clean. Not claiming GitHub CI ran on this — it
did not; these are local results on an uncommitted working tree, per this
phase's own instruction not to commit.

**Mutation checks, run manually against `engine.ts`, `runner.ts`, `build.ts`
and `frontend-backend.ts`, each reverted after** (not part of the committed
diff): `attempt` removed from the `heartbeat` guard (3/101 across the
engine, runner and real-handler integration suites at once); `attempt`
removed from the shared `transitionOwnedRunning` guard — covering both the
submit and running-fail mutations simultaneously, since they share one
private helper (7/101); the token rechecked/rederived before the final
submit, and output refs attached by a separate non-atomic write before the
guarded transition — both not mechanically expressible as isolated mutations
in the current design, since no reread path and no second write path exist
to mutate into existence (confirmed instead by directly breaking the guarded
write into two Mongo operations, which the atomicity-specific tests caught,
3/101); attempt dropped from the staging namespace (4/9); job output written
straight to the canonical workspace (0/9 until the deps plumbing was
temporarily restored to make the mutation reachable at all — the type system
alone blocks the naive version; 1/9 once genuinely wired, caught by a
strengthened assertion this phase's mutation check itself motivated adding);
canonical/`latest`-style artifact naming used for staging (4/9); staged
output written under the wrong project entirely (3/9 — caught incidentally
by fixture reads, not by a positive ownership check; see the limitation
noted above); auto-accepting the staged artifact (1/9). "Newest candidate
wins by `createdAt`" has no code path to mutate into existence — attempt-
scoped unique names mean there is never an ambiguous "latest" to resolve
among candidates in the first place. Every mutation that was reachable at
all was killed by at least one test.

**`runProject` still does not execute through `JobEngine`.**

**No production job is automatically enqueued yet.**

**Frontend/backend candidate output is not automatically accepted or
promoted.**

**No production Luna handler is wired yet.**

### Phase 5g-1 — isolated deterministic validation of one fenced frontend/backend candidate — **DONE**

5f fenced a `frontend_backend` execution's output — one `ArtifactRef`,
namespaced under `jobOutputNamespace(jobId, attempt)`, attached atomically to
`JobDocument.executionOutputs` by the same guarded transition that moved the
job to `validating`. It proved nothing about whether that candidate is any
good. 5g-1 closes that gap for exactly one job at a time, without touching
anything 5g-2 (acceptance, promotion) still owns.

**One new function, `validateFrontendBackendCandidate(job, deps)`,
in `packages/orchestrator/src/job-validation/frontend-backend.ts`.** Deps are
`{ registry: ArtifactRegistry; validationWorkspacesRoot: string }` — no
`JobEngine`, no `store`, no `ModelClient`, no canonical `workspacesRoot`. That
last omission is deliberate and structural, not merely behavioural: this
module has no variable anywhere in it that could hold a reference to the
canonical project workspace, so "validate against the canonical workspace
instead of an isolated one" is not a bug this code could regress into by a
local edit — there is nothing to point at.

**Checks fail closed, in this exact order, before any resolution begins:**
role (`frontend_backend`) → state (`validating`) → `executionOutputs`
present and non-empty → exactly one ref (the handler's own contract; a count
of zero or more than one is a hard error, never narrowed to "the first one")
→ that ref namespaced under *this exact* `job._id` and `job.attempt`
(`jobOutputNamespace`, the same Phase 5f helper — not a second
implementation of the same check). Only once every one of those holds does
`deps.registry.resolve(job.projectId, ref)` even run — always the job's own
`projectId`, always the exact attached `(name, version)`, never `get()`'s
"latest" form, and never derived from the candidate's own contents or from
any other job's data. The pinned `businessProfile`/`sitePlan` inputs
(`job.spec.inputs`, the same `FRONTEND_BACKEND_INPUT` keys the handler
already uses) are resolved the same way, for the same reason: this module
must build and gate exactly what the handler built and gated, nothing
re-derived.

**Pinned-input resolution, verified rather than assumed.** The paragraph
above was true of the code from the first version of this phase — `resolve`
takes a version-specific `ArtifactRef` for `businessProfile`/`sitePlan`
exactly as it does for the candidate — but nothing had actually pinned that
behaviour for the two *inputs* the way "exact-ref resolution — never latest"
already pinned it for the candidate itself. Reviewed and closed in the same
uncommitted tree, not deferred to a 5g-1.1: a dedicated integration test
(`'pinned means pinned: businessProfile and sitePlan, not the handler's own
inputs'`) stages a job pinned to v1 of both artifact names, creates and
*accepts* v2 of each afterward, and asserts — via the same faked `runGates`
already used to control pass/fail, now also capturing what it was called
with — that the deterministic gates ran against v1's content, not v2's.
Mutation-checked the same way as everything else in this phase: swapping
`resolve()` for `get()`'s latest-version form on the two pinned-input calls
was reverted after confirming exactly this one new test caught it (1/22
integration), with every other test in the file unaffected — the narrowest
possible kill for the narrowest possible gap.

**Payload shape is checked before anything is written to disk.** A small
`zod` object (`{ routeDecisions: z.array(z.unknown()), files:
z.array(GeneratedFile) }`) reuses the one existing `GeneratedFile` schema
from `@statxai/contracts` rather than inventing a second competing
`BuildCandidate` schema; `routeDecisions` is checked only for being an array,
since deterministic validation never reads it (it feeds nothing gates or the
build step touch). A candidate that resolves fine but fails this check throws
`CandidateValidationShapeInvalid` before any `mkdtemp` call — nothing is ever
created for it to clean up.

**Deterministic measurement is not reimplemented — it is reused.**
`evaluateSite` (`phases/evaluate.ts`) already runs compile → read the export
→ run gates as its own first deterministic pass. That sequence is now
`runDeterministicGates(siteRoot, profile, plan)`, extracted verbatim (a pure
refactor — same calls, same order, same build-failure fallback shape,
`{ passed: false, findings: [], gatesRun: ['build'] }`) and exported for
exactly this second caller. `evaluateSite` itself calls the extracted
function now instead of the code that used to be inlined in it; every
existing unit and integration test for the direct delivery path still passes
unmodified, which is what proves the extraction changed nothing observable.
5g-1's validator calls the same function, pointed at its own isolated
`siteRoot` — one implementation, two callers, and 5g-1 has no idea what
`evaluateSite` does with the result any more than `evaluateSite` knows 5g-1
exists.

**The workspace is genuinely disposable, not merely unaccepted.** A fresh
directory is created with `mkdtemp(join(deps.validationWorkspacesRoot,
`${job._id}-attempt${job.attempt}-`))` for every call — never reused across
calls, never the same path twice — and a `ProjectWorkspace` is opened at it
(reusing its existing `safeSitePath`/`writeSiteFiles`/`PathEscapesWorkspace`
path-safety exactly as-is, not a second implementation of the same guard).
`scaffoldSite` and `writeSiteFiles` populate it; `.commit()` is never called
on it, so it never becomes a git-tracked history the way a real
`ProjectWorkspace` is. The directory is removed in `finally` — on a pass, on
a deterministic fail, and on a thrown platform error alike — so nothing
disposable survives a call under any outcome.

**Deterministic failure is a result; only genuine platform failure throws.**
A build that does not compile, or a blocking gate finding, comes back as
`{ ok: false, compiled, gateRun, ... }` — never converted to an exception,
never silently retried. `compileSite`/`registry.resolve`/filesystem calls
throwing for real (a crashed build tool, an unresolvable artifact, no space
on the disposable root) propagate unconverted — not caught, not folded into
`ok: false` — because "the candidate failed" and "the tooling could not even
run" are different findings and this phase does not get to decide that a
crash means rejection.

**Nothing about the job, the candidate, or the canonical workspace changes,
on pass or on fail.** The validator receives no store and no engine, so it
cannot write to either even if it wanted to; a real Mongo-backed integration
test additionally re-reads the job document afterward and separately asserts
the exact same in-memory `JobDocument` object handed in is unchanged (deep
equality against a snapshot taken before the call) — not just "the database
still says validating," but "this function did not mutate its own
parameter." The staged candidate artifact's `acceptedAt` stays `null` on
both outcomes. No `registry.accept`, no `JobEngine.accept`, no
`requestRepair`, no model call of any kind — proven by a structural
boundary test (`frontend-backend-job-validation.test.ts`, in
`job-handlers-boundary.test.ts`'s own style) that reads this module's source
back and asserts none of `JobEngine`, `ModelClient`, `reviewSite`,
`deploySite`, `.accept(`, `.submitForValidation(`, `.requestRepair(`,
`.block(`, `.release(`, `.heartbeat(`, `.reclaimExpiredLeases(`, `.fail(`
appear in it at all.

**Legacy and adjacent-job candidates cannot be substituted for the real
one.** A job whose `executionOutputs` predates this field (genuinely
`undefined`, the same Phase 5f compatibility gap) fails closed exactly like
a `null` one. Another job's staged candidate, even under the *same* project,
is never reachable from a job whose own `executionOutputs` names something
else — the namespace check is what prevents it, not luck about artifact
names colliding. A newer version of the *same* artifact name, created after
the job reached `validating`, is not what gets validated — the exact
attached `(name, version)` is, pinned by a regression test that creates v2
after staging v1 and asserts v1's content is what reached the (faked) build
step.

**Result type, in-process only, nothing new persisted:**

    interface FrontendBackendCandidateValidation {
      readonly jobId: string;
      readonly attempt: number;
      readonly candidate: ArtifactRef;       // job.executionOutputs[0], never "latest"
      readonly ok: boolean;                  // compiled.ok && gateRun.passed
      readonly compiled: BuildResult;
      readonly gateRun: GateRun;             // reused from the extracted runDeterministicGates
    }

Not added to `@statxai/contracts` — no cross-package need for it is proven
yet, and the brief this shipped under says not to add one speculatively. A
`createFrontendBackendCandidateValidator(deps)` factory is also exported,
matching `createTerraFrontendBackendHandler`'s shape for whatever eventually
drives this per job, and does nothing 5g-1-specific beyond ensuring
`validationWorkspacesRoot` exists once rather than on every call.

**Files:** `packages/orchestrator/src/phases/evaluate.ts`
(`runDeterministicGates` extracted, `evaluateSite` calls it — pure refactor),
`packages/orchestrator/src/job-validation/frontend-backend.ts` (new),
`packages/orchestrator/src/index.ts` (export), plus
`packages/orchestrator/test/frontend-backend-job-validation.test.ts` (unit —
structural fail-closed checks and the boundary test) and
`packages/orchestrator/test/frontend-backend-job-validation.integration.test.ts`
(real Mongo, real `ArtifactRegistry`, real isolated filesystem workspace;
only the build pipeline itself — `compileSite`/`readBuiltFiles`/
`readExportFiles`/`runGates` — is faked, the same boundary
`delivery.parity.integration.test.ts` already fakes it at).

**Tests, end to end:** 484 unit, 194 integration, 678 total — up from 5f's
472 + 172 = 644 (+12 unit, +22 integration; the figure reported before the
pinned-input review was 484 + 193 = 677, +1 integration since). Typecheck and
lint both clean. Not claiming GitHub CI ran on this — it did not; these are
local results on an uncommitted working tree, per this phase's own
instruction not to commit.

**Mutation checks, run manually against `job-validation/frontend-backend.ts`,
each reverted after** (not part of the committed diff; kill counts are
"tests failed / tests run" for the file(s) actually exercised by that
mutation): exact-ref resolution replaced with `registry.get()`'s
latest-version form — covers both "resolve latest instead of exact
`executionOutputs` ref" and "choose newer candidate version instead of
attached older one," the same code path (2/21 integration); `job.attempt`
dropped from the namespace check (1/12 unit); `job._id` dropped from the
namespace check (1/12 unit); candidate resolved under a hardcoded wrong
project id (19/21 integration); a `running` job accepted by widening the
state check (1/12 unit); the role check removed entirely (1/12 unit, same
edit as the state-check widening above); `executionOutputs` null/undefined
silently defaulted to a guessed ref instead of failing closed (2/12 unit);
loss of per-call workspace isolation — `validationWorkspacesRoot` used
directly instead of a fresh `mkdtemp` subdirectory per call, the closest
expressible form of "use/write into a non-isolated, persistent workspace,"
since no canonical-workspace reference exists anywhere in this module to
mutate into use instead (8/21 integration, cascading `ENOENT`s once the
shared root was deleted out from under later tests — the isolation failure
made itself unmissable rather than merely wrong); `registry.accept`,
`.requestRepair(`, `ModelClient`, and a model-call reference inserted
together as dead code, to prove promotion/repair/review authority this
module never legitimately reaches would still be caught structurally if a
future edit ever added it (1/12 unit, the boundary test, one mutation
covering all four); the `CandidateShape.safeParse` check skipped, resolving
straight to a raw cast (1/21 integration); the `finally` cleanup removed
(8/21 integration — every isolation-cleanup test, plus every test whose own
assertions happen to include a temp-root emptiness check); the in-memory
`job` parameter mutated in place after resolution (`job.updatedAt`
reassigned) — caught only because the "job document is untouched" test was
strengthened during this phase to assert deep equality against a snapshot of
the exact object passed in, not merely the database record (1/21
integration). An eighteenth mutation, added during the pinned-input review
after the above were already run and reverted: `resolve()` replaced with
`get()`'s latest-version form on the `businessProfile`/`sitePlan` lookups
specifically, not the candidate's — killed by exactly the new
pinned-input test and nothing else (1/22 integration, once that test
existed). Every mutation attempted was killed by at least one test; none
were left in the tree — each was reverted and the resulting file diffed
clean against a backup before moving to the next.

**5g-1 does not accept the job.** **5g-1 does not accept the candidate
artifact.** **5g-1 does not promote output into the canonical workspace.**
**`runProject` still does not execute through `JobEngine`.** **No production
job is automatically enqueued yet.** **No production Luna handler is wired
yet.**

### Phase 5g-2 — atomic acceptance of the exact validated frontend/backend candidate — **DONE**

5g-1 produces evidence; it accepts nothing. 5g-2 is the separate, explicit
step that consumes *successful* evidence and, in one Mongo transaction,
accepts exactly the candidate artifact it describes and moves its job
`validating → accepted` — never both, never neither, never one without the
other.

**5g-1 stays read-only, unchanged in behaviour.** `validateFrontendBackendCandidate`
still does exactly what it did: pass → evidence, job stays `validating`; fail
→ evidence, job stays `validating`. What changed is its result's *shape*, not
its behaviour — extended (§5 of the brief this shipped under, which
explicitly authorised extending it in this same commit) with a `binding`
field:

    interface FrontendBackendValidationBinding {
      readonly projectId: string;
      readonly jobId: string;
      readonly attempt: number;
      readonly candidate: ArtifactRef;
      readonly businessProfile: ArtifactRef;
      readonly sitePlan: ArtifactRef;
    }
    interface FrontendBackendCandidateValidation {
      readonly binding: FrontendBackendValidationBinding;
      readonly ok: boolean;
      readonly compiled: BuildResult;
      readonly gateRun: GateRun;
    }

The previously-flat `jobId`/`attempt`/`candidate` fields moved into `binding`
alongside two new ones (`projectId`, `businessProfile`, `sitePlan`) rather
than staying duplicated at both levels — every existing 5g-1 test that read
them was updated to match the new shape; none had their assertions loosened
to do it.

**Transaction support, inspected before writing anything (§1).** `StateStore.withTransaction`
is the one canonical transaction owner in this repo — every `JobEngine`
mutation already opened its own via it, and `ArtifactRegistry.accept` and
`ArtifactRegistry.put` already accepted an optional `ClientSession` (`.put`
did; `.accept` did too, though nothing exercised it transactionally before
now). Conclusion: a shared atomic transaction across both is achievable with
small, additive session-propagation changes to existing methods — no new
transaction system, no nested transactions, exactly the brief's preferred
outcome. §2's "stop and report if impossible" branch was not needed.

**`JobEngine.accept` gained a guarded form, additively (§11–§13).** The
existing `accept(jobId, actor)` signature is unchanged in behaviour when
called exactly as before — every pre-5g-2 caller does, and stays exactly as
correct. A new optional third parameter,
`{ expectedAttempt?, expectedOutputs?, session? }`, is checked first for
all-or-nothing (`InvalidAcceptanceBinding` if only one of the pair is given,
before anything is read); when both are given, `accept` re-reads the job
fresh — inside the caller's own `session` when one is supplied, inside its
own transaction otherwise — and independently re-proves `state === 'validating'`,
`attempt === expectedAttempt`, and `executionOutputs` exactly equal to
`expectedOutputs` (compared field-by-field — `name`/`version`/`contentHash`
— rather than as a literal Mongo document/array match, which would have been
silently sensitive to BSON key order) before the guarded write, or throws
`JobAcceptanceBindingConflict`. `JobEngine` remains the sole owner of the
`validating → accepted` mutation and its audit event; no transition logic
was duplicated in the orchestrator.

**Session propagation, added exactly where it was missing (§14).** `JobEngine`'s
private `transition` helper (already shared by `accept`'s ungated form,
`requestRepair`, `block`, `release`, and `fail`'s validating branch) gained
an optional trailing `session` parameter: supplied, it runs directly against
that session and opens no transaction of its own; omitted, it opens its own,
byte-for-byte the pre-5g-2 behaviour. `ArtifactRegistry.accept` already had
session support; it was extended only to *report* whether anything matched
(`Promise<boolean>` instead of `Promise<void>` — every existing caller
already ignored the return value, so this is source-compatible), since a
`false` return is exactly the "the exact validated candidate no longer
exists" fault this phase needs to distinguish from a silent no-op success.

**The production acceptance function, `acceptValidatedFrontendBackendCandidate(validation, deps)`,
in `packages/orchestrator/src/job-acceptance/frontend-backend.ts`.** Deps are
`{ store: StateStore; registry: ArtifactRegistry; engine: JobEngine }` — no
`ProjectWorkspace`, no canonical `workspacesRoot`, no `ModelClient`, exactly
as 5g-1's own validator has none: "promote into the canonical workspace" and
"invoke a model" are not merely avoided by convention here, there is nothing
in scope that could reach either.

**Refuses forged or reconstructed evidence, checked before anything else.**
Reviewed and closed in this same uncommitted tree: nothing described above
proved the `FrontendBackendCandidateValidation` object handed to acceptance
was ever actually produced by the real validator — a hand-built object with
a correct-looking, currently-matching `binding` and `ok: true` would have
sailed through every check that follows, since all of them test whether the
*content* is current, never whether the *object* is genuine. Closed with the
smallest mechanism that fits an in-process handoff: a `WeakSet` in
`job-validation/frontend-backend.ts`. No persistence, no signature, no
database collection, no new job state — membership is keyed on object
identity alone, which is exactly what "these two functions are still in the
same process, in the same call" already guarantees and needs nothing more
to prove. This check is orthogonal to `assertBindingCurrent`'s: authenticity
says the evidence is real; the binding check says it is still current. An
authentic object can still describe a job that has since moved on, and both
must hold.

Three tests below construct real evidence and then tamper its `.binding`
*in place* (never by spreading a new top-level object) specifically so the
authenticity check stays satisfied and the test exercises the binding check
it was written for, not this one — spreading would have made every one of
them fail for the wrong reason once this check existed.

**Second review, same tree: the first version of this WeakSet registered
every result — pass or fail — and that was a real gap, not merely a
missed nicety.** It proved an object was genuinely the validator's own but
said nothing about whether its `ok` could still be trusted, and `readonly`
is a compile-time fiction: a genuinely failed result, mutated in place
afterward (`(validation as { ok: boolean }).ok = true`), was still the exact
object registered — same reference, so authenticity still passed, and then
`validation.ok` read `true`. The fix moved the registration itself: only a
*passing* result — `if (result.ok) AUTHENTIC_SUCCESSFUL_VALIDATIONS.add(result)`
— is ever a member; a failed result is never registered at all, so no
runtime mutation of any field on it after the fact can retroactively make it
one. The decision is made exactly once, from the value `ok` actually held
the moment deterministic validation finished, not from whatever it says if
read again later. The checker was renamed to match —
`isAuthenticSuccessfulFrontendBackendValidation(value: unknown): value is SuccessfulFrontendBackendCandidateValidation`,
a proper type guard narrowing to a new exported type
(`FrontendBackendCandidateValidation & { readonly ok: true }`) — and it is
now the *only* gate in `acceptValidatedFrontendBackendCandidate`: the
separate `if (!validation.ok)` check that used to follow it was deleted as
dead code, since nothing reaching that point can have `ok` false by
construction any more. `AcceptanceRequiresSuccessfulValidation` was removed
with it; `AcceptanceEvidenceNotAuthentic` now covers every way evidence can
fail to be an authenticated pass — forged, cloned, a genuine fail, or a
genuine fail mutated after the fact — deliberately as one check and one
error, since all four are indistinguishable once evidence stops being
trustworthy on its own terms. `Object.freeze` was considered and
deliberately not applied: it would have blocked the established
in-place-`.binding`-tamper test technique used across five existing tests
without restoring a way to construct "authentic evidence, deliberately
stale binding," and the pass-only registry alone already gives the property
that matters — proven directly by a test that mutates `ok` and lets the
runtime permit it, precisely to exercise the registry rather than a freeze
guard.

**Refuses non-evidence outright.** `validation.ok !== true` throws
`AcceptanceRequiresSuccessfulValidation` before any store, registry, or
engine call — checked first, unconditionally (after authenticity).

**Re-proves the complete binding, fresh, inside the transaction (§6–§9, §16).**
A cheap, read-only pre-check (outside any transaction, permitted explicitly
by §16) exists only to make an exact replay of an already-accepted job safe
(below); every other path falls through to one Mongo transaction that reads
the job *again*, inside the session, and independently checks — before
either write — `projectId`, `role`, `state`, `attempt`, the candidate's
namespace (via Phase 5f's own `jobOutputNamespace`, not a second
implementation), the exact `executionOutputs` ref, and both pinned inputs
(`businessProfile`, `sitePlan`) against the job's own `spec.inputs`, all via
exact `ArtifactRef` field equality — never resolved by "latest," never
inferred from the candidate's own contents. Any mismatch throws
`AcceptanceBindingStale` with a `reason` naming which fact moved first — not
necessarily the only one that did.

**Only the exact validated candidate version is ever accepted.** `ArtifactRegistry.accept`
is called once, addressed by the binding's exact `(projectId, name, version)`
— never `get()`'s latest form, never every artifact under the attempt's
namespace. Its `false` return (no document matched that exact identity) is a
platform/data-integrity fault, `AcceptanceCandidateMissing` — never converted
to a silent no-op, never a search for a substitute.

**One shared transaction, proven, not assumed.** The central operation is:

    return deps.store.withTransaction(async (session) => {
      const currentJob = await deps.store.jobs.findOne({ _id: binding.jobId }, { session });
      assertBindingCurrent(currentJob, binding);           // fails closed, throws
      const accepted = await deps.registry.accept(currentJob.projectId, binding.candidate, session);
      if (!accepted) throw new AcceptanceCandidateMissing(...);
      const acceptedJob = await deps.engine.accept(binding.jobId, ACCEPTANCE_ACTOR, {
        expectedAttempt: binding.attempt,
        expectedOutputs: [binding.candidate],
        session,
      });
      return { jobId: acceptedJob._id, attempt: acceptedJob.attempt, candidate: binding.candidate, state: 'accepted' };
    });

Proven, not merely inspected: one test spies on both `registry.accept` and
`engine.accept` and asserts the exact same `ClientSession` object reached
both — but that alone only proves what was *passed*, not what the callee
*did* with it, so a second, sharper test lets the real `engine.accept`
genuinely run (via a spy that calls through before throwing) and then forces
a failure immediately after — proving the job write itself is undone when
the transaction aborts, not merely that a session argument was accepted. Two
further tests force `engine.accept` and `registry.accept` to fail in turn
(fully mocked, no pass-through) and prove the other side's already-applied
write rolls back too, with zero accepted-transition audit surviving either
way.

**Acceptance actor is fixed, never inherited.** `ACCEPTANCE_ACTOR = 'harness:validator'`
— the same literal every generic `JobEngine.accept` test in this repo
already used before 5g-2 existed. Never `sol`/`terra`/`luna`, and never the
original build execution's `workerId`: this module receives no worker
identity at all to inherit one from even if it wanted to.

**Idempotent replay, implemented lightly (§22).** Before opening the
transaction, if the job is already `accepted`, its binding and its
candidate's `acceptedAt` are checked for consistency with the validation
evidence; if they agree, the same success result is returned with no second
transition, no second audit event, no second artifact write.
Disagreement — an accepted job whose exact candidate is somehow still
unaccepted, or whose binding no longer matches — is reported as
`AcceptanceInconsistentState`, never silently repaired.

**Files:** `packages/orchestrator/src/job-acceptance/frontend-backend.ts`
(new), `packages/orchestrator/src/job-validation/frontend-backend.ts`
(`binding` extension), `packages/orchestrator/src/index.ts` (export),
`packages/job-engine/src/engine.ts` (`accept`'s guarded form,
`JobAcceptanceBindingConflict`, `InvalidAcceptanceBinding`, `transition`'s
optional `session`), `packages/workspace/src/registry.ts` (`accept` returns
`Promise<boolean>`), plus `packages/job-engine/test/engine.test.ts` (a new
"guarded acceptance" suite, 6 tests, exercising the extension directly and
independently of the orchestrator), `packages/orchestrator/test/frontend-backend-job-validation.integration.test.ts`
(assertions updated for the `binding` shape — behaviour unchanged),
`packages/orchestrator/test/frontend-backend-job-acceptance.test.ts` (unit —
the `validation.ok` gate and the structural boundary test) and
`packages/orchestrator/test/frontend-backend-job-acceptance.integration.test.ts`
(real Mongo transactions throughout — this is the one phase in this series
where a mocked driver genuinely could not stand in for the property being
proven).

**Tests, end to end:** 487 unit, 228 integration, 715 total — up from 5g-1's
484 + 194 = 678 (+3 unit, +34 integration: 28 in the acceptance integration
suite — 25 from the initial pass, +2 for the forged-pass and cloned-evidence
authenticity tests, +1 for the mutated-fail-to-pass regression test added in
the second, pass-only-registry review — plus 6 in engine.test.ts's
guarded-acceptance suite; the frontend-backend-job-validation.integration.test.ts
count is unchanged since its assertions were edited, not added to).
Typecheck and lint both clean. Not claiming GitHub CI ran on this — it did
not; these are local results on an uncommitted working tree, per this
phase's own instruction not to commit.

**Mutation checks, run manually against `job-acceptance/frontend-backend.ts`,
`job-engine/engine.ts`, and `workspace/registry.ts`, each reverted after**
(not part of the committed diff; kill counts are "tests failed / tests run"
for the file(s) actually exercised): (1) `validation.ok === false` accepted
by deleting the guard — killed at both layers, the fake-deps unit test (1/2)
and the real-evidence integration test (1/25); (2) the transactional job
reread skipped, trusting the binding directly — 9/21 (run before two tests
below existed; the redundant checks it also silently removed are covered
individually next); (3) attempt mismatch ignored — 0/21 against the existing
suite alone, because `jobOutputNamespace` is a pure function of attempt, so
any attempt divergence reachable through real engine transitions is always
also a namespace divergence; closed with a dedicated test constructing a
binding whose declared attempt disagrees with its own still-correctly-
namespaced candidate, isolating the check — 1/22 once that test existed; (4)
executionOutputs mismatch ignored — 3/21; (5) businessProfile binding
mismatch ignored — 1/22; (6) sitePlan binding mismatch ignored — 0/22
against the existing suite (no test yet covered sitePlan specifically,
mirroring businessProfile's own coverage exactly), 1/23 once a dedicated
sitePlan-changed test was added, mirroring the businessProfile one; (7)
latest candidate version accepted instead of the exact validated ref — 8/23;
(8) whole attempt namespace accepted instead of the one exact ref — 3/23;
(9) validation result's `projectId` used without comparing the current job's
— 0/23 against the existing suite (every constructed cross-job/cross-project
scenario also trips the namespace or outputs check first), 1/24 once a
dedicated test held every other binding field genuinely consistent with the
real job and varied only `projectId`; (10) artifact acceptance performed
outside the transaction (session dropped from that one call) — 2/24, the
rollback test and the shared-session identity test; (11) `JobEngine.accept`
performed outside the transaction (session dropped from that one call) —
0/24 against the existing suite, because `JobEngine.accept` without a
session still opens its *own* transaction and still aborts when the
caller's own transaction later fails for an unrelated reason in the same
callback, so the *outer* rollback still empties the *inner* one by
coincidence in every scenario those tests construct; caught only by the
shared-session identity test (1/24, since it inspects what was passed, not
what ran) and, more sharply, by a dedicated call-through-then-fail test
added specifically to distinguish "session accepted" from "session used" —
1/25 at the orchestrator layer, and independently 1/61 at `engine.test.ts`
itself once the equivalent direct test was added there too; (12) shared-
session propagation removed from `ArtifactRegistry.accept` itself (session
parameter ignored) — 1/24, the rollback test, since the write now commits
immediately instead of participating in the caller's transaction; (13)
shared-session propagation removed from `JobEngine`'s guarded `accept`
itself — see (11), same mutation, same two precise kills; (14) state-only
`validating → accepted` used by omitting `expectedAttempt`/`expectedOutputs`
from the orchestrator's own call — 0/25 behaviourally, for the same
redundancy reason as (3): the orchestrator's own binding check, performed
moments earlier in the same transaction, already guarantees nothing could
have changed; closed with a structural test (in the unit suite) asserting
the source's one `deps.engine.accept(` call literally contains both option
names — 1/3 unit, since no behavioural test can see this one; (15) artifact
accepted but a failed job transition silently swallowed (wrapped in
try/catch, falling back to the pre-transition job) — 2/25; (16) job
transitioned to accepted but artifact acceptance skipped entirely — 7/25;
(17) acceptance actor changed to `'sol'` — 1/25, the happy-path test's own
actor assertion; (18) acceptance actor changed to a hardcoded Terra
`workerId` — 1/25, same assertion; (19–20) candidate promoted into the
canonical workspace / repair invoked on validation failure — not
independently expressible as a reachable code-path mutation, since the
module holds no canonical-workspace or repair-capable dependency to promote
or invoke through at all; demonstrated instead, as in 5g-1's equivalent
case, by inserting the literal forbidden calls as dead code and confirming
the structural boundary test catches all three markers
(`ProjectWorkspace`/`.commit(`/`.requestRepair(`) in one shot — 1/3 unit.
Every mutation attempted was killed by at least one test, once the two
genuine coverage gaps mutations (6) and (9) surfaced were closed with
dedicated tests rather than left as unexplained zero-kill results; none were
left in the tree — each was reverted and the resulting file diffed clean
against a backup before moving to the next.

**A 21st mutation, added during the evidence-authenticity review after the
above were already run and reverted:** the `isAuthenticFrontendBackendValidation`
check deleted from `acceptValidatedFrontendBackendCandidate`, falling
straight through to the `validation.ok` check as before this review. Killed
by exactly three tests and nothing else — the forged-pass test (a
hand-constructed `{ ok: true, ...correct binding }` object, directly, as
required), the cloned-evidence test (`JSON.parse(JSON.stringify(real))`),
and the unit-level hand-built-object test — 3/27 integration + 1/3 unit.
Every other test in both suites stayed green, confirming the check's removal
is invisible to everything that isn't specifically testing authenticity —
exactly the property a correctly-scoped addition should have. Reverted and
diffed clean against a backup, same as every other mutation in this phase.
(`isAuthenticFrontendBackendValidation` was the checker's name at the time;
the second review below renamed and narrowed it.)

**A 22nd mutation, added during the second (pass-only-registry) review,
after the fix above:** the registration guard —

    if (result.ok) {
      AUTHENTIC_SUCCESSFUL_VALIDATIONS.add(result);
    }

— changed to register unconditionally (`if (true) { ... }`), restoring the
exact gap the review found: a failed result registered anyway, so mutating
its `ok` field afterward would again read as an authenticated pass. Killed
by exactly two tests: `'failed validation cannot accept'`'s own real-fail
assertion, and — the one the review specifically required —
`'a real FAIL result cannot be turned into acceptable evidence by mutating
its own ok field, even if the runtime permits it'` — 2/28 integration.
Every other test, including the forged-pass and cloned-evidence tests from
the first review, stayed green: this mutation only reopens the
pass-vs-fail-registration gap, nothing else. Reverted and diffed clean
against a backup.

**Third review, same tree: proving the result *object* was authentic still
was not enough, because acceptance kept reading `validation.binding` — the
same public, mutable field a caller holds a reference to — for every
authority decision.** This was the serious one: `assertBindingCurrent`
never checked whether the *object* was genuine, only whether its *binding*
matched the live job — so mutating `result.binding` in place to describe a
different candidate, after the fact, changed what every check compared
against. If the live job had also (legitimately) moved on to describe that
same candidate by the time acceptance ran, every check would agree with the
tampered binding, and a candidate 5g-1 never actually ran deterministic
validation against would be accepted. The `WeakSet` — which only ever
recorded "is this the real object," never "does its binding still say what
was actually validated" — could not have caught this by construction,
regardless of which version of it was in place.

Fixed by replacing the `WeakSet` with a `WeakMap<object, FrontendBackendValidationBinding>`:
what it stores per result is not a bare membership flag but an independent
*snapshot* of the binding, cloned field-by-field — including fresh
`ArtifactRef` objects, not shared references — at the exact moment
deterministic validation passed, into objects the public `result.binding`
never points at and no caller outside `job-validation/frontend-backend.ts`
ever sees. `authenticSuccessfulValidationBinding(value: unknown): FrontendBackendValidationBinding | null`
is the only way to retrieve it, and `acceptValidatedFrontendBackendCandidate`
uses *only* what it returns for every authority decision from that point on
— it does not read `validation.binding` again for anything but composing
the one error message when the lookup itself fails. Mutating the public
field is now provably inert: it cannot change which job gets looked up,
which candidate gets checked, or what any comparison is checked against,
because none of those ever consult it again.

`Object.freeze` was considered again here too and again set aside for the
*public* binding, for the same reason as the second review — it would have
broken the established in-place-tamper test technique with no full
replacement for "authentic evidence, deliberately stale binding." The
*private* snapshot, by contrast, is frozen (`Object.freeze` on the snapshot
and on each cloned `ArtifactRef` inside it): nothing outside this module
ever holds a reference to it to mutate in the first place, so freezing it
costs nothing and closes the mutation path on the one copy that actually
matters.

Five existing tests that tampered `validation.binding` in place to prove a
mismatch, expecting rejection, needed to change: with the public field no
longer read for anything, tampering it to redirect acceptance toward
another job or project no longer causes rejection — it causes acceptance to
correctly ignore the tampering and proceed against the *original*, real
binding instead, which is the stronger and now-correct property to assert.
Two ("another job's candidate," "another project") were rewritten to prove
exactly that: mutate the public binding to name a different job, and
acceptance still resolves and accepts only the original. Two more
(the attempt-only and projectId-only isolation tests) moved their tamper
from the evidence to the live job document instead, via the same raw
`store.jobs.updateOne` technique already used elsewhere for anomalies no
real engine call can produce, since isolating one field of an
*unreachable-to-tamper* binding no longer means anything at the evidence
layer. The "candidate missing" test's construction — a namespaced-but-never-written
ref simultaneously written into both the job's `executionOutputs` and the
evidence's binding — could no longer reach the evidence side at all, and
turned out to describe something now structurally impossible anyway: the
private snapshot can only ever name an artifact that `validateFrontendBackendCandidate`
itself already resolved successfully, and artifacts in this repo are
immutable and never deleted, so a genuine snapshot's candidate cannot later
stop existing. Rewritten to exercise the exact code path directly — `registry.accept`
reporting no match, via a one-call mock — the same platform/data-integrity
fault the error exists for, without fabricating a data shape genuine
evidence could never actually have. A sixth test, "validation result cannot
be mixed," was retired outright: its distinguishing construction (a
same-namespace orphan substituted for the real candidate) became
indistinguishable, once tamper had to move to the job, from the existing
"executionOutputs changed after validation" test — keeping both would have
meant one was a byte-for-byte duplicate of the other.

The mandatory regression test proves the full attack directly: candidate A
passes 5g-1; the job then *legitimately* advances — attempt 1 fails for
real, is reclaimed, and attempt 2 stages and submits an entirely different
candidate B, so the job's current state is exactly what a real retry
produces, not a fabrication; the public `.binding` on A's original result is
then mutated to describe that same attempt/candidate B, so the public field
agrees with the live job perfectly. Acceptance still rejects it
(`AcceptanceBindingStale`), because the private snapshot behind it still
says attempt 1 / candidate A, and that is what gets checked against the live
job instead — B is a candidate 5g-1 never ran deterministic validation
against, and it is confirmed to remain unaccepted, alongside A, with the job
still validating and no accepted audit.

**A 23rd mutation, added during this third review, mandated directly:**
`acceptValidatedFrontendBackendCandidate` changed to still call
`authenticSuccessfulValidationBinding` for its existence check but then use
`validation.binding` — the public field — for the `binding` variable every
later check actually reads, restoring exactly the bug this review found.
Killed by three tests: the mandatory provenance-attack regression test
itself, and the two rewritten "another job"/"another project" tests whose
entire point is that tampering the public field is inert — with the bug
reintroduced, tampering it redirects acceptance again, which those two now
correctly flag as a failure. 3/28 integration. Every other test, including
every other test added or touched by the first two reviews, stayed green.
Reverted and diffed clean against a backup.

**Net test count is unchanged by this review — 487 unit, 228 integration,
715 total — despite five tests being substantially rewritten and one
retired:** the acceptance integration suite lost one test ("validation
result cannot be mixed," retired as a now-exact duplicate of "executionOutputs
changed after validation") and gained one (the provenance-attack regression
test above), holding its own count at 28.

**5g-2 does not promote the candidate into the canonical workspace.** **5g-2
does not rerun deterministic validation.** **`runProject` still does not
execute through `JobEngine`.** **No production job is automatically enqueued
yet.** **No production Luna handler is wired yet.**

### Phase 5h — replay-safe canonical promotion of one accepted frontend/backend candidate — **DONE**

5g-2 accepts a candidate — `ArtifactRegistry.accept` plus `validating →
accepted`, atomically — but never touches the canonical project workspace at
all. 5h is the separate, explicit step that takes an already-accepted job's
exact execution output and materialises it into the canonical workspace, as
one Git commit, and does so in a way that survives a crash at any point and
is safe to retry indefinitely.

**Production entry point.** `promoteAcceptedFrontendBackendCandidate(jobId,
deps)` in `packages/orchestrator/src/job-promotion/frontend-backend.ts`, with

    interface FrontendBackendPromotionDeps {
      readonly store: StateStore;
      readonly registry: ArtifactRegistry;
      readonly workspacesRoot: string;
    }
    interface FrontendBackendPromotionResult {
      readonly jobId: string;
      readonly attempt: number;
      readonly candidate: ArtifactRef;
      readonly promotionId: string;
      readonly commitSha: string;
    }

No `ModelClient`, `JobRunner`, Terra, Sol, Luna, or deployment dependency —
confirmed both by the module never importing any of them and by a dedicated
structural test (below) that greps the module source for the forbidden names
and forbidden method calls.

**Deliberately does not depend on 5g-1's evidence (§2).** 5g-1's
`AUTHENTIC_SUCCESSFUL_VALIDATIONS` `WeakMap` is process-local and gone the
moment that process exits; 5h never imports or references it. Everything 5h
needs comes from durable state alone — the accepted `JobDocument` and its
already-accepted candidate artifact — so promotion works identically whether
it runs a second after acceptance or after a full process restart days
later. This is also why every integration test's fixture (`stageAcceptedJob`)
builds its accepted job via raw `JobEngine`/`ArtifactRegistry` calls rather
than by running 5g-1/5g-2 first: 5h's own correctness must not depend on
having run through them in the same process.

**Authoritative job resolution, before any canonical mutation (§4).** `jobId`
is re-read fresh from `store.jobs` on every call — never a caller-supplied
`JobDocument` — and must satisfy, in order: exists (`PromotionJobNotFound`);
`role === 'frontend_backend'` (`PromotionRoleMismatch`); `state === 'accepted'`
(`PromotionStateMismatch` — `validating`, `running`, and `failed` are all
refused, with a dedicated test for each); `executionOutputs` present and
non-empty (`PromotionMissingOutputs`); exactly one ref, never narrowed from
more (`PromotionOutputCountMismatch`); that ref namespaced under this exact
job and attempt via the existing Phase 5f `jobOutputNamespace(jobId, attempt)`
(`PromotionNamespaceMismatch` — covers both "wrong attempt of this job" and
"another job's output" as the same check). The ref is then resolved via a new
`ArtifactRegistry.getDocument(projectId, ref)` (§6) — project-scoped, exact
`(name, version)`, never "latest," added because `resolve`/`get` only return
`.data` and discard the `acceptedAt` metadata this module needs — and must
resolve (`PromotionCandidateMissing`) and be accepted
(`doc.acceptedAt !== null`, else `PromotionCandidateNotAccepted` — §7, 5h
does not repair or re-accept). Its payload is then parsed with the *existing*
`CandidateShape` (exported from `job-validation/frontend-backend.ts`
specifically for this reuse — §8, no new schema, no revalidation of the
build or gates) into a `PromotionCandidateShapeInvalid` on failure.

**Deterministic promotion identity (§12–§13).** `computePromotionId` hashes
`{ projectId, jobId, attempt, outputName, outputVersion, outputContentHash }`
through the *existing* `contentHash` (`@statxai/workspace`) — the same
canonical-JSON SHA-256 `ArtifactRegistry.put` already hashes artifact content
with, not a second hashing scheme. No `createdAt`, no `lineageSeq`, no
random id, no filesystem path — mutation-tested directly (below).

**Durable receipt: a new `promotions` collection (§11, §15).**
`JobPromotionRecord` in `packages/state/src/documents.ts` —
`{ _id, projectId, jobId, attempt, output, baseCommit, status: 'prepared' |
'committed', commitSha, createdAt, updatedAt }` — stored via a new
`StateStore.promotions` getter (`job_promotions` collection). Two indexes,
added in `ensureIndexes()`: a **partial unique index on `{ projectId: 1 }`
filtered to `status: 'prepared'`** — the same "partial unique index"
technique this repository already uses for `artifacts`' `lineageSeq`
uniqueness, reused rather than reinvented, and the entire mechanism behind
project-scoped promotion serialization (§15's "no new lock service"); and a
plain `{ projectId: 1, jobId: 1 }` index for lookup. No new `JobState`, no
field added to `JobSpec` (§11).

**Distinguishing a self-race from a blocked concurrent promotion (§15).**
On the unique-index `E11000` from `insertOne`, the code does not parse
`error.keyPattern` — instead it re-reads `findOne({ _id: promotionId })`:
found means this exact promotion raced with itself and the existing record is
recovered and validated; not found means the partial project-scoped index
blocked a *different* in-progress promotion, and `PromotionInProgress` is
thrown. Simpler and driver-shape-independent.

**Recovered/racing records are never trusted blindly
(`assertRecordMatchesBinding`).** Every field the current binding cares about
— `projectId`, `jobId`, `attempt`, `output.name`, `output.version` — is
checked against any record found under the same `_id`, and a `committed`
record with no `commitSha` is rejected too; any mismatch is
`PromotionReceiptCorrupt`, never silently repaired. Two distinct corruption
shapes are mutation-tested and each has its own dedicated regression test —
see below.

**The Git marker (§18).** Exactly

    Promote accepted frontend/backend candidate

    Statx-Promotion-Id: <promotionId>

as the commit message, with the second line required to appear *verbatim, on
its own line* — not merely as a substring anywhere in the message.

**Exact marker search, full history, no HEAD dependency (§19, §26).** A new
`ProjectWorkspace.findCommitByMarker(marker)` — `git log --all --format=%H\x01%B\x02`
(`\x01`/`\x02` chosen as field/entry separators because a real commit message
containing either is not a byte sequence any commit, this repo's own or a
plausible unrelated one, would ever produce), then each entry's message is
split on newlines and each line trimmed and compared for **exact equality**
to the marker — never `.includes()`. `--all`, not merely `HEAD`, deliberately:
a promotion commit that a later, unrelated canonical commit has since been
built on top of is still found (§26's "may become an ancestor" — it is never
required to stay `HEAD`, and this lookup never changes which commit *is*
`HEAD`).

**The crash/replay state machine (§20–§27), all in one function body, no
Mongo transaction (§10):**

  - **A.** Resolve and prove the accepted job/candidate (above).
  - **B.** Find-or-create the durable `prepared` record; `baseCommit` is
    canonical `HEAD` *at this moment* — `null` is a valid, correctly-handled
    first-build base, not a placeholder (dedicated test).
  - **C.** Search the *whole* of canonical history for a commit carrying this
    exact promotion's marker.
  - **D1. Found:** verify it agrees with the record (or the record's own
    `commitSha`, if already `committed`), finalise Mongo to `committed` if it
    was still `prepared`, and return — **no second commit is ever created.**
    This is what makes "Git commit succeeded, process died before Mongo
    finalised" (§21's most-important scenario) recoverable: the commit itself
    is the evidence, and this is exactly where a retry finds it.
  - **D2. Not found:** verify canonical `HEAD` still equals the record's
    `baseCommit` — else `PromotionBaseConflict`, fail closed, no silent
    rebase (§16, §27) — then materialise the exact candidate (idempotent:
    `scaffoldSite` never overwrites existing files, and `writeSiteFiles`
    writing the same accepted candidate again is a no-op if some of it is
    already on disk from a prior crashed attempt — §22's scenario) and commit
    once with the marker.
  - **E.** Finalise the record to `committed` with the commit this attempt
    just created.

Once `committed` and the marker is found, calling this again is a pure
read-and-verify — same promotion id, same record, same marker, same result —
no new commit, no new record, no touch to job or artifact-acceptance state
(§23's replay scenario).

**No Mongo transaction spans Mongo, the filesystem, and Git, and none is
pretended (§10).** Every durable write is a single-document Mongo operation,
already atomic on its own (`insertOne` with unique-index conflict detection,
or `findOneAndUpdate`); cross-system consistency comes from the state machine
above plus the Git marker as recovery evidence, not from a distributed
transaction spanning three different systems. **Once a Git commit succeeds,
it is never `git reset --hard`'d away on a later Mongo failure** — confirmed
by a dedicated structural test (below) and by the mandatory crash test:
Mongo's `findOneAndUpdate` is made to throw *after* a real `scaffoldSite` +
`writeSiteFiles` + `commit()` has already produced a real commit with the
real marker; the failure is required to propagate (a swallow-and-report-success
mutation was tried and killed — see the mutation-testing table below), and a
second, unmocked call is required to discover the existing commit via
`findCommitByMarker` and finalise onto it, without creating a duplicate.

**Reused, not duplicated, canonical-write primitives (§9, §35).**
`ProjectWorkspace.writeSiteFiles`/`.commit`/`scaffoldSite` — the same
underlying primitives `buildFromPlan`'s direct path already uses via
`publishBuildDirectly` — are called directly by the promotion module.
`packages/orchestrator/src/phases/build.ts` (`publishBuildDirectly`,
`runProject`) is **not touched at all** — the strongest possible proof that
the direct delivery path's behaviour is unchanged is that the file was never
edited, confirmed by the full, unmodified `refusal`/`delivery.parity`
integration suites staying green throughout (§59's direct-path regression
requirement).

**Explicit, stated assumption (per the brief's own requirement not to hide
one):** the canonical workspace is exclusively harness-owned for the
duration of a `prepared` promotion — the same assumption every other
canonical writer in this repository already makes, written into the code
comment above the materialisation step rather than left implicit.

**Structural boundary self-scan (recurring pattern, §67).** The module's own
doc comment originally described 5g-2 as running "a `JobEngine` audit,"
which the new `'does not import JobEngine'` structural test's `/JobEngine/`
regex would have flagged as a false positive on its own prose — caught and
reworded ("its own lifecycle audit") before the test was ever run, the same
class of self-matching issue that has recurred in most Phase 5 slices.

**Tests — 30 new, 746 total (up from 715 at the close of 5g-2), all
green: 490 unit (+3), 256 integration (+27).**

- `frontend-backend-job-promotion.test.ts` (3, unit/structural, no Mongo): the
  module imports none of `ModelClient`/`reviewSite`/`deploySite`/`DeployResult`/
  `hosting_release`/`runDeterministicGates`/`evaluateSite`/`routeBuild`/
  `buildAnchor`/`buildPage`/`repairDefect`, and calls none of
  `.accept(`/`.submitForValidation(`/`.requestRepair(`/`.block(`/`.release(`/
  `.claim(`/`.heartbeat(`; the module never imports `JobEngine`; the module
  never uses `'reset'`/`--hard` as post-failure compensation.
- `frontend-backend-job-promotion.integration.test.ts` (27, real Mongo +
  real temp Git workspace, no build pipeline faked — promotion never
  compiles/gates/reviews anything, so every dependency is real): the happy
  path (first, null-base commit); exact ref promoted even after a newer,
  unaccepted version of the same candidate name exists; candidate-must-be-accepted
  fails before any canonical mutation; wrong job state (`validating`,
  `running`, `failed`, each its own case) and nonexistent job; wrong role;
  output-count mismatch (more than one `executionOutputs` ref is refused, not
  narrowed to the first); wrong attempt namespace; another job's output;
  another project (resolution is scoped through `job.projectId` alone);
  malformed accepted candidate; file path traversal safety; replay after
  `prepared`/before any file write; replay after partial file materialisation;
  **the mandatory crash-after-Git-commit-before-Mongo-finalize scenario**;
  exact completed replay is idempotent; prepared base-commit conflict (a
  legitimate canonical write lands in between, `HEAD` is never mutated by the
  failed retry); a promotion commit may become an ancestor of later, unrelated
  canonical commits without ever being rewound to or requiring it stay `HEAD`;
  a second, different job's promotion for the same project is refused while
  the first is still `prepared`; a `committed` receipt whose binding
  disagrees with the real job; a `committed` receipt whose binding matches
  exactly but whose marker is nowhere in history; a `prepared` receipt whose
  binding partially disagrees (matching `_id`, mismatched `attempt`); exact
  Git marker matching (a decoy commit merely mentioning the marker text
  inline, not as its own line, is ignored); job/candidate acceptance state is
  provably unchanged (full deep-equal of both documents, not just the fields
  promotion happens to read); no repair/deployment/model side effect.
- `packages/workspace/test/workspace.test.ts` gained one new test
  (`commit marker lookup`) proving `findCommitByMarker` exact-line matching
  directly against a decoy commit whose message embeds the marker text only
  as a substring within a longer line.

**Mutation testing — 20 mutations applied one at a time to the production
promotion module (plus one to `ProjectWorkspace.findCommitByMarker`), each
backed up first and restored after, diffed clean at the end. 17 killed
outright by the existing suite; 3 exposed real gaps, each closed with a new,
dedicated regression test confirmed to kill the same mutation on replay:**

1. Resolving the wrong artifact version (not the exact pinned ref) — killed,
   16 integration failures.
2. Skipping the "candidate must be accepted" check — killed by the dedicated
   §39 test.
3. Allowing `job.state === 'validating'` to promote — killed by the wrong-job-state
   test (via a different exception type, still a real failure).
4. Skipping the attempt/namespace check entirely — killed, 2 integration
   failures.
5. **Skipping the output-count check (silently taking the first of several
   refs) — survived. Gap: no existing test staged a job with more than one
   `executionOutputs` ref.** Closed with the new "output count mismatch"
   test; re-run confirmed the kill.
6. Using the job's own id instead of `job.projectId` to resolve the candidate
   — killed, 16 integration failures.
7. A non-deterministic (`Math.random`) promotion id — killed, 6 integration
   failures (idempotent replay, ancestor, crash-recovery, corrupt-receipt, and
   others all depend on the id being stable across calls).
8. Omitting the candidate's own identity from the promotion-id hash (keeping
   only `projectId`/`jobId`/`attempt`) — killed via the corrupt-committed-receipt
   test's precomputed colliding id, which depends on the exact hash formula.
9. The commit marker omitting the promotion id (a generic, non-identifying
   marker) — killed, 6 integration failures.
10. **`findCommitByMarker` doing substring matching (`.includes`) instead of
    exact-line matching — survived against the promotion suite's existing
    marker test, because that test's decoy embedded a *different* id as a
    substring, not the real one. Gap: no test proved a marker that legitimately
    appears, but only inline within a longer line, is rejected.** Closed with
    the new `commit marker lookup` test in `workspace.test.ts`; re-run
    confirmed the kill.
11. Ignoring a found marker and always re-materialising/re-committing (second
    commit on retry after success) — killed, 4 integration failures.
12. Skipping the base-commit conflict check entirely — killed by the dedicated
    "prepared base commit conflict" test.
13. Treating every duplicate-key error as a self-race, never as
    `PromotionInProgress` — killed by the "cannot race" test.
14. **`assertRecordMatchesBinding` reduced to a no-op — survived against the
    existing "corrupt committed receipt" test, because that test's decoy has
    a mismatched `jobId`, which a *different*, later check (committed-with-no-marker)
    also happens to catch on its own. Gap: no test isolated the
    binding-mismatch check itself from that later check.** Closed with the
    new "prepared receipt binding mismatch" test (matching `_id`, correct
    `jobId`, mismatched `attempt`, status still `prepared` so the later check
    can't fire); re-run confirmed the kill.
15. Finalising Mongo to `committed` *before* the Git commit is attempted —
    killed, 5 integration failures.
16. **Skipping the "`committed` status but no marker found" check — survived
    against the full suite. Gap: the only existing decoy with `status:
    'committed'` had a mismatched `jobId` and was already caught earlier by
    `assertRecordMatchesBinding`, so this specific later check was never
    isolated.** Closed with the new "committed receipt with no matching
    commit" test (an exactly-matching binding, `status: 'committed'`, a
    plausible-looking but fake `commitSha`, no real commit anywhere); without
    the check, this mutation demonstrably let promotion silently create a
    second, unlinked commit and report success. Re-run confirmed the kill.
17. A spurious `registry.accept` call inside promotion — killed twice over:
    the unit/structural test's forbidden-call list, and the acceptance-unchanged
    integration test.
18. A stray write onto the job document (`{ promotedAt: ... }`) as a side
    effect — **survived against the original acceptance-unchanged test,
    which checked only the specific fields promotion is known to read, not
    the whole document.** Strengthened that test to a full deep-equal of
    both the job and artifact documents; re-run confirmed the kill.
19. Removing the "commit produced nothing" guard — killed by `tsc`, not the
    runtime suite (the guard's removal breaks `commitSha`'s `string | null`
    vs. `string` return type) — a legitimate catch, since typecheck is part
    of the required verification gate for every change in this repository.
20. Swallowing a Mongo finalize failure after a successful Git commit instead
    of surfacing it — killed by the mandatory crash test and the ancestor
    test, both of which require the failure to propagate.

**Phase 5h does not change `JobState`.** **Phase 5h does not rerun
deterministic validation.** **Phase 5h does not accept or re-accept the
candidate.** **Phase 5h does not deploy the canonical commit.**
**`runProject` still does not execute through `JobEngine`.** **No production
job is automatically enqueued yet.** **No production Luna handler is wired
yet.**

**Review, same tree: two promotion-safety invariants pinned explicitly.**

**First — the completion report's own phrase "project-scoped-unique
promotions collection" was imprecise enough to read as a *permanent* unique
index on `{ projectId: 1 }`, which would have meant a project could only
ever be promoted once. That was never the actual index — `store.ts`'s
`{ key: { projectId: 1 }, unique: true, partialFilterExpression: { status:
'prepared' } }` (documented correctly above, at "Durable receipt") only
enforces uniqueness while a promotion is `prepared`; a `committed` one
drops out of the filter and is invisible to it — but it was only checked
against the source and never against a real, live index, so the report's
prose was unverified.** Checked directly against the running replica set
(`db.job_promotions.getIndexes()`): the live index matches the source
exactly, filter and all. A dedicated regression test was still missing —
nothing proved a project could be promoted a *second* time after its first
promotion committed, only that a *second, concurrent* one is refused while
the first is still `prepared` ("different promotion for the same project
cannot race"). Added: "a project may be promoted again once the prior
promotion has committed" — job A for project P promotes fully to
`committed`; a different accepted job B for the same P then prepares and
commits its own receipt with no collision, A's historical `committed`
record is read back unchanged, and both commits' markers are found exactly
once each in canonical history. Uses the real, single production entry
point for both A and B rather than a separate mechanism for exercising
receipt allocation alone — the function has no partial/pausable form to
call instead, so this is the minimal way to prove the property.

**Second — a real gap: nothing characterised, let alone enforced, what
`ProjectWorkspace.commit()`'s `git add -A` actually stages.** It stages the
*whole* working tree, not merely what an attempt itself just wrote. Every
crash/replay/base-conflict test proves the receipt and the marker are
correct; none of them proved the working tree contained *only* what this
candidate was supposed to contribute. Given `HEAD` at the recorded base and
a tree that also happens to hold some unrelated uncommitted change, nothing
stopped that change from riding along into the promotion commit.

Two new `ProjectWorkspace` primitives (`packages/workspace/src/project-workspace.ts`):
`dirtyPaths()` — `git status --porcelain -z --untracked-files=all` (`-z` so
a path is never subject to git's own quoting; `--untracked-files=all` so a
wholly-new untracked directory, the ordinary case for `app/` on a project's
first-ever promotion, is reported file-by-file rather than collapsed into
one `app/` entry — the first version of this omitted that flag and every
first-build-shaped test failed against a false "app/ is unexpected," caught
immediately by the existing suite) — and `siteFileRepoPath(path)`, the same
containment-checked resolution `writeSiteFiles` already uses, exposed so a
caller can compare a candidate's site-relative paths against `dirtyPaths`'
repo-root-relative output.

The promotion module (`job-promotion/frontend-backend.ts`) uses both, plus a
new `scaffoldTemplatePaths()` (`packages/workspace/src/site-build.ts` — the
same recursive walk-and-filter `scaffoldSite`'s own `cp` runs internally,
factored out and exposed) to compute one closed set — this candidate's own
files, union the platform scaffold's own deterministic, never
model-influenced template output — and checks the tree's dirty paths are a
subset of it, **twice**: once before this attempt touches the tree at all
(catching a foreign change already sitting there — the review's exact
scenario), and once more after scaffolding and writing the candidate
(a consistency guard against the same class of problem from the other side,
not expected to ever actually fire, since nothing either call does can dirty
a path outside that set on its own). Either violation is
`PromotionWorkingTreeDirty`, thrown before any commit is attempted.

The first version of this check compared only against `candidate.files`,
without accounting for the scaffold's own legitimate output at all, and
failed nearly every existing test — including the established "replay after
partial file materialization" one, whose fixture (deliberately) leaves both
the scaffold's template tree *and* the candidate's own files dirty to
simulate a prior crashed attempt. That failure is what surfaced the need for
`scaffoldTemplatePaths()`: a snapshot-diff approach (dirty-before-scaffold
vs. dirty-after-scaffold, trusting whatever delta scaffolding itself
introduces) was considered and rejected — it cannot tell a foreign file
already dirty *before* scaffolding ran apart from the scaffold's own
legitimate contribution, since both would already be present in the
"before" baseline; only knowing scaffold's actual file set, independent of
when anything became dirty, closes that gap.

Two new tests in `frontend-backend-job-promotion.integration.test.ts`:
"unrelated dirty canonical file blocks promotion" (a file written outside
any candidate's own paths, before the real promotion call runs, refuses the
commit with `PromotionWorkingTreeDirty`, leaves the promotion `prepared`,
and leaves the dirty file exactly as it was) and its counterpoint is the
pre-existing "replay after partial file materialization" test, now doubling
as proof that a replay's own expected dirty candidate files (and the
scaffold's) do **not** trip the same check.

**Three new mutations, each backed up/applied/tested/restored individually,
all killed by the existing suite with no gaps found:**

21. Removing both dirty-tree checks entirely — killed; with only the first
    disabled, the second (after-write) check still catches it on its own,
    proving the two checks are independently sufficient, not merely
    redundant; with both disabled, the unrelated file is swept into a real
    commit and reported as success — exactly the vulnerability this review
    named.
22. Dropping `--untracked-files=all` from the `dirtyPaths()` git invocation
    (regressing the collapsed-directory bug found while building the fix
    itself) — killed, 10 integration failures, every one a false "app/ is
    unexpected."
23. `scaffoldTemplatePaths()` returning nothing (as if the scaffold's own
    output were never accounted for) — killed, 10 integration failures,
    identical shape to mutation 22's.

**Tests: 2 new (748 total, up from 746): 490 unit (unchanged), 258
integration (+2).** Typecheck, lint, and the full suite (both promotion
files, the whole repo) stayed green throughout; three file checksums
(`job-promotion/frontend-backend.ts`, `workspace/project-workspace.ts`,
`workspace/site-build.ts`) confirmed clean against their pre-review backups
after every mutation was reverted.

### Phase 5i — harness-owned single frontend/backend job lifecycle — **DONE**

Every individual Phase 5 piece already existed — a real Terra handler, 5g-1
isolated validation, 5g-2 atomic acceptance, 5h replay-safe promotion — but
nothing chained them together for one explicit job. 5i is that composition,
and nothing else: it calls the existing production boundaries in sequence,
driven by the job's own durable state, and reimplements none of them.

**Production module and API.**
`packages/orchestrator/src/job-lifecycle/frontend-backend.ts` —
`createFrontendBackendLifecycleCoordinator(deps): FrontendBackendLifecycleCoordinator`,
where the coordinator's one method is `run(spec: JobSpec):
Promise<FrontendBackendLifecycleResult>`. `deps` is exactly what composing
the existing lifecycle needs — `{ store, registry, engine, model,
workerIdentity, workspacesRoot, validationWorkspacesRoot, say?, track?,
leaseMs?, heartbeatEveryMs?, now?, sleep? }` — no Sol model, no Luna model,
no deployment API, no policy engine.

**Terra-only, one role.** Construction requires
`deps.workerIdentity.tier === 'terra'`, checked explicitly with a clear
`FrontendBackendLifecycleConfigError` rather than left to `JobRunner`'s own
incidental rejection. The `JobRunner` this constructs internally is fixed to
`claimableRoles: ['frontend_backend']` — never the tier's full role
ceiling — using the real, unmodified `createTerraFrontendBackendHandler`.
There is still exactly one Terra `frontend_backend` implementation; this
module does not introduce a second one.

**Input is the existing `JobSpec`, with a stable caller-supplied `jobId`.**
`run(spec)` requires `spec.role === 'frontend_backend'`
(`FrontendBackendLifecycleRoleMismatch` otherwise) and both pinned inputs
present (`FrontendBackendLifecycleInputInvalid`, checked via
`FRONTEND_BACKEND_INPUT`'s existing keys) before anything is enqueued. No
new planning contract, no generated identity: an explicit rerun with the
same `spec.jobId` addresses the same job.

**Idempotent ensure/enqueue, never a raw insert.** At the start of `run`,
`spec.jobId` is read from `store.jobs`; if absent, `JobEngine.enqueue`
creates it (never a raw `store.jobs.insertOne` — pinned by a structural
test); if present, its immutable `.spec` must structurally equal the
supplied one or the call fails closed with
`FrontendBackendLifecycleJobConflict` before touching anything else. Equality
reuses the existing `contentHash` (`@statxai/workspace`) — the same
canonical-JSON identity primitive Phase 5h's own promotion id already
uses — rather than a second scheme; because `JobSpec` carries only immutable
fields to begin with (`state`/`attempt`/`lease`/`failure`/`executionOutputs`
all live as siblings on `JobDocument`, never nested inside `.spec`),
comparing two `.spec` values this way can never accidentally compare mutable
runtime state. A concurrent second caller that loses Mongo's own `_id`
uniqueness race on `enqueue` re-reads and applies the identical equality
check rather than ever producing a second job.

**`JobEngine.claim` and `JobRunner.runOnce` needed a minimal, additive
extension: exact-job scoping.** Both gained an optional `jobId?: string`.
In `claim`, when given, it narrows the *candidate* query only —
`{ ...scope, ...(jobId ? { _id: jobId } : {}), state: 'ready', role: { $in:
roles } }` — never the separate query for already-`running` jobs used for
output-conflict detection, and never weakens dependency checks, output-
conflict checks, tier/role filtering, lease fencing, or attempt increment,
all of which still run exactly as before against the (now single-candidate)
set. Omitting `jobId` is byte-for-byte the original behaviour — pinned by a
dedicated regression test, and by the entire pre-existing `job-engine` suite
(108 tests, unmodified, staying green). `JobRunner.runOnce` simply threads
`options.jobId` through to `engine.claim` alongside its existing
`projectId`; the lifecycle's own `ready` handling always calls
`runner.runOnce({ jobId: job._id })`.

**State machine, from a freshly-read `JobDocument`, never a cached or
runner-returned snapshot:**

- **`draft`** — a fresh enqueue from this coordinator never sets `draft:
  true`, so this state is only ever reached on a pre-existing job created
  that way by something else. Never auto-released — `{ outcome: 'draft' }`.
- **`ready`**, first time this call — exact-job `runOnce`; the job is
  re-read fresh afterward regardless of outcome. If `runOnce` returned
  `idle` and the fresh read still shows `ready`, an existing claim rule
  (dependency, output conflict) genuinely refused it: `{ outcome:
  'not_claimable' }`. If `idle` but the fresh state moved on, a concurrent
  caller claimed it first — no worker execution happened in *this* call,
  and the durable state is followed forward. Any real execution outcome
  (`submitted`/`handler_failed`/`authority_lost`) sets `workerExecuted =
  true` and continues from the fresh read.
- **`ready`**, reached a *second* time in the same call (`workerExecuted`
  already true) — stop: `{ outcome: 'retry_ready' }`. Never a second
  `runner.runOnce` call in one invocation. This is the one-Terra-attempt
  boundary; it holds regardless of how many times `advance` recurses
  forward afterward.
- **`running`** — never touched: no claim, no handler call, no mutation.
  `{ outcome: 'in_progress' }`.
- **`validating`** — reruns 5g-1 fresh every time
  (`createFrontendBackendCandidateValidator` — real disposable workspace,
  real deterministic gates), including on a brand-new coordinator instance
  after a process restart, since 5g-1's evidence is process-local and 5i
  persists none of it. `ok === false` stops the call outright — no accept,
  promote, repair, fail, or reroute — `{ outcome: 'validation_failed',
  report: { compiled, gateRun } }`, and the job stays exactly `validating`,
  precisely as 5g-1 itself leaves it. `ok === true` passes the *exact*
  object 5g-1 returned, untouched, directly into
  `acceptValidatedFrontendBackendCandidate` in the same call, then re-reads
  fresh and continues.
- **`accepted`** — 5h alone: `promoteAcceptedFrontendBackendCandidate(jobId,
  ...)`, exactly as it already is, with `{ outcome: 'promoted', jobId,
  attempt, candidate, promotionId, commitSha }`. No re-validation, no
  re-acceptance, no lifecycle-specific Git path — confirmed structurally:
  the module imports no `ProjectWorkspace`, calls no `.commit(`/
  `.writeSiteFiles(`, and never imports `scaffoldSite`.
- **`failed`** — exhausted retries (or an equivalent pre-existing terminal
  failure): no reset, no replacement job, no handler. `{ outcome: 'failed'
  }`.
- **`repair_requested`** / **`blocked`** — stop, unmutated. No repair-tier
  handler is wired; blocking is policy/control-plane authority this module
  does not hold.

**Exactly one Terra worker attempt per invocation, proven, not merely
documented.** A handler failure that JobEngine's own existing retry
semantics return to `ready` stops the call at `retry_ready`, with the model
called exactly once; a *second*, separate `run(spec)` call is required to
execute the retry, and `attempt` increments only through `JobEngine.claim`'s
own counter — this module never touches `attempt` itself (pinned: a raw
`$inc` mutation is one of the killed mutations below).

**5g-1 → 5g-2 handoff, in-process, unbroken.** The validation object is
never cloned, spread, JSON round-tripped, or reconstructed between the two
calls — a mutation that inserts `{ ...validation }` before
`acceptValidatedFrontendBackendCandidate` fails eleven integration tests
with `AcceptanceEvidenceNotAuthentic`, confirmed and reverted (§57/§84's
mandated check). Nothing in this module holds a `validation` reference past
that one call — the successful result type has no `validation`/`binding`
field, pinned by both a structural regex check and by construction (nothing
in the result-building code ever names either).

**Restart/resume behaviour, each proved against a real Mongo replica set
and a real temp Git workspace:**

- **After enqueue, before any execution** — `ready`; the next call claims
  and runs Terra exactly once.
- **After `running -> validating`** — a brand-new coordinator instance
  (no shared process state) reruns 5g-1 fresh, obtains fresh authentic
  evidence, and proceeds straight through acceptance and promotion in that
  one call.
- **After acceptance** — 5h alone runs; no Terra, no validation, no
  `registry.accept`, no `JobEngine.accept` call (asserted directly against
  the acceptance module's own call count).
- **After a real Git commit but before Mongo's promotion record
  finalises** — simulated by scoping a `Collection.prototype.findOneAndUpdate`
  failure to exactly the `job_promotions` collection (a blanket mock would
  instead intercept one of `JobEngine`'s own earlier `findOneAndUpdate`
  calls, since the whole pipeline runs in one invocation) — the retry
  discovers the existing marker via 5h's own history search and finalises
  onto it, with no duplicate commit.
- **After full promotion** — a pure read-and-verify: same promotion id,
  same commit SHA, no second job, model call, candidate, or acceptance;
  `enqueued`/`workerExecuted` correctly report `false` for the replay call
  specifically (identity fields are compared with those two excluded).

**Result type** — a small orchestrator-local discriminated union,
`FrontendBackendLifecycleResult`: `'promoted'` (`jobId, attempt, candidate,
promotionId, commitSha, enqueued, workerExecuted`), `'validation_failed'`
(`jobId, attempt, report, enqueued, workerExecuted`), and a shared shape for
`'in_progress' | 'retry_ready' | 'not_claimable' | 'failed' |
'repair_requested' | 'blocked' | 'draft'` (`jobId, state, enqueued,
workerExecuted`).

**Tests: 34 new (787 total, up from 748 at the close of the 5h review): 496
unit (+6 lifecycle structural, +1 workspace/site-build boundary carried over
from the 5h review), 291 integration (+26 lifecycle, +6 exact-job `claim()`,
+1 `runOnce({ jobId })`).**

- `frontend-backend-job-lifecycle.test.ts` (6, unit/structural, no Mongo):
  no `runProject`/direct-orchestrator import; no Sol routing/adjudication/
  replan, Luna, or deployment reference; no raw
  `jobs.updateOne`/`insertOne`/`findOneAndUpdate`, `registry.accept`, or
  `engine.accept`/`submitForValidation`/`fail`/`requestRepair`/`block`/
  `release` call; `claimableRoles: [ROLE]` literal present, `rolesForTier`
  absent; no `ProjectWorkspace`/`scaffoldSite`/`.commit(`/`.writeSiteFiles(`;
  no `validation`/`binding` field on the result type.
- `frontend-backend-job-lifecycle.integration.test.ts` (26): the full happy
  path (fresh enqueue through promotion, one invocation); role mismatch and
  missing-input rejection before enqueue; exact job claim over an older
  ready job of the same role; no other role executed; same-jobId/different-
  spec conflict; pinned inputs surviving a newer accepted version; exact
  replay after promotion; resume from `validating`/`accepted`/after full
  promotion; validation failure; one-Terra-attempt-max and the legitimate
  next-invocation retry; a running job never hijacked; dependency-not-
  satisfied and output-conflicted `ready` jobs; a blocked job never
  released; `repair_requested` never wired to anything; an exhausted failed
  job stays failed; a pre-existing draft job never auto-released; authority
  loss (the same-worker-reclaims-its-own-job scenario) followed forward from
  durable state; acceptance failure surfaces without promoting; promotion
  failure surfaces without deploying and remains retryable; the mandatory
  post-Git/pre-Mongo recovery through the full lifecycle; a structural
  assertion that the module source never mentions `runProject`.
- `packages/job-engine/test/engine.test.ts` (+6): exact-job claim over an
  older ready job; omitting `jobId` preserves original FIFO behaviour;
  exact-job claim still respects role narrowing, dependency satisfaction,
  and output-conflict serialisation; claiming a nonexistent/non-ready exact
  job returns `null` without disturbing anything else.
- `packages/job-engine/test/runner.integration.test.ts` (+1): `runOnce({
  jobId })` claims exactly that job over an older ready one.

**Mutation testing — 22 mutations applied one at a time (lifecycle module,
plus `JobEngine.claim` for the two exact-job-scoping checks), each backed
up/applied/tested/restored individually. 20 killed outright; 2 confirmed
genuinely unreachable rather than gaps, given `JobEngine.claim`'s own
`state: 'ready'` filter:**

1. Remove the exact-jobId claim filter — killed (2 integration failures:
   exact-job-claim, no-other-role).
2. Widen `claimableRoles` to the full tier ceiling — killed, but only by the
   structural test: with exact-job scoping intact, the integration-level
   behaviour is unreachable regardless (confirmed defense-in-depth, not a
   gap).
3. Enqueue under a random jobId each invocation — killed, 12 integration
   failures.
4. Ignore an existing job's `JobSpec` mismatch — killed by the dedicated
   conflict test.
5. Raw-insert the job instead of `JobEngine.enqueue` — killed by the
   structural test (behaviourally equivalent output; the boundary violation
   is caught at the code level, exactly as intended).
6. Bypass dependency checks for exact-job claims (`JobEngine.claim`) —
   killed at both the lifecycle-integration and job-engine levels.
7. Bypass output-conflict checks for exact-job claims (`JobEngine.claim`) —
   killed at both levels.
8. Execute a `running` job again — **survived**: `JobEngine.claim`'s own
   `state: 'ready'` filter makes a claim attempt against a running job
   inert regardless of this module's own dispatch, verified by inspection
   rather than forcing an artificial test.
9. Auto-release a blocked job — killed at both structural and integration
   levels.
10. Auto-release a pre-existing draft job — killed at both levels.
11. Loop when the first execution returns the job to `ready` (remove the
    one-attempt guard) — killed: both one-Terra-attempt-max tests fail.
12. Manually increment `attempt` via a raw store write — killed massively
    (structural test plus 11 integration tests).
13. Skip the authoritative re-read after worker execution, synthesising
    state from the `runOnce` result instead — killed (13 integration
    failures; the synthesized document has no real `executionOutputs`, so
    5g-1 fails closed with `CandidateValidationMissingOutputs`).
14. Call 5g-1 validation on a `running` job — killed (2 failures).
15. Continue to acceptance when `validation.ok === false` — killed,
    surfaced as `AcceptanceEvidenceNotAuthentic` from 5g-2's own defense (a
    failed result was never registered as acceptance-capable).
16. Clone the successful validation object (`{ ...validation }`) before
    5g-2 — **the mandated §57 check** — killed, 11 integration failures,
    `AcceptanceEvidenceNotAuthentic`.
17. Rerun Terra when the job is already `validating` — **survived**, same
    reason as #8: `claim`'s `state: 'ready'` filter makes it inert.
18. (Rerun Terra when already `accepted`) — not separately re-run; identical
    unreachability to #8/#17 by the same mechanism.
19. Rerun deterministic validation when the job is already `accepted` —
    killed massively (11 failures; 5g-1's own state check rejects a
    non-`validating` job).
20. Call `registry.accept` directly in the lifecycle — killed by the
    structural test (idempotent no-op at the integration level).
21. Raw-update the job to `accepted` — killed massively (structural test
    plus 12 integration tests).
22. Call promotion before acceptance succeeds (reorder) — killed (12
    failures; 5h's own `PromotionStateMismatch` on a still-`validating`
    job).
23. Duplicate 5h's Git publication — not independently reachable: the
    module imports no `ProjectWorkspace` and calls no Git-write primitive at
    all, pinned structurally.
24. A second Terra retry attempt in the same invocation — identical to #11.
25–28. Invoke Luna / Sol / deployment / `runProject` — none of these are
    reachable: the module imports none of them, pinned structurally (the
    boundary tests above).
29. Return/persist the successful validation evidence — killed by the
    dedicated structural regex check.
30. Re-enqueue a second job on exact successful replay — covered by #3/#4's
    protections; a naive "always call `enqueue`, rely on the duplicate-key
    catch" variant is absorbed harmlessly by the same race-recovery path
    that already exists for genuine concurrent callers, confirmed by
    inspection rather than a separate forced test.

**Phase 5i executes at most one Terra worker attempt per lifecycle
invocation.** **Phase 5i does not persist successful 5g-1 validation
evidence.** **Phase 5i does not route deterministic validation failure to
Luna.** **Phase 5i does not deploy the promoted commit.** **`runProject`
still does not execute through `JobEngine`.** **`runProject` still does not
automatically enqueue production jobs.** **No production Luna handler is
wired yet.**

### Phase 5j — route one `runProject` frontend/backend build boundary through Phase 5i — **DONE**

A controlled cutover seam, not a migration: `runProject` gains exactly one
explicit choice of implementation for the `frontend_backend` build
boundary — the existing direct builder, or Phase 5i's harness-owned
lifecycle — selected per call, defaulting to the direct builder, with no
dynamic fallback between the two once a mode is chosen.

**The mode seam.** `packages/orchestrator/src/orchestrator.ts` exports
`type FrontendBackendExecutionMode = 'legacy_direct' | 'job_lifecycle'`.
`RunOptions` gains `frontendBackendExecutionMode?` (default
`'legacy_direct'` — no caller in this repository opts into `'job_lifecycle'`
yet) and `validationWorkspacesRoot?` (required, and validated with an
explicit throw before any work starts, only when the mode is
`'job_lifecycle'`; never the canonical `workspacesRoot`, since Phase 5g-1
creates and tears down its own disposable directory under it per
validation). The two modes share every phase except the one build-boundary
call: `legacy_direct` calls `buildFromPlan({ deps, facts }, initialPlan)`,
unchanged; `job_lifecycle` constructs a `JobEngine` and
`createFrontendBackendLifecycleCoordinator(...)` — only in that branch, so
legacy runs allocate neither — builds one `JobSpec`, and calls
`coordinator.run(spec)` exactly once (one call site, confirmed by
inspection). `promoted` is the only outcome that continues past the
boundary; every other Phase 5i outcome
(`validation_failed`/`retry_ready`/`in_progress`/`not_claimable`/`failed`/
`repair_requested`/`blocked`/`draft`) stops the invocation immediately —
never a second `coordinator.run` call, never a fallback to `buildFromPlan`.

**Exact-ref threading, not "latest" resolution.** `DiscoverResult` gained
`businessProfileRef: ArtifactRef` — the exact ref `registry.put` returned
when the profile was persisted, threaded through rather than discarded.
`planning.ts`'s `producePlan`/`revisePlan` now return `{ plan, sitePlanRef
}` (a new exported `ProducedPlan`) instead of a bare `SitePlan`;
`persistPlan` returns the `ArtifactRef` it wrote. `runProject` passes both
refs straight into the `JobSpec` unchanged — never a fresh `registry.get`/
"latest" lookup at spec-construction time. Proved, not just asserted: a
version accepted for either artifact *after* discovery/planning already
ran — including in the narrow window between `producePlan` returning and
the `JobSpec` being built, which is the one moment that can actually
distinguish "the exact value this run produced" from "whatever the
registry now considers newest" — never changes what this run's job pins.

**One production `JobSpec` factory.**
`packages/orchestrator/src/job-specs/frontend-backend.ts` —
`createFrontendBackendJobSpec({ projectId, businessProfileRef,
sitePlanRef })`. Preserves every existing `frontend_backend` job convention
untouched (`role`, `objective`, `acceptanceCriteria`, `allowedTools`,
`output: ['app/']` — one fixed, non-parameterised literal per project,
deliberately never made unique per job, since `JobEngine`'s
output-conflict check is exact-string membership and a unique output would
silently defeat the serialisation the shared literal exists to provide).
`jobId` is `` `frontend-backend-${contentHash(identity)}` ``, where
`identity` is the full `JobSpec` minus `jobId` itself — the same
canonical-JSON primitive Phase 5i's own `sameJobSpec` already hashes a
`JobSpec` with, reused rather than reinvented. Deliberately excluded from
the preimage: anything that is runtime state rather than request intent —
`createdAt`/`updatedAt`, a random id, `workerId`, `attempt`, `lease`,
`failure`, `executionOutputs`, a promotion commit, a `lineageSeq`, a
`RunRecorder` sequence, canonical `HEAD`. The same `(projectId,
businessProfileRef, sitePlanRef)` always produces the exact same `JobSpec`
— including `jobId` — so a second call with identical pinned inputs
addresses Phase 5i's existing job rather than creating a second one; any
one of the three changing changes the identity.

**Worker identity is harness-owned, not content-derived.**
`{ workerId: \`run-project:${projectId}:frontend-backend\`, tier: 'terra'
}`, fixed at this one call site — never assembled from intake, model
output, or the plan.

**The one interaction this phase's own §1 inspection did not anticipate,
found only by running the mandatory happy-path test against a real Mongo
replica set and a real canonical Git workspace end to end (never exercised
before this phase, since Phase 5i's own fixtures deliberately point
discovery at a *separate* throwaway workspace — see the comment at
`frontend-backend-job-lifecycle.integration.test.ts:97-104` — precisely to
avoid this collision): `discoverProject`/`persistPlan` materialise
`client/business-profile.json`, `design/brand-system.json`,
`specs/sitemap.json`, and `specs/pages/*.json` into the same canonical
`ProjectWorkspace` Phase 5h promotes into, and leave them uncommitted. On
`legacy_direct`, `buildFromPlan`'s own `commit('Terra: build')` always
swept them into the same commit as the generated site; `job_lifecycle`
never calls that function, so nothing else ever committed them, and Phase
5h's own dirty-tree guard — by design, not a bug — refused every promotion
outright (`PromotionWorkingTreeDirty`) because it saw them as foreign
changes. Resolved, after surfacing this to the user rather than silently
choosing a fix, by having the `job_lifecycle` branch call
`workspace.commit('Harness: specification')` once, immediately before
`coordinator.run(spec)` — a narrow retiming of the exact same pre-existing
harness materialisation into its own commit, never a new write, and never
a site file: `writeSiteFiles`/`publishBuildDirectly` are still never called
from this branch, and only Phase 5h's own promotion ever writes `app/`.
This is the one exception to "no commit from `runProject` in job mode,"
asserted directly by a dedicated structural test (exactly one `.commit(`
call in the job-mode block, and it names this exact call).

**That commit carries the same "nothing foreign rides along" guard Phase
5h's own promotion applies to itself — not a bare `git add -A`.** Initially
shipped without one (a real gap, caught after review): the harness commit
would have silently swept up any stray uncommitted file already sitting in
the canonical workspace, under a message that claims to be only the
specification. Fixed by computing the exact set of paths
`discoverProject`/`persistPlan` are known to have written —
`client/business-profile.json` plus `sitePlanArtifactPaths(initialPlan)`, a
newly exported helper in `planning.ts` that `persistPlan` itself now also
uses for its own page-slug loop, so the allow-list and the writer can never
independently drift — and checking `workspace.dirtyPaths()` against it
before committing. Anything outside that set throws a new
`RunProjectSpecificationWorkingTreeDirty(projectId, unexpectedPaths)`,
mirroring `PromotionWorkingTreeDirty`'s own shape and reasoning exactly,
*before* Phase 5i ever runs and before the foreign file is committed.
Proved with a dedicated regression test (a foreign file written into the
canonical workspace between `producePlan` returning and the guard running)
and two mutations, both killed: removing the guard entirely (the
foreign-file regression test fails, and the happy path silently succeeds
with the stray file committed instead of rejecting), and narrowing
`sitePlanArtifactPaths` to omit a path `persistPlan` still writes — which
correctly resurfaces as every job-mode test failing with
`RunProjectSpecificationWorkingTreeDirty`, confirming the shared-helper
design actually catches the drift it exists to prevent, not merely asserts
it away.

**The public-contract gap.** `RunResult.outcome` has only three values —
`'released' | 'blocked' | 'intake_insufficient'` — none of which honestly
represent "a Phase 5i job is not yet promoted." Rather than inventing a
new outcome value per Phase 5i sub-state (explicitly out of scope) or
silently collapsing the distinction, every non-`promoted` exit reuses the
existing `'blocked'` outcome and adds exactly one new optional field,
`jobLifecycleOutcome?: FrontendBackendLifecycleResult['outcome']`, carrying
the precise sub-reason. `terminalDecision` is deliberately never set
alongside it — no policy adjudication produced this exit, and setting one
would misrepresent what happened. `jobLifecycleOutcome` is never set on a
`legacy_direct` run (proved directly).

**Downstream continuation and its one known duplication.** Once
`promoted`, `runProject` continues exactly where the legacy path would
have — `evaluateSite`, adjudication, repair, publish — completely
unmodified. `evaluateSite` reads from the canonical `ProjectWorkspace` on
disk, which now holds Phase 5h's promoted files regardless of which mode
produced them, so it needs no awareness of the mode seam at all. This does
mean Phase 5g-1's deterministic gates and `evaluateSite`'s own
deterministic gates now run twice in `job_lifecycle` mode — once inside
Phase 5i's validation, once again as part of the existing post-build
evaluation — which is harmless (the second run is idempotent against the
same promoted files) but real, and is recorded here rather than hidden.

**Scope limitations, stated rather than solved:**

- **Only the initial build call is cut over.** A replan-triggered rebuild
  (`buildFromPlan(ctx(), revised.plan)` inside `runProject`'s replan loop)
  always uses `buildFromPlan` regardless of
  `frontendBackendExecutionMode` — a replanned rebuild is a new request
  from a new plan version, not a second attempt at the request Phase 5i
  already handled, and no mandatory test exercises replan × `job_lifecycle`
  interaction.
- **No restart resumability claim.** Nothing durable records which job a
  given run is waiting on; a fresh `runProject` call does not know to
  resume a specific in-flight Phase 5i job. Re-running with identical
  pinned inputs happens to address the same job (proven), but discovery and
  planning are not guaranteed to reproduce identical inputs on a fresh run,
  so this is a property of the `JobSpec` factory, not a run-resume feature.
- **No caller opts in yet.** `run-service.ts` is untouched; every
  production `runProject` call still runs `legacy_direct`.

**Tests: 35 new (822 total, up from 787 at the close of the 5i review): 510
unit (+14 JobSpec factory), 312 integration (+21 build-boundary).**

- `job-specs-frontend-backend.test.ts` (14, unit, no Mongo): fixed
  `frontend_backend` conventions (role/objective/acceptanceCriteria/
  allowedTools/output); pinned input keys; output identity stable across
  different projects/refs; `jobId` prefix; deterministic identity
  (identical input → identical `JobSpec`/`jobId`, 5 repeated calls collapse
  to one id); `jobId` exactly `frontend-backend-` + `contentHash` of the
  identity (superseded by Phase 5k — see that section: the format shipped
  here never actually satisfied `@statxai/contracts`' own `JobId` schema,
  uncaught because nothing in the runtime path validates a produced spec
  against it); a changed `projectId`/`businessProfileRef`
  (name or version)/`sitePlanRef` (name or version) each changes `jobId`;
  swapping which ref is which changes `jobId`; the result carries no field
  beyond the fixed `JobSpec` surface.
- `frontend-backend-build-boundary.integration.test.ts` (21): legacy mode
  is the default and creates zero job-related side effects
  (jobs/audit/candidates/promotions); the existing direct-parity behaviour
  is unmodified; the full job-mode happy path (one job, one Terra
  generation, staged → accepted → promoted, canonical commit, continuation
  into release) against real Mongo/`ArtifactRegistry`/`JobEngine`/the
  production Terra handler/5g-1/5g-2/5h/a real temp canonical Git
  workspace; exact `businessProfile`/`sitePlan` ref pinning against a
  competing newer version created both mid-Terra-build and in the
  spec-construction-time window; the threaded value/ref correspondence
  property against the real registry; deterministic `JobSpec`
  reproducibility, cross-field identity sensitivity, and build-boundary job
  reuse across two calls; no automatic fallback on
  `validation_failed`/`retry_ready`/`in_progress`; the promoted-only
  barrier, proved by spying on `evaluateSite` itself rather than a model
  call inside it (the shared compiler mock that fails Phase 5i's own
  validation also fails `evaluateSite`'s own compile step for the same
  reason, which would silently mask a removed barrier if asserted any
  other way); the direct build path is never called in job mode; platform
  failure propagates with no fallback; worker identity is harness-derived
  and immune to intake content; the `JobSpec` factory only ever produces
  `frontend_backend`; `job_lifecycle` without `validationWorkspacesRoot`
  rejects before touching discovery; structural absence of
  `registry.accept`/`engine.accept`/`writeSiteFiles`/`scaffoldSite`/a
  second `.commit(`/Luna/new Sol routing/deployment from the job-mode
  branch; an unrelated dirty file in the canonical workspace rejects with
  `RunProjectSpecificationWorkingTreeDirty` before any job exists and
  before that file is committed.
- `state-transitions.test.ts` / `replanning.test.ts` (pinned-shape updates,
  no new tests): `building` is now written from two mutually exclusive
  places (`orchestrator.ts`'s job-mode branch, `build.ts`'s legacy branch);
  the `producePlan` call-site literal updated for its new destructured
  return.

**Mutation testing — 12 mutations applied one at a time to the new
production code, each backed up/applied/tested/restored individually, all
killed; the remaining items from the 30-check list are covered by
construction, by a structural absence test, or fall on Phase 5i's own
already-mutation-tested internals, as noted:**

1. Default flips to `job_lifecycle` — killed (`legacy mode remains the
   default` fails: the omitted `validationWorkspacesRoot` guard now
   throws).
2. Remove the promoted-only barrier (always continue downstream) — killed
   twice over: `tsc` itself rejects `result.commitSha` on the non-`promoted`
   union variants, and the runtime test (spying on `evaluateSite` directly,
   not on a model call inside it) fails independently.
3. Job mode also calls `buildFromPlan` after `promoted` (double build) —
   killed.
4. Worker identity includes `profile.businessName` — killed.
5. `businessProfileRef` re-resolved as "latest" at spec-construction time
   instead of using the threaded value — killed, but only after
   strengthening the test: injecting the competing version *during* Terra's
   build (the original test) coincides with the threaded value regardless
   of this bug, since nothing changes between spec-construction and
   generation in that scenario. Injecting it in the narrower window right
   after `producePlan` returns, before the `JobSpec` is built, is what
   actually distinguishes the two — added as its own test rather than
   patching the existing one, since both properties are worth proving
   independently. The identical code path makes this representative of the
   `sitePlanRef` case too.
6. Remove `sitePlanRef` from the `JobSpec` factory's identity — killed (3
   unit test failures).
7. Randomise `jobId` (append a timestamp) — killed by the exact-preimage
   unit test; the "repeated calls collapse to one id" test is not reliable
   against a millisecond-resolution timestamp on its own and is kept for
   the property it does prove (idempotent reuse under normal conditions),
   not as this mutation's kill.
8. Make `output` unique per job (parameterise by `projectId`) — killed (2
   unit test failures).
9. `discoverProject` returns a `businessProfileRef` that does not match the
   ref it actually just wrote — killed (job-mode happy path outcome flips
   to `blocked`, since Phase 5i's own input resolution then fails against a
   nonexistent version).
10. `producePlan` returns a `sitePlanRef` that does not match the ref it
    actually just wrote — killed, same mechanism as #9, confirming the
    legacy path is unaffected (it never reads `producePlan`'s `sitePlanRef`
    field at all).
11. Remove the pre-commit dirty-tree guard entirely (added after review
    flagged its absence — the harness commit originally did a bare
    `git add -A` with no allow-list, unlike Phase 5h's own promotion) —
    killed: the dedicated foreign-file regression fails, and the run
    silently succeeds with the stray file committed under the
    specification message instead of rejecting.
12. Narrow `sitePlanArtifactPaths` to omit a path `persistPlan` still
    writes (`specs/sitemap.json`) — killed massively: every job-mode test
    now fails with `RunProjectSpecificationWorkingTreeDirty`, since the
    guard's own allow-list falls out of step with what was actually
    written. Confirms the shared-helper design (`persistPlan` and
    `sitePlanArtifactPaths` both read the same `pageSlug`, and the guard
    reads the same exported path list `persistPlan` uses) genuinely
    prevents this class of drift rather than merely asserting it away.

Not independently forced through a runtime mutation, with the reason each
is still covered:

- **Job mode calls direct build after a non-`promoted` outcome** — the two
  build calls are mutually exclusive by construction (one `if`/`else`, one
  `buildFromPlan` call site total, pinned by `state-transitions.test.ts`'s
  `building: 2` count) and mutation #3 already proves the `else` branch is
  load-bearing.
- **Phase 5i invoked twice after `retry_ready`** — structurally impossible
  by inspection: `coordinator.run(` appears exactly once in
  `orchestrator.ts`.
- **Resolve "latest" for `sitePlanRef` / remove `businessProfileRef` from
  the identity preimage** — code-identical to mutations #5/#6 respectively
  (the same object-literal shape, the same call site); not re-run
  separately.
- **Non-`terra` worker identity** — enforced by Phase 5i's own
  `createFrontendBackendLifecycleCoordinator` constructor guard
  (`FrontendBackendLifecycleConfigError`), already in that phase's own
  mutation-tested history; not new Phase 5j code.
- **Write canonical files directly / call `registry.accept`/`engine.accept`
  from the adapter / bypass 5h and commit directly / invoke Luna / invoke
  new Sol routing / call deployment** — each is a structural absence,
  asserted directly (the job-mode block contains no such call, and contains
  exactly one `.commit(`, which is asserted to be the one documented
  exception) rather than forced and reverted.
- **Skip downstream evaluation after `promoted`** — the positive-path
  regression test (`evaluateSite` spied and asserted called) has the same
  kill power a forced mutation would have here; not run as a separate
  destructive edit.
- **Route another role through job mode** — `ROLE` is a private, unexported
  module constant with no parameter to override it; the "only ever
  produces `frontend_backend`" tests already prove this by construction.
- **Persist process-local 5g-1 validation evidence** — Phase 5i's own
  internal responsibility, not new Phase 5j code; already killed in that
  phase's own review (see mutation 29 above).
- **Use `lineageSeq` as job identity** — not applicable: the identity
  preimage never references it; there is no code path to mutate into using
  it.
- **Claim full restart resumability without a persistent binding** — a
  documentation-honesty requirement, not a code guard; addressed by the
  explicit scope-limitation prose above, not a test.

**Phase 5j does not make `job_lifecycle` the global `runProject`
default.** **Phase 5j never falls back to the direct builder after
`job_lifecycle` has started.** **Phase 5j does not route deterministic
validation failure to Luna.** **Phase 5j does not persist 5g-1 validation
evidence.** **Phase 5j does not deploy the promoted commit.** **Phase 5j
cuts over only the `frontend_backend` build boundary.** **The rest of
`runProject` remains harness-owned and unchanged.**

### Phase 5k — durable active frontend/backend build binding / restart resume — **DONE**

Closes the gap Phase 5j's own "deliberately next" note named: a fresh
`runProject` invocation had no durable record of *which* Phase 5i job an
unfinished job-mode build belonged to, so a restart re-ran discovery and
planning — legitimately producing new `businessProfile`/`sitePlan`
versions, and therefore a different deterministic `JobSpec`/`jobId` — for a
build Phase 5i might already be partway through under the old one. Applies
only to `job_lifecycle`; `legacy_direct` is byte-for-byte unchanged and
remains the default.

**A durable active build binding, one per project.** New collection
`frontend_backend_build_bindings`
(`FrontendBackendBuildBindingDocument`, `packages/state/src/documents.ts`),
mirroring `JobPromotionRecord`'s own shape exactly: `status: 'prepared' |
'promoted'`, a project-scoped partial unique index on `{ projectId }` where
`status: 'prepared'` (`StateStore.ensureIndexes`) — at most one unfinished
binding per project, enforced by Mongo itself, while `promoted` bindings
are retained as historical evidence and no longer occupy the slot, freeing
the project for a genuinely new build generation. A document carries:
`runIntentHash`, the exact `businessProfile`/`sitePlan` `ArtifactRef`s, the
**exact `JobSpec`** (not only its hash — a future code deployment could
change the factory's objective wording, `allowedTools`, or output
conventions, and reconstructing the spec from new code on resume could
silently address a different request than the one already in flight; the
stored spec is authoritative, the hash is an integrity/indexing aid only),
`jobSpecHash`, `jobId`, `specificationBaseCommit`/`specificationCommitSha`,
and `promotionId`/`promotionCommitSha` (set only once `promoted`).

**No pre-existing durable run identity survives restart, so none was
reused.** `run-service.ts`'s `RunRecorder`/`RunDocument` exist, but their
`runId` is generated fresh per call
(`` `run_${suffix}${Date.now().toString(36)}` ``, `Math.random()`-derived)
and `runProject` itself never receives or threads one — inspected first,
per the brief's own instruction, rather than assumed. A project-scoped
binding with an immutable run-intent fingerprint is the smallest correct
primitive; inventing a fake stable run id would have been worse than not
solving the problem.

**`bindingId` is deterministic**, from immutable authority only:
`` `frontend-backend-build-${contentHash({ projectId, runIntentHash, jobSpecHash })}` ``
— never `Date.now()`, a random id, `attempt`, `workerId`, a lease, an
artifact `lineageSeq`, a `RunRecorder` sequence, or a promotion commit SHA.
Two racing fresh invocations deriving the *same* exact binding converge on
one durable record (idempotent ensure, mirroring `prepareFrontendBackendBuildBinding`
against `JobPromotionRecord`'s own race-recovery shape); two deriving
*different* bindings for the same project get
`FrontendBackendBuildBindingConflict` for the loser, never a silent
overwrite.

**`runIntentHash` is the canonical, schema-validated profile — never raw
JSON.** `computeRunIntentHash({ projectId, profile })` hashes the exact
`BusinessProfile` `discoverProject` itself operates on, so two raw payloads
that parse to the same canonical profile (stripped unknown fields, reordered
properties) hash identically. Deliberately excludes `autonomyMode`: inspected
first, and it affects only post-build adjudication/terminal-decision policy —
never discovery's persistence, planning, or `JobSpec` construction — so
including it would make the fingerprint distinguish requests that build
identically. Also excluded, per the brief's own explicit list: callbacks,
the `ModelClient` instance, `workspacesRoot`/`validationWorkspacesRoot`,
the clock, worker lease timings.

**Preflight ordering — the core Phase 5k cutover.** For `job_lifecycle`
only, `runProject` now runs the *exact same* pure `validateIntake` check
`discoverProject` itself runs (extracted into a shared function so the two
callers can never drift — see below) before anything durable, then — only
on success — looks up an active `prepared` binding for the project,
*strictly before* discovery's own reset/write side effects (project
delete/reinsert, budget delete/recreate, profile `put`/`accept`/materialise)
and before planning. No matching binding: the fresh path, identical to
before Phase 5k in every respect. A binding for a *different* `runIntentHash`:
`FrontendBackendBuildBindingConflict`, thrown before any side effect — the
existing binding is never resumed silently, destroyed, or raced past. A
binding for the *same* `runIntentHash`: resume.

**Phase 4e's zero-side-effect intake-failure guarantee, preserved by
construction, not convention.** `discoverProject`'s own schema-parse +
intake-gap check was extracted into `validateIntake` (`phases/discover.ts`),
called by both `discoverProject` and the job-mode preflight — one
implementation, not two hand-kept-in-sync copies. Malformed or
schema-valid-but-insufficient intake fails exactly as it always has, with
zero startup side effects, *even when a `prepared` binding already exists*
— an existing binding is never used to bypass current request validation.

**Resume rehydrates durable state; it never recreates it.** On a matching
binding: `parseStoredJobSpec` parses the stored spec through the real
`JobSpec` zod contract (fails closed, `FrontendBackendBuildBindingCorrupt`,
on anything that does not parse — never trusted as arbitrary Mongo shape);
`verifyBindingConsistency` re-proves `binding.projectId === spec.projectId`,
`binding.jobId === spec.jobId`, `spec.role === 'frontend_backend'`,
`contentHash(spec) === binding.jobSpecHash`, and both pinned inputs against
`binding.businessProfile`/`binding.sitePlan` by exact `ArtifactRef` field
equality (`name`/`version` always, `contentHash` when both sides carry one
— never object identity); `registry.resolve` reads the *exact* bound
profile/plan (never "latest" — a missing artifact throws `ArtifactNotFound`,
never silently substituted); both are re-parsed through their own real
schemas (`BusinessProfile`/`SitePlan`, never trusted as raw artifact JSON);
the project document and budget document are read directly
(`store.projects.findOne`/`store.budgets.findOne` — `createBudget`/a
project reset are never called on this path; either missing throws
`FrontendBackendBuildBindingResumeStateMissing`, since their absence is
control-plane corruption a resume does not repair by rerunning discovery);
`ProjectWorkspace.open` is idempotent. Discovery and planning are not
called at all on this path — proved directly (no new `business-profile`/
`site-plan` artifact version, no additional `planSite` call) rather than
inferred from their absence in the diff.

**The stored spec is authority on resume — the factory is only for new
bindings.** `createFrontendBackendJobSpec` is called (and a binding
prepared for its output) only on the fresh path; a resumed invocation
never calls it and never treats its output as authority, proved by mocking
the factory and asserting zero additional calls across a resume.

**The specification commit is now itself replay-safe, marker-aware, and
crash-recoverable — Phase 5h's own promotion pattern, applied one step
earlier.** `ensureSpecificationCommitted` (`run-binding/frontend-backend.ts`)
replaces the plain `workspace.commit('Harness: specification')` Phase 5j's
corrective follow-up left in place: search canonical history (the whole of
it, `ProjectWorkspace.findCommitsByMarker` — generalised, in a minimal
refactor, from Phase 5h's own single-match `findCommitByMarker`, which is
now a thin wrapper over it) for commits carrying this binding's exact
marker, `` `Statx-Build-Binding-Id: <bindingId>` ``, before ever writing
one.

- **Found, exactly one** — verify it agrees with any already-recorded
  `specificationCommitSha`, finalise the binding's own record if it was
  still unset, and return. No second commit is ever created — this is what
  makes "Git commit succeeded, process died before the Mongo SHA update"
  recoverable.
- **Found, more than one** — `FrontendBackendBuildBindingMarkerCorrupt`.
  This binding's deterministic identity is only ever committed once by
  construction; never resolved by choosing the newest.
- **Not found** — canonical HEAD must still equal
  `binding.specificationBaseCommit` (recorded at prepare-time, before any
  commit; `null` is a legitimate first-ever-commit base, not a placeholder)
  or `FrontendBackendBuildBindingBaseConflict` — someone else's canonical
  write landed first. The working tree must carry nothing beyond the exact
  expected specification paths (`RunProjectSpecificationWorkingTreeDirty`
  otherwise — Phase 5j's corrective guard, untouched, reused here rather
  than weakened). Only then: commit once with the marker, and finalise the
  record.

On resume, before this runs, `rehydrateSpecificationFiles` re-materialises
the exact bound `businessProfile`/`sitePlan` content into the same fixed
workspace paths `discoverProject`/`persistPlan` themselves write to
(`materialiseBusinessProfileFile`/`materialiseSitePlanFiles`, both newly
exported and reused by their original callers too — one writer, not two)
— idempotent, and never a new `ArtifactRegistry` version. Needed because a
resumed invocation never ran discovery/planning in *this* process, so
nothing wrote those files to *this* workspace open yet; harmless on the
already-committed case, since re-writing byte-identical content dirties
nothing.

**`RunProjectSpecificationWorkingTreeDirty` moved** from `orchestrator.ts`
into `run-binding/frontend-backend.ts`, which now owns the whole
specification-commit sequence; re-exported from `orchestrator.ts` so no
existing import site changed.

**Phase 5i is invoked with the stored spec, unchanged in every other
respect.** No modification to Phase 5i's authority model, `JobEngine`
execution authority, 5g-1, 5g-2, or 5h. Every non-`promoted` outcome
(`validation_failed`/`retry_ready`/`in_progress`/`not_claimable`/`failed`/
`repair_requested`/`blocked`/`draft`) leaves the binding exactly `prepared`
— nothing to do, since that is already its state; a thrown platform
failure leaves it `prepared` too, since the failure occurs before
finalisation is ever reached.

**Binding finalisation is a separate, guarded step — never inside Phase
5h's own Mongo/Git sequence, and never claimed to be atomic with it.** Only
once Phase 5i itself returns `promoted` does `finalizeBindingPromoted`
guardedly move `prepared -> promoted`, recording `promotionId`/
`promotionCommitSha` from Phase 5i's own returned values. If that write
fails, the real Git promotion and the real committed `JobPromotionRecord`
are never undone — the binding stays `prepared`, and a later invocation
resumes it: Phase 5i/5h's own replay safety means this is a pure
read-and-verify (no second Terra attempt, validation, acceptance, or
promotion commit — the same accepted job, the same committed promotion
record, the same commit SHA), after which finalisation retries and
succeeds. Proved end-to-end: mocking `finalizeBindingPromoted` to fail once
after a real promotion, then resuming for real.

**A found, real bug from Phase 5j, corrected here.** `createFrontendBackendJobSpec`'s
`computeJobId` produced `` `frontend-backend-${contentHash(identity)}` ``
— hyphenated, no `job_` prefix — which never actually satisfied
`@statxai/contracts`' own `JobId` schema (`/^job_[a-z0-9_]+$/`; existing
fixtures elsewhere in this codebase already use `job_<slug>`). Uncaught
because nothing in the runtime path (`JobEngine.enqueue`, `JobRunner`) ever
calls `JobSpec.safeParse`/`.parse` on a produced spec — only compile-time
TypeScript trusted it. Phase 5k's own §5 requirement — parse the *stored*
spec through the real contract on resume, fail closed if corrupt — was the
first caller ever to validate this at runtime, and it failed on every spec
the factory could produce. Reported to the user before fixing (a
previously-shipped, committed Phase 5j file), per their explicit direction:
`computeJobId` now returns `` `job_frontend_backend_${contentHash(identity)}` ``
— same deterministic, content-hash-derived design, corrected string format
only. `job-specs-frontend-backend.test.ts` now asserts the produced spec
parses through the real `JobSpec` schema directly, not only that it has the
expected shape.

**Scope, held exactly where the brief drew it:**

- No general workflow cursor. No `currentPhase`/`nextPhase`/`workflowPC` or
  resumable-graph concept added to `runProject`.
- `runs`/`RunRecorder` untouched — not broadened into job scheduling.
- No Luna, no repair-cycle resume. `validation_failed`/`repair_requested`/
  `blocked`/`failed` behave exactly as Phase 5i/5j already left them.
- **Phase 5k does not implement a whole-run post-promotion cursor.** Once a
  binding reaches `promoted`, Phase 5k's own capability is complete. If a
  process dies *after* `promoted` but *before* `runProject` concludes
  (evaluation, review, repair, release), a fresh invocation does **not**
  resume that part — `evaluateSite`, Terra review, Sol adjudication,
  repair-cycle position, and release/deployment progress are not persisted
  by this phase. That gap is stated here, explicitly, rather than implied
  away: a later outer-run-resume capability, not this one.
- No production default activation. `run-service.ts` is untouched — does
  not reference `job_lifecycle` or `frontendBackendExecutionMode` at all
  (checked directly).
- No deployment behaviour added.
- Deterministic harness control-plane logic throughout — Sol/Terra never
  choose whether to resume a binding.

**Tests: 48 new (870 total, up from 822 at the close of the 5j corrective
review): 534 unit (+24 binding identity/consistency), 336 integration
(+24 restart/resume).**

- `run-binding-frontend-backend.test.ts` (24, unit, no Mongo):
  `computeRunIntentHash` determinism/sensitivity/canonical-parse-not-raw-JSON;
  `computeBindingId` determinism, per-field sensitivity, exact preimage
  (`frontend-backend-build-` + `contentHash`, no clock/randomness);
  `computeJobSpecHash` determinism and full-field sensitivity including
  `jobId` itself; `bindingMarker`/`specificationCommitMessage` exact-line
  shape; `parseStoredJobSpec` against a well-formed spec and two corrupt
  shapes; `verifyBindingConsistency` accepting a genuinely matching pair
  and rejecting each of jobSpecHash/jobId/projectId/role/businessProfile-ref/
  sitePlan-ref/missing-input disagreement, plus exact-field (not identity)
  `ArtifactRef` equality.
- `frontend-backend-build-binding.integration.test.ts` (24): restart from
  `retry_ready`/`validating`/`accepted` (each: no rediscovery, no
  replanning, no duplicate Terra/validation/acceptance, same job/binding,
  JobEngine's own attempt counter the only thing that advances); restart
  after a real Git promotion but before binding finalisation (the
  mandatory crash-recovery case — Phase 5i/5h replay is a pure
  read-and-verify, finalisation retries and succeeds); a different intent
  while a binding is active conflicts before any discovery side effect,
  leaving the existing binding untouched; malformed/insufficient intake
  still fails before resume with zero new side effects even with an active
  binding; exact bound refs on resume against a competing newer version;
  the factory is never called on resume; missing project/missing budget/
  tampered jobSpecHash/missing bound artifact each fail closed without a
  Terra call; resume preserves existing budget usage and the project
  document's identity; a promoted binding frees the project for a
  genuinely new generation while history is preserved; concurrent
  identical prepare converges on one record, concurrent different prepare
  conflicts without a partial overwrite; the specification commit recovers
  across a simulated Git-succeeded/Mongo-failed crash with exactly one
  marker commit; multiple commits sharing one exact marker fail closed
  rather than picking the newest; a base-commit conflict refuses to commit
  onto an unexpected lineage; a foreign dirty file still blocks
  specification recovery on resume; `legacy_direct` creates zero
  binding-related durable state and its own code branch contains no
  binding-related call; `run-service.ts` remains unchanged.
- `job-specs-frontend-backend.test.ts` (pinned-shape updates, no new
  tests): `jobId` prefix and exact preimage updated to
  `job_frontend_backend_`; a new assertion that the produced spec parses
  through the real `JobSpec` contract.
- `project-workspace.ts`'s `findCommitByMarker`→`findCommitsByMarker`
  refactor: existing single-match callers and their tests (Phase 5h's own
  promotion suite, `workspace.test.ts`) pass unmodified — confirmed, not
  assumed.

**Mutation testing — 13 mutations applied one at a time to the new
production code, each backed up/applied/tested/restored individually, all
killed:**

1. Ignore the `runIntentHash` mismatch check (always treat an incoming
   request as resumable) — killed: the different-intent-conflict test
   fails.
2. Resolve "latest" `businessProfile` on resume instead of the bound exact
   ref — killed (indirectly, via the downstream dirty-tree guard: rehydrating
   the wrong content collides with what the earlier spec commit already
   captured for the pinned version).
3. Call `createFrontendBackendJobSpec` again on resume instead of using the
   stored spec — killed: the stored-spec-is-authority test's call-count
   assertion fails.
4. Call `producePlan` again on resume instead of substituting the bound
   plan — killed: the retry_ready restart test's artifact-version-count
   assertion fails.
5. Ignore a `jobSpecHash` mismatch in `verifyBindingConsistency` — killed.
6. Skip `JobSpec.safeParse` in `parseStoredJobSpec` entirely (trust raw
   Mongo shape) — killed (2 unit test failures: a spec missing a required
   field, and a spec that is not even an object, both stop being rejected).
7. Randomise `bindingId` (append a timestamp) — killed by a dedicated
   exact-preimage unit test, added after the first attempt at this
   mutation went uncaught for the same millisecond-resolution reason
   Phase 5j's own `jobId` randomisation mutation once did (see that
   section) — the repeated-call-equality test alone is not reliable
   against a fast synchronous call pair.
8. Skip the marker search before committing (always attempt to write) —
   killed (falls through to the base-commit-conflict guard instead of
   silently duplicating the commit — confirmed defence in depth, not a
   gap).
9. Ignore the `specificationBaseCommit` conflict check — killed (produces
   a different, incorrect error — `SpecificationCommitProducedNothing`
   instead of the intended `BaseConflict` — confirming the guard is
   load-bearing).
10. Allow a foreign dirty path into the specification commit — killed.
11. Skip the multiple-marker corruption check (`shas.length > 1`) — killed
    (falls through to the base-conflict guard rather than silently
    succeeding — a dedicated test constructs two commits sharing one exact
    marker to exercise this).
12. Remove the `status: 'prepared'` filter from `findActivePreparedBinding`
    (resume a historical `promoted` binding as if still active) — killed:
    the next-generation test's fresh discovery collides with the wrongly
    "active" historical binding's own `runIntentHash`, surfacing as a
    conflict instead of a clean new binding.
13. Finalise the binding `promoted` *before* checking Phase 5i's own
    outcome — killed (2 test failures: both the `retry_ready` and
    `validating` restart tests find the binding incorrectly finalised).

Not independently forced through a runtime mutation, with the reason each
is still covered:

- **Ignore `binding.jobId`/`businessProfile`/`sitePlan` disagreement in
  `verifyBindingConsistency`** — code-identical in shape to mutation 5 (an
  early-return check in the same function), each already has its own
  dedicated passing unit test proving it fires today; not re-run
  individually.
- **Delete a binding on `retry_ready`/`validation_failed`, or roll back
  Phase 5h's promotion when finalisation fails** — no such code exists to
  mutate; both are structural absences (nothing in this module ever calls
  a delete on `frontendBackendBuildBindings`, and nothing calls a Git
  rollback primitive), consistent with Phase 5h's own promotion module
  never having one either.
- **Rerun Terra merely because a job is `ready`/`validating` a second
  time, or two prepared bindings coexisting for one project** — enforced
  by Phase 5i's own state machine and by the partial unique Mongo index
  respectively; both already proven in their own review (Phase 5i's own
  mutation-tested `state: 'ready'` filter; the concurrent-different-prepare
  integration test here, which exercises the real index rather than
  re-deriving its guarantee in application code).
- **Create Phase 5i's job before the binding is durable** — the binding
  creation call site sits textually before `coordinator.run(spec)` in
  `orchestrator.ts`'s fresh-path branch; confirmed by inspection, not a
  forced mutation.
- **Fuzzy marker matching** — `findCommitsByMarker`'s exact-line match is
  shared, unmodified machinery already covered by
  `workspace.test.ts`'s own "ignores unrelated commits with similar-looking
  text" case.
- **Activate `job_lifecycle` in `run-service.ts`** — covered by the
  dedicated structural test asserting the file contains neither
  `job_lifecycle` nor `frontendBackendExecutionMode`.

**Phase 5k applies only to `frontendBackendExecutionMode: 'job_lifecycle'`.**
**`legacy_direct` remains byte-for-byte unchanged and the default.** **The
active-binding check runs strictly before any discovery side effect, after
the same pure intake validation `discoverProject` itself runs.** **The
stored `JobSpec` is authority on resume; the factory runs only for a new
binding.** **Phase 5k resumes an incomplete `frontend_backend` build
lifecycle — it does not persist a general outer `runProject` phase
cursor.** **No Luna. No new Sol routing. No deployment. No production
default activation.**

### Deliberately next, not now

- **Phase 5k closed option (A) from the note above** — the durable
  run-level build binding/resume Phase 5j's own "deliberately next" section
  proposed is now implemented (see Phase 5k). Option (B) — activating
  `job_lifecycle` for one real production `runProject` caller, keeping
  `legacy_direct` available as an explicit rollback — is now implemented
  too, as Phase 5l, below.
- **Also not implemented — Phase 5k's own stated limitation:** a general
  outer-`runProject` resume cursor for *after* a build binding reaches
  `promoted` (evaluation/review/repair/release progress is not persisted;
  a process dying in that window restarts that part from scratch). Phase
  5k deliberately scoped itself to the build lifecycle alone — see that
  section's own "Scope, held exactly where the brief drew it."
- **Later still** — mapping Luna repair work onto persisted jobs, what a
  replan does to jobs from the superseded plan (`superseded` does not exist
  yet), orphaned staging cleanup (deferred deliberately, not overlooked),
  and eventually a real process boundary (workers as separate processes,
  not in-process handlers).

None of these are implemented.

### Phase 5l — activate `job_lifecycle` for one real production entrypoint — **DONE**

Phase 5k made `job_lifecycle` restart-safe; nothing had opted into it yet.
This phase activates it for exactly one real production caller, keeps
`legacy_direct` available as an explicit, operator-controlled rollback, and
closes a real corruption path the activation itself made reachable for the
first time.

**The one production entrypoint: `apps/console/app/api/runs/route.ts`.**
Inspected first, per the brief: `runProject` has exactly two non-test
callers — `run-service.ts`'s `launchRun` (the shared implementation) and
`orchestrator.ts` itself — and `launchRun` has exactly two callers,
`apps/console/app/api/runs/route.ts` (the console's own `POST /api/runs`,
a real HTTP entrypoint) and `scripts/run-agent.ts` (a headless CLI script;
its own doc comment calls it "the same entry point the console uses" only
so a CLI run shows up in the same run list — it is not itself the
production surface). The console route is the one activated. `run-agent.ts`
is deliberately untouched — the brief's own exclusion list names CLI tools
explicitly, and a structural test pins that its source never mentions
`frontendBackendExecutionMode` or `FRONTEND_BACKEND_EXECUTION_MODE`.

**Configuration is harness-owned, resolved once at process start, never at
request time.** `apps/console/lib/store.ts` gains two module-level
constants, computed the same way `WORKSPACES_ROOT` already is there (an
IIFE at import time, anchored to the repo root because Next's cwd is
`apps/console`, not the repo root):

- `FRONTEND_BACKEND_EXECUTION_MODE` — `FRONTEND_BACKEND_EXECUTION_MODE`
  env var. Unset → `'job_lifecycle'` (the production default for this
  entrypoint only). Set to `legacy_direct` → the operator rollback. Set to
  anything else → throws at module load, failing the console's
  startup/first import rather than surfacing mid-run.
- `VALIDATION_WORKSPACES_ROOT` — `VALIDATION_WORKSPACES_ROOT` env var,
  defaulting to `./validation-workspaces`. Always computed, never required:
  `legacy_direct` never reads it, so an unset value never blocks rollback.

The route's `POST` handler reads both and passes them straight into
`launchRun` alongside `body.intake`/`body.autonomyMode` — the mode is never
read from the request body, so intake content can never select a build
authority. A structural test asserts the exact wiring
(`frontendBackendExecutionMode: FRONTEND_BACKEND_EXECUTION_MODE`), not
merely that the constant is imported somewhere in the file — the weaker
check was tried first and failed to catch a mutation that dropped the
option while leaving the import in place.

**The resolution is split into two directly testable functions**, both in
`run-service.ts` (`@statxai/orchestrator`), so the production default has
one definition rather than an untestable inline expression in a Next.js
app with no test harness of its own:

- `parseFrontendBackendExecutionMode(raw: string)` — exact-match only
  (`'legacy_direct'` / `'job_lifecycle'`, trimmed of surrounding
  whitespace, case-sensitive), throws `InvalidFrontendBackendExecutionModeConfig`
  on anything else. Deliberately **not** `routing.ts`'s `BUILD_STRATEGY`
  pattern (lower-cased, unrecognised values silently ignored as "no
  override") — that fits a developer override that is optional by nature; a
  production execution mode is not, so a typo must fail loudly rather than
  silently select a build authority nobody chose.
- `resolveFrontendBackendExecutionMode(raw: string | undefined)` — the
  production default itself: unset → `'job_lifecycle'`, defined →
  `parseFrontendBackendExecutionMode(raw)`. Nothing in `run-service.ts`
  calls it; only the console's own config module does. The default's
  *location* is deliberate: not inside `runProject`, `build.ts`, Phase 5i,
  or the job engine, per the brief — one layer up, in the activated
  entrypoint's own configuration.

**`runProject`'s own internal default is untouched — still `legacy_direct`.**
Zero changes to `orchestrator.ts`. A direct `runProject(...)` call with no
`frontendBackendExecutionMode` behaves exactly as before Phase 5l, proved by
a dedicated regression test (and already guarded independently by Phase 5j's
own "legacy mode remains the default" suite). `launchRun`'s own default
mirrors it exactly (`options.frontendBackendExecutionMode ?? 'legacy_direct'`)
— every caller that never mentions the option, including the untouched
script, is unaffected by this phase.

**No runtime fallback.** Once a `launchRun` call resolves to `job_lifecycle`,
Phase 5j/5k's existing rule stands unmodified: `retry_ready`,
`validation_failed`, and every other non-`promoted` outcome surface through
the same `jobLifecycleOutcome`/`blocked` result Phase 5j already defined.
Phase 5l adds no fallback logic anywhere — there is no code path in this
phase's own additions that could fall back, verified by inspection rather
than by a forced mutation (nothing to mutate).

**A real corruption path, found and closed before activation — the
brief's own mandatory pre-activation safety check.** Inspecting
`job-promotion/frontend-backend.ts` directly: `legacy_direct`'s own
publish (`workspace.commit('Terra: build')`, an unconditional `git add
-A`) and Phase 5h's promotion both write to the same canonical Git tree
with no awareness of each other. Phase 5h's own base-commit guard
(`PromotionBaseConflict`) protects a *second* promotion attempt against a
HEAD that moved since the *first* attempt recorded its `baseCommit` — but
the *first* attempt's `baseCommit` is simply whatever HEAD is at the
moment promotion is first attempted. So the reachable failure is: a
project's `frontend_backend` job reaches `accepted`, a `legacy_direct` run
against the *same* project commits and moves HEAD forward before Phase 5h
is ever asked to promote, and promotion's first (and only) attempt then
adopts the new HEAD as its own base and commits cleanly on top of it —
silently interleaving two independent generations' files, with no error
raised anywhere. Answer to the brief's question: **no, a `legacy_direct`
invocation is not safe for a project with an active Phase 5k binding.**

**The fix is a fail-closed rollback conflict, not automatic resumption or
deletion — exactly as directed.** `launchRun` resolves its effective mode
first; if it is `legacy_direct`, it calls Phase 5k's own
`findActivePreparedBinding` (unmodified — Phase 5l does not touch the
binding module beyond this one new caller of an already-exported function)
*before* `RunRecorder.start`, before any project/budget/workspace
mutation. A `prepared` binding throws `ActiveJobLifecycleRollbackConflict`,
named with the project id and the exact binding id. This is a property of
the *project*, not of which caller asked: the guard applies identically
whether the effective mode arrived via explicit rollback configuration or
via a caller (like the untouched script) that simply never mentions the
option, since both would corrupt the same workspace the same way. The
console route catches this one exception type and returns `409`; anything
else propagates as a genuine platform failure. No binding is ever deleted,
mutated, or silently resumed by this guard — abandonment/supersession is
explicitly out of scope, exactly as directed.

**A promoted binding does not block rollback — only a `prepared` one does.**
`findActivePreparedBinding`'s own `status: 'prepared'` filter (Phase 5k,
unmodified) is what makes this true; a dedicated test proves a project
whose earlier `job_lifecycle` generation already promoted accepts a later
`legacy_direct` run cleanly, with the historical `promoted` record left
exactly as it was — still present, still exactly one, never mutated.

**Observability reuses the existing run-event stream — no new pipeline.**
`launchRun` logs `frontend_backend_execution_mode=<mode>` through the same
`recorder.event(phase, detail, level)` every other progress line already
goes through, once, right after the rollback-conflict check and before the
run itself starts. Never a `JobSpec` body, a secret, artifact content, or a
credential — the value is always one of exactly two literal strings.

**Reviewer-caught gap, closed before commit: the two workspace roots could
still collide.** `WORKSPACES_ROOT` and `VALIDATION_WORKSPACES_ROOT` having
independent env vars and independent defaults does not, by itself, stop an
operator from configuring one to equal the other — and if they did, Phase
5g-1's disposable per-validation directories would be created and torn
down *inside* the canonical Git tree `ProjectWorkspace` commits from,
exactly the "two authorities writing the same tree" defect
`ActiveJobLifecycleRollbackConflict` exists to prevent for `legacy_direct`
vs. an active binding — reachable here by a config typo instead of a race.
`assertDistinctWorkspaceRoots(workspacesRoot, validationWorkspacesRoot)`
(`run-service.ts`) canonicalises both — `path.resolve`, lexical
normalisation of `.`/`..`/relative-vs-absolute/redundant segments, not
`fs.realpath`: both roots are typically created lazily by
`ProjectWorkspace.open`'s own `mkdir(..., { recursive: true })`, so a
symlink-resolving check would have to tolerate a directory that does not
exist yet, defeating "fail closed before any filesystem write" — and
throws `WorkspaceRootsCollide`, naming the one colliding canonical
directory, if they match. `apps/console/lib/store.ts` calls it once at
module load, immediately after both roots and the resolved execution mode
are computed, gated on `FRONTEND_BACKEND_EXECUTION_MODE === 'job_lifecycle'`
— failing the console's startup/first import before any run, exactly where
the mode-parse failure already does. The gate matters: `legacy_direct`
never opens a validation workspace, so an unused, colliding
`VALIDATION_WORKSPACES_ROOT` must never become a rollback blocker (§19) —
checking unconditionally would have made a legacy-only deployment's
startup depend on job-mode-only configuration being sane, which is exactly
the coupling §19 forbids. Mutation-verified: disabling the check's own
condition (`if (false && ...)`, restored immediately after) fails both of
`assertDistinctWorkspaceRoots`'s dedicated unit tests. `apps/console`
carries no test harness of its own, so the module-load wiring in
`store.ts` (the `if (FRONTEND_BACKEND_EXECUTION_MODE === 'job_lifecycle')`
gate and the call itself) is verified by direct inspection rather than a
forced runtime mutation — the same limitation already noted above for
`VALIDATION_WORKSPACES_ROOT`'s own construction.

**Tests: 34 new (904 total, up from 870): 19 unit
(`run-service.test.ts`), 15 integration (`run-service.integration.test.ts`)**,
plus one existing Phase 5k structural test corrected to match this phase's
deliberate change (below).

- `run-service.test.ts` (19, unit, no Mongo):
  `parseFrontendBackendExecutionMode` accepting both literal values,
  tolerating incidental whitespace, and failing closed on eight distinct
  invalid inputs including case variants (`JOB_LIFECYCLE`) and near-misses
  (`job-lifecycle`) — no case-normalisation convention is claimed for this
  switch; `resolveFrontendBackendExecutionMode`'s unset/explicit/invalid
  behaviour directly; `assertDistinctWorkspaceRoots` failing closed on two
  differently-written configs that resolve to the same canonical directory
  (relative-vs-absolute, and a redundant `.` segment), naming the exact
  colliding directory in its error, and never throwing for two genuinely
  distinct roots.
- `run-service.integration.test.ts` (15): `runProject` and `launchRun` both
  still default to `legacy_direct` when the option is omitted; the
  production caller's explicit `job_lifecycle` drives the real job-mode
  path end to end and the exact `validationWorkspacesRoot` value reaches
  `runProject` (asserted via `vi.fn(actual.runProject)` wrapping the real
  implementation, not a stub — every scenario here runs genuine
  discovery/planning/Phase 5i-5k machinery); the selected mode is logged
  through the real run-event stream; explicit `legacy_direct` runs the real
  direct builder with zero binding/job side effects and does not require
  `validationWorkspacesRoot` at all; a forced `retry_ready` never invokes
  the direct builder; **a second `launchRun` call for the same project — a
  fresh call, proving the real restart-safe path rather than a test-only
  adapter — resumes the exact Phase 5k binding**, with zero new
  `business-profile`/`site-plan` artifact versions, zero additional
  `planSite` calls, and exactly one specification commit across both
  calls; a promoted binding frees the project for a later `legacy_direct`
  run while the historical record survives untouched; **the mandatory
  active-binding-conflict scenario**: a project with a `prepared` binding
  refuses a `legacy_direct` `launchRun` before the legacy builder runs,
  leaving the binding, the job document, and canonical Git history
  byte-for-byte unchanged, and creating no run record for the rejected
  attempt; two structurally different intakes both resolve to whatever mode
  was configured, never to something intake-dependent; no source file under
  `@statxai/agents` mentions either execution-mode literal (the model can
  never see or choose one); the console route wires the mode from its own
  config into the exact `launchRun` call, never from the request body; the
  script never mentions the mode at all; no other console API route
  references it either.
- `frontend-backend-build-binding.integration.test.ts`'s own Phase 5k
  suite "run-service.ts remains unchanged" is renamed and its assertion
  corrected: its literal "the file mentions neither string at all" check
  is now obsolete *by design* — Phase 5l's whole point is that
  `run-service.ts` does mention them. What it actually protected —
  `launchRun`'s own default staying `legacy_direct` for an unconfigured
  caller — is pinned directly instead, with a note explaining why the
  change is deliberate rather than a regression a future reader should
  investigate.

**Mutation testing — 9 mutations applied one at a time to Phase 5l's own
new production code, each backed up/applied/tested/restored individually,
all killed:**

1. Production default flipped back to `legacy_direct`
   (`resolveFrontendBackendExecutionMode`'s unset branch) — killed.
2. `runProject`'s own internal default changed to `job_lifecycle`
   (`orchestrator.ts`, reverted immediately after) — killed twice over: by
   this phase's own regression test and, independently, by Phase 5j's
   pre-existing "legacy mode remains the default" suite.
3. The rollback-conflict guard disabled (`if (false)` in place of the mode
   check) — killed: the mandatory active-binding-conflict test failed with
   "promise resolved instead of rejecting" once the legacy builder was
   allowed to run unchecked.
4. Invalid config silently mapped to `legacy_direct` instead of thrown —
   killed (10 unit-test failures).
5. Invalid config silently mapped to `job_lifecycle` instead of thrown —
   killed (10 unit-test failures).
6. The console route's `launchRun` call stopped passing
   `frontendBackendExecutionMode` (leaving the now-unused import in place)
   — **not** killed by the first version of the structural test, which
   only checked that the constant's name appeared somewhere in the file;
   strengthened to check the exact wiring pattern
   (`frontendBackendExecutionMode:\s*FRONTEND_BACKEND_EXECUTION_MODE`),
   which then killed it. Kept as the permanent test.
7. `scripts/run-agent.ts` given its own explicit
   `frontendBackendExecutionMode: 'job_lifecycle'` (a second caller
   activating job mode) — killed by the dedicated one-caller structural
   test.
8. `findActivePreparedBinding`'s `status: 'prepared'` filter dropped
   (temporarily, to verify the rollback-conflict guard's own dependency on
   it — not a permanent change; Phase 5k's binding module is otherwise
   untouched by this phase) — killed: the promoted-history-does-not-block
   test failed with the exact `ActiveJobLifecycleRollbackConflict` a
   correctly-scoped filter must never raise against a merely-historical
   record.
9. `assertDistinctWorkspaceRoots`'s own comparison disabled
   (`if (false && ...)`) — killed: both of its dedicated unit tests failed.

Not independently forced through a runtime mutation, with the reason each
is still covered:

- **Delete or mutate an active binding on rollback** — no such call exists
  anywhere in `run-service.ts` to mutate (confirmed by inspection:
  `frontendBackendBuildBindings` is never named there at all; the only
  binding-module call is the unmodified, read-only
  `findActivePreparedBinding`).
- **Runtime fallback after `retry_ready`/`validation_failed`** — Phase 5l
  adds no fallback code path anywhere for a mutation to target; the
  no-fallback property is Phase 5j/5k's own, already mutation-tested in
  their own reviews, and re-exercised here through the real `launchRun`
  boundary rather than re-proven from scratch.
- **Intake or a model call selecting the mode** — structurally impossible
  by construction: `frontendBackendExecutionMode` in `run-service.ts`
  derives only from `options.frontendBackendExecutionMode` (never
  `options.intake`), and the file imports nothing from `@statxai/agents` at
  all — confirmed directly, and independently by the dedicated test that
  scans every source file under `packages/agents/src` for either literal.
- **`run-service.ts` activating Luna or changing deployment behaviour** —
  confirmed by inspection: neither "luna" nor "deploy" appears anywhere in
  the file.
- **Validation root pointing at the canonical workspace** — two distinct
  env vars with two distinct defaults do not, on their own, rule this out
  by operator misconfiguration; closed by `assertDistinctWorkspaceRoots`
  (mutation 9, above), which fails closed on collision rather than
  assuming the two are always different. `apps/console` carries no test
  harness to force a mutation of `store.ts`'s own module-load wiring (the
  gate and the call site) through, so *that* half is asserted by
  inspection rather than a forced runtime failure — the check itself is
  mutation-verified directly. The genuinely runtime-testable half — that
  `launchRun` forwards whatever `validationWorkspacesRoot` value it is
  given, unchanged, into `runProject` — is covered directly (mutation not
  required: the pass-through is a straight-line data flow with no branch
  to mutate independently of mutation 6 above).

**Scope, held exactly where the brief drew it:**

- Exactly one production caller activated. `scripts/run-agent.ts` is
  unmodified. No other `apps/console` API route references the execution
  mode.
- `orchestrator.ts`, `packages/job-engine`, Phase 5i's coordinator, and
  Phase 5k's binding module (`run-binding/frontend-backend.ts`) are all
  byte-for-byte unchanged — confirmed by `git diff` showing zero lines
  touched in any of them.
- No Luna, no repair-cycle changes. No deployment/release-authorization
  changes. No multi-role cutover — only `frontend_backend` uses the Phase
  5 lifecycle, unchanged from Phase 5j/5k.
- No background worker, poller, or scheduler added — the production
  request still explicitly drives the bounded lifecycle, exactly as
  before.
- No binding abandonment/supersession/cancellation capability added — an
  active binding blocking rollback is left exactly as found until it
  promotes (or a later, separate capability retires it).
- Post-promotion `runProject` phases (evaluation, review, repair, release)
  remain unresumable across a restart — Phase 5k's own stated limitation,
  untouched by this phase.

**Explicit statements, as the brief requires:**

Phase 5l activates `job_lifecycle` for exactly one real production
entrypoint. `runProject` itself still defaults to `legacy_direct`.
`legacy_direct` remains available as an operator-selected rollback mode.
Rollback selection happens before `runProject` execution; Phase 5l does not
add dynamic runtime fallback. Phase 5l does not delete or supersede active
Phase 5k bindings. Phase 5l does not add Luna repair. Phase 5l does not
change deployment behaviour. Phase 5l does not activate any other worker
role.

## Phase 5m — explicit active build abandonment + pre-acceptance job supersession — **DONE**

Phase 5l's own guard left a real operational gap: a project with a
genuinely stuck `prepared` Phase 5k binding had no explicit escape
hatch — the binding correctly blocked both `legacy_direct` rollback and a
fresh `job_lifecycle` generation until it promoted, with no way for an
operator to end that wait. Phase 5m adds exactly one explicit,
harness-owned action: abandon one exact binding, and — atomically —
permanently revoke its job's pre-acceptance execution authority.

**Scope, drawn exactly where the brief drew it: pre-acceptance only.**
Inspecting `job-promotion/frontend-backend.ts` directly: an `accepted` job
may already be entering Phase 5h's canonical promotion path, and a
Mongo-only "supersede accepted" write cannot prove promotion has not
already crossed from Mongo authority into filesystem/Git mutation.
Revoking an accepted-but-unpromoted job needs a dedicated promotion fence
this phase does not add. So: `prepared` binding + `accepted` job → fails
closed (`FrontendBackendBuildAbandonmentAcceptedConflict`), never
resolved here. See Phase 5n, proposed below.

### The binding: a third historical status

`FrontendBackendBuildBindingStatus` gains `'abandoned'`, alongside
`'prepared'`/`'promoted'`. Three new optional fields —
`abandonedAt`/`abandonedBy`/`abandonmentReason` — are set together, only
once, only on that transition. Optional rather than
`| null`-defaulted deliberately: a binding written before Phase 5m existed
simply lacks all three, which is a normal `prepared`/`promoted` document,
not one needing a migration. `StateStore.ensureIndexes`'s partial unique
index (`{ projectId: 1 }`, filtered to `status: 'prepared'`) is
**untouched** — `'abandoned'` falls outside that filter by construction,
exactly like `'promoted'` already does, so the active slot is released and
a later `legacy_direct` rollback or fresh `job_lifecycle` generation
proceeds normally. `findActivePreparedBinding` (Phase 5k, also untouched)
is what makes this true everywhere it's read — Phase 5l's rollback guard
and Phase 5k's own resume lookup both automatically stop treating an
abandoned binding as active, with zero changes to either.

### `JobState` gains `superseded`

Reachable from every pre-acceptance state — `draft`, `ready`, `running`,
`validating`, `failed`, `repair_requested`, `blocked` — and from nowhere
else; **not** from `accepted`. `TRANSITIONS.superseded = []`: fully
terminal, no outgoing edge, ever. The architecture-review note this
`TRANSITIONS` table used to carry ("there is no `superseded` state... left
as the document specifies rather than invented here") is retired along
with the state it described the absence of.

**`TERMINAL_JOB_STATES` stays exactly `['accepted']` — inspected before
touching it, per the brief.** Grepped first: nothing in the codebase reads
it today. Its meaning is not "every state with no outgoing edge" (both
`accepted` and `superseded` are that, structurally) — it is specifically
*successful* completion, the one state `JobEngine.dependenciesSatisfied`
checks a dependency against. Adding `superseded` to it would make a
permanently-revoked upstream job's dependents look unblocked the moment it
became terminal-looking, which is exactly backwards. Left alone, with a
doc comment now stating the distinction explicitly so a future consumer
does not have to re-derive it.

**Superseded is terminal by omission, not by a new special case.** `claim`
only ever matches `state: 'ready'`; `dependenciesSatisfied` only ever
counts `state: 'accepted'`; `block`/`release`/`requestRepair`/`accept`
(unguarded)/`transitionOwnedRunning` (`submitForValidation`/`fail`) all
guard on explicit `from` arrays that simply never include `'superseded'`.
None of these needed to change — a state nothing's `from` list names is
already unreachable from everywhere else, for free.

### `JobEngine.supersede(jobId, actor, { reason, bindingId?, now?, session? })`

The one new transition. Guarded exactly like every other one here: a
`findOneAndUpdate` filtered on `state: { $in: [...seven pre-acceptance
states] }`. An `accepted` job is not special-cased — it is simply absent
from that list, so the guard matches nothing and the call fails closed
with the same `JobStateConflict` every other wrong-state attempt in this
file produces (defense in depth: `abandonFrontendBackendBuild`'s own
explicit accepted-check normally catches this first, but this guard would
catch it independently if that check were ever removed — mutation-verified
directly).

- **`reason` is required**, non-empty after trimming
  (`InvalidSupersessionReason` otherwise) — the audit trail this produces
  is the only durable record of why a specific execution was permanently
  revoked.
- **A `running` job's lease is cleared unconditionally** (`{ lease: null }`
  in the guarded `$set`), regardless of who currently holds it. Harness
  authority overriding a worker's claim, not the worker relinquishing its
  own.
- **`session`**, when supplied, participates in the caller's own
  transaction — no second one opened. This is what lets
  `abandonFrontendBackendBuild` move the binding and the job atomically.
- **Audit**: the private `transition()` helper gained two additive,
  backward-compatible parameters — `now` and `auditDetail` — so
  `supersede`'s `reason`/`bindingId` land in the same `job_transition`
  audit entry every other transition already writes, without a second
  write or a bespoke audit path.

**Why a stale worker cannot advance the job afterward — reused machinery,
not new code.** `heartbeat`/`submitForValidation`/`fail` all guard on
`state: 'running'` via `transitionOwnedRunning`; once superseded, none of
them match. `JobRunner` (`packages/job-engine/src/runner.ts`) already
reports `{ kind: 'authority_lost', reason: 'heartbeat_lost' |
'transition_conflict' }` for exactly this shape of loss — Phase 5c/5f's
own existing mechanism, verified here (a dedicated race test: a runner's
handler blocks until its abort signal fires; an operator abandons the
job mid-execution; the runner reports `authority_lost` and the job never
reaches `validating`) rather than assumed. **Zero changes to
`packages/job-engine/src/runner.ts`.**

### `abandonFrontendBackendBuild({ projectId, bindingId, actor, reason }, { store, engine })`

`packages/orchestrator/src/run-binding/frontend-backend.ts` — the module
that already owns Phase 5k's binding lifecycle owns this too, rather than
splitting binding authority across two files.

**Exact identity, not "the project's current active binding".** Loads by
`_id: bindingId`, then verifies `binding.projectId === projectId`. A
fabricated or stale `bindingId` fails with
`FrontendBackendBuildBindingNotFound`/`FrontendBackendBuildBindingProjectMismatch`
and **never falls back** to whatever is active for that project now — the
brief's own stale-request scenario (an operator inspects binding A, A
completes or is abandoned, B becomes active, a delayed request for A
arrives) must never touch B. Verified directly: the first version of the
"fabricated bindingId" test passed by coincidence (the fixture project had
no other binding at all); strengthened to give the project a genuine
active binding first, which is what actually caught a deliberately
introduced not-found-falls-back-to-active-binding mutation.

**One Mongo transaction, start to finish** (`store.withTransaction` — the
driver retries the whole callback on a transient conflict, so every read
inside is safe to re-take on retry):

1. Load the binding by exact id; verify project; **`'abandoned'`/`'promoted'`
   status returns the matching historical outcome, read-only** — no second
   transition, no mutation of a binding this call did not just abandon
   (idempotent replay, mutation-verified: disabling this short-circuit
   makes a repeat request throw instead of replaying cleanly).
2. Only `'prepared'` continues. `parseStoredJobSpec` +
   `verifyBindingConsistency` first — reused from Phase 5k, unchanged —
   never abandon corrupt binding state blindly.
3. If `binding.jobId` names an existing `JobDocument`: verify it actually
   describes this binding (`projectId`, `role`, and the live job's `.spec`
   still content-hashing identically to the binding's own stored one —
   `FrontendBackendBuildAbandonmentJobMismatch` otherwise). Then, in
   order: promotion-evidence check (`store.promotions.findOne({ jobId
   })`, independent of job state — `FrontendBackendBuildAbandonmentPromotionEvidenceConflict`
   on any hit, mutation-verified), accepted check
   (`FrontendBackendBuildAbandonmentAcceptedConflict`, mutation-verified),
   then `engine.supersede(job._id, actor, { reason, bindingId, session })`.
   **No `JobDocument` at all** (Phase 5k's own crash point — a binding
   prepared before Phase 5i ever enqueued) is valid and expected: nothing
   is superseded, and no fake job is invented to be superseded.
4. Guarded `prepared -> abandoned`, same session, recording
   `abandonedAt`/`abandonedBy`/`abandonmentReason`.

**The acceptance-vs-abandonment race resolves to exactly the two outcomes
the brief requires, with no extra locking.** Both `acceptValidatedFrontendBackendCandidate`
(5g-2, unmodified) and this function read the job fresh inside their own
transaction and guard their write on the state they just read; MongoDB's
own transaction conflict/retry semantics do the rest:

- This transaction commits first → job `superseded`, binding `abandoned`;
  5g-2's attempt (racing or retried) reads `state !== 'validating'` and
  throws `AcceptanceBindingStale` — its own, pre-existing guard, untouched.
- 5g-2 commits first → job `accepted`; this transaction, retried by the
  driver, reads that fresh and throws
  `FrontendBackendBuildAbandonmentAcceptedConflict` — binding stays
  `prepared`, for a human (or Phase 5n) to resolve.
- The mixed case — binding `abandoned`, job `accepted` — is not reachable
  by construction. Verified directly: a real `Promise.allSettled` race
  between the two against a genuine `validating` job (real 5g-1 evidence,
  real registry, real gates), asserting the invariant holds regardless of
  which side actually won.

**What this never does, enforced by what its own dependencies are, not
merely by convention.** `AbandonFrontendBackendBuildDeps` is `{ store,
engine }` — no `registry`, no `workspace`, no `model` (a dedicated
structural test greps the interface's own source for any of the three).
So by construction it cannot: delete an artifact, touch the canonical
Git workspace, call `git reset`/commit/revert, or call a model. It never
modifies a `JobPromotionRecord` either — only reads one, to check for its
existence. And it never starts a replacement: no call to `runProject`,
`discoverProject`, `producePlan`, Terra, or Luna anywhere in the module
(grepped directly) — abandonment stops after revocation; what happens
next is a separate, later, explicit request.

### The production operator surface — and a gap the brief required reporting, not working around

**Investigated first, per the brief's own explicit instruction (§24):
`apps/console` has no authentication of any kind.** No `middleware.ts`
exists; no auth dependency (`next-auth`, `clerk`, session/cookie handling)
appears anywhere in the repo; every existing API route
(`GET`/`POST /api/runs`, `GET /api/runs/[runId]`, `GET /api/preview/...`)
performs zero identity checks. Anyone who can reach the console's port can
already call every existing route.

**Per §24 and §48: an unauthenticated HTTP abandonment endpoint was not
added.** Adding one "merely to complete Phase 5m" would let any
unauthenticated caller revoke a production build — a materially worse
outcome than the gap it would close. Instead:

- `scripts/abandon-build.ts` (`pnpm build:abandon <projectId> <bindingId>
  <reason...>`) is the operator surface — the same trust boundary every
  other script in `scripts/` already relies on (`db-check.ts`,
  `gate-check.ts`, `run-agent.ts`): whoever can run a script on this host
  already has the access an operator action requires. `actor` is derived
  from `os.userInfo().username`, **never a `--actor` flag** — the same
  discipline §23 asks of a real authenticated route, applied here to the
  one identity source a CLI script actually has. A structural test pins
  both: the script uses `userInfo()`, and never matches `--actor`.
- No HTTP route in `apps/console` references `abandonFrontendBackendBuild`
  at all — a dedicated structural test asserts this by scanning every
  route file. §89's "add the strongest available structural test" is this:
  the strongest available proof that an unauthenticated actor cannot reach
  this capability is that no network-reachable path to it exists.

**This is a gap worth closing, explicitly flagged rather than quietly
left implicit:** the console has no operator authentication for *any* of
its existing routes, not just this new one. Phase 5m does not attempt to
add one — that is a distinct, larger capability (who counts as an
operator, how they authenticate, what else should be gated behind it) than
"abandon one build."

### Phase 5i and 5j: a legitimately abandoned job is not a platform error

`FrontendBackendLifecycleResult`'s outcome union gains `'superseded'`,
alongside the other simple state-outcomes it already had
(`in_progress`/`retry_ready`/.../`draft`). The coordinator's `advance()`
switch gains one matching `case`, returning immediately — no model call,
no validation, no acceptance, no promotion (mutation-verified: making this
case fall through to `runner.runOnce()` instead produces an infinite
loop/timeout, since nothing ever changes the job's state back to `ready`).

**`orchestrator.ts` needed zero changes.** `jobLifecycleOutcome` is typed
as `FrontendBackendLifecycleResult['outcome']` — a structural derivation,
not a hand-maintained union — so `'superseded'` propagates automatically.
The existing `if (result.outcome !== 'promoted')` branch already treats
every non-`promoted` outcome identically: `RunResult.outcome` becomes
`'blocked'`, `jobLifecycleOutcome` carries the exact value, no fallback, no
downstream evaluation. A stale in-flight invocation that resolved the
active binding and its spec *before* a concurrent operator abandonment —
the same race window a process restart or a slow request could land in —
observes this exact path, verified directly by replaying that sequence
manually with the coordinator (resolve binding → abandon concurrently →
call `coordinator.run(spec)` with the pre-abandonment spec) rather than
trying to force a non-deterministic race through the full `runProject`
entrypoint.

A fresh `job_lifecycle` invocation never resumes an abandoned binding —
`findActivePreparedBinding`'s `status: 'prepared'` filter (Phase 5k,
untouched) already excludes it, so the fresh path runs exactly as it did
before Phase 5m: new discovery, new planning, a new deterministic
`JobSpec`/`jobId`. Verified end to end: a generation stuck in
`retry_ready`, abandoned, then a second `job_lifecycle` invocation for the
same project produces a **new** binding with a **different** `jobId`,
reaches `released`, and the first generation's job is still, and remains,
`superseded`.

### Tests

**Unit: 6 new** (`packages/contracts/test/job.test.ts` — `superseded`
transition table coverage, `TERMINAL_JOB_STATES` exclusion). **Integration:
46 new** — 15 in `packages/job-engine/test/engine.test.ts`'s new
`describe('supersede (Phase 5m)', ...)` (every allowed source state, the
accepted rejection, lease clearing, reason validation, audit detail,
external-session participation, terminal-non-runnability across every
other `JobEngine` method, dependency non-satisfaction, lease-reaper
non-interference), 31 in the new
`packages/orchestrator/test/frontend-backend-build-abandonment.integration.test.ts`
— split into a low-level part (`abandonFrontendBackendBuild` against
bindings/jobs built with Phase 5k's own primitives, no model calls: every
pre-acceptance state, no-job-yet, accepted rejection, promotion-evidence
rejection, exact-identity guards including the fabricated-id case above,
idempotent replay, promoted immunity, active-slot release with history
preserved, reason validation, no-auto-abandonment, and five structural
scope-boundary tests) and a full-pipeline part reusing real 5g-1/5g-2/5h/5i
machinery (stale 5g-1 evidence, the acceptance race, the runner-authority
race, the Phase 5i outcome, the stale-invocation race, a full new
generation after abandonment, and legacy rollback both before and after
abandonment). **Total: 952 (up from 904).**

### Mutation testing

**13 mutations applied directly to Phase 5m's own new production code**
(`run-binding/frontend-backend.ts`, `job-engine/engine.ts`,
`job-lifecycle/frontend-backend.ts`), each backed up under distinct
filenames, applied, tested, and restored individually — restoration
verified byte-for-byte against the backup after every single one, not only
at the end:

1. Binding deleted instead of marked `abandoned` — killed (two tests: the
   no-job-yet case and active-slot-release/history).
2. `findActivePreparedBinding` loosened to also match `'abandoned'` —
   killed (wrong binding returned to the active-slot-release test).
3. Accepted-job check disabled — killed, and revealed a second,
   independent guard: `JobEngine.supersede`'s own state filter rejects
   `accepted` regardless, so the call still fails, just via a different
   error type the test correctly distinguishes.
4. Promotion-evidence check disabled — killed.
5. Exact-`bindingId` lookup given a same-project active-binding fallback
   on miss — **not killed by the original test suite**, because the
   existing "unknown bindingId" fixture had no other binding to fall back
   to. Strengthened with a dedicated fixture (a fabricated id against a
   project that *does* have a real active binding) that catches it, and
   confirmed the original assertion (binding + job left completely
   untouched) still holds once restored.
6. `projectId` mismatch check disabled — killed.
7. Idempotent-replay short-circuit disabled — killed (the second call
   throws instead of returning `already_abandoned`).
8. Phase 5i's `superseded` case changed to attempt execution instead of
   stopping — killed (infinite loop / test timeout, since nothing returns
   the job to `ready`).
9. `JobEngine.supersede`'s lease-clearing removed — killed.

Not independently forced through a runtime mutation, with the reason each
is still covered:

- **Job/binding writes outside the shared transaction.** Both writes
  already go through the one `session` this function opens (or is handed);
  there is no code path that could write either outside it without
  removing the `session` parameter from the calls entirely, which is
  mutation 5's own territory (already covered) plus a straightforward
  read of the function — there is exactly one `withTransaction` call and
  every write inside it takes `{ session }`.
- **`superseded` satisfying a dependency, `release`/`claim`/etc. accepting
  it.** No code exists in any of those methods that mentions
  `'superseded'` at all to mutate — their `from`/eligibility lists simply
  never name it, confirmed by reading each one directly (`packages/contracts/test/job.test.ts`
  and `engine.test.ts`'s own "permanently non-runnable" test independently
  pin the resulting behaviour).
- **Auto-abandonment on `retry_ready`/`failed`/etc.** No caller of
  `abandonFrontendBackendBuild` or `engine.supersede` exists anywhere
  except the CLI script and (in tests) direct calls — grepped directly,
  and pinned by a dedicated structural test.
- **Abandonment deleting staged artifacts or performing a Git
  mutation.** `AbandonFrontendBackendBuildDeps` has no `registry`/
  `workspace` field to call either through — structurally impossible, not
  merely untested (dedicated structural tests assert both the dependency
  shape and the absence of the relevant calls in source).
- **A production API route supersedes an arbitrary role.** No such route
  exists — the only production surface is the CLI script, scoped to
  exactly `frontend_backend` by construction (it calls
  `abandonFrontendBackendBuild`, which itself only ever touches
  `frontend_backend_build_bindings` and the one job a binding names).

### Scope, held exactly where the brief drew it

- Accepted-but-unpromoted jobs are never abandoned in this phase — see
  Phase 5n, proposed below.
- No Git mutation, ever — no reset, revert, or history rewrite.
- No artifact or staging-output deletion.
- No automatic abandonment — explicit operator action only, every time.
- No replacement build started by the abandonment action itself.
- No Luna, no Sol decision authority over abandon-vs-resume.
- No deployment/release behaviour changed.
- No other worker role reachable through this capability.
- `FRONTEND_BACKEND_EXECUTION_MODE`, `runProject`'s internal default, and
  the Phase 5l workspace-root collision guard are all untouched.

**Explicit statements, as the brief requires:**

Phase 5m abandons only a specific exact active binding selected by
bindingId. Phase 5m atomically abandons the prepared binding and
supersedes its pre-acceptance job when that job exists. Phase 5m does not
delete jobs, bindings, staged artifacts, or Git history. Phase 5m
permanently prevents a superseded job from becoming runnable again. Phase
5m does not automatically start a replacement build. Phase 5m does not
abandon accepted jobs. Phase 5m does not add Luna repair. Phase 5m does
not change deployment behavior.

### Deliberately next, not now

**Phase 5n — accepted-build promotion fence + safe abandonment.** The gap
Phase 5m's own scope boundary names explicitly: make accepted-but-unpromoted
abandonment safe by introducing a durable promotion authority/fence, so
Phase 5h cannot begin canonical mutation after an abandonment wins, and
abandonment cannot win after Phase 5h already owns the fence — without
inventing a Mongo/filesystem/Git distributed-transaction fiction. This is
what the section below implements.

## Phase 5n — durable accepted-build promotion fence + safe accepted-state abandonment — **DONE**

Closes the gap Phase 5m left open: an `accepted` job could never be
abandoned, because nothing durable could tell whether Phase 5h had already
begun canonical publication. Kept intentionally compact — see
`packages/job-engine/src/engine.ts`, `packages/contracts/src/job.ts`,
`packages/orchestrator/src/job-promotion/frontend-backend.ts`, and
`packages/orchestrator/src/run-binding/frontend-backend.ts` for the full
reasoning in each module's own doc comments.

**The fence.** `JobDocument.promotionFence?: JobPromotionFence | null`
(`@statxai/contracts`) — `{ promotionId, attempt, candidate, baseCommit,
acquiredAt }`, stored on the same `JobDocument` promotion and abandonment
already compete over, rather than a second collection/lock. `undefined`
and `null` both mean "no fence" (a legacy pre-5n document simply lacks the
key; the Mongo guard `{ promotionFence: null }` matches both by Mongo's
own semantics). **Durable, not a lease** — no `expiresAt`, no heartbeat, no
`releasePromotionFence`; once acquired it is permanent evidence, because
canonical filesystem/Git mutation may already have happened by the time
anything reads it again. `accepted -> superseded` is now a legal table
entry (`contracts/src/job.ts`), but only the one narrow, fence-checked
`JobEngine` method below actually offers it — the generic `supersede()`'s
own guarded filter still never names `accepted`, unchanged since Phase 5m.

**`JobEngine.acquirePromotionFence(jobId, { promotionId, attempt, candidate,
baseCommit, actor, now?, session? })`** — legal only from `state:
'accepted'`. First call: durably writes the fence, guarded atomically on
`{ state: 'accepted', attempt, promotionFence: null }`, after re-verifying
`attempt`/`candidate` against the job's own current durable state
(`PromotionFenceBindingConflict` otherwise). Exact-same-fence replay is a
read-only no-op (same `acquiredAt`, no duplicate audit) — safe to call on
every promotion attempt, including a pure replay of an already-`committed`
historical promotion, which is what makes this double as "re-prove fence
ownership before touching the canonical tree again." A genuinely different
fence already present: `PromotionFenceConflict`, never overwritten.
**`JobEngine.supersedeAcceptedBeforePromotion(jobId, actor, { reason,
bindingId?, now?, session? })`** — the one place `accepted -> superseded`
actually happens: guarded on `{ state: 'accepted', promotionFence: null }`;
a fence already present fails with `PromotionFenceOwned`. Both share
`supersede()`'s existing audit/session/reason conventions exactly — no
second audit pipeline.

**Phase 5h's new sequence** (`promoteAcceptedFrontendBackendCandidate`):
prove the accepted job/candidate (unchanged) → read-only preflight for an
existing receipt (its `baseCommit`, if any, is authoritative — never
re-read from HEAD, so a legacy receipt and its backfilled fence can never
disagree) → **acquire the fence** → only then create a new `prepared`
receipt if none existed → unchanged marker lookup/materialise/commit/
finalise. The fence acquisition is what serialises promotion against
accepted-state abandonment: a stale invocation whose job abandonment
already superseded fails right there, with a `JobStateConflict`, before a
receipt is ever created or a single file touched. `FrontendBackendPromotionDeps`
gained one field, `engine: JobEngine`.

**Accepted-state abandonment** (`abandonFrontendBackendBuild`, `run-binding/
frontend-backend.ts`) — Phase 5m's blanket "accepted always fails" is
narrowed: an accepted job may now be abandoned when, in order, (1) no
existing `JobPromotionRecord` exists at all (Phase 5m's own check,
preserved — this is what still protects a legacy job promoted before a
fence was ever backfilled onto it), (2) no `promotionFence`
(`FrontendBackendBuildPromotionOwned` otherwise — the dedicated error the
brief asked for), (3) no downstream job already depends on it
(`FrontendBackendBuildAbandonmentDownstreamDependency` — Phase 5n does not
recursively revoke a dependency graph). Only then:
`supersedeAcceptedBeforePromotion`, in the same transaction as the
binding's own `prepared -> abandoned`. `FrontendBackendBuildAbandonmentAcceptedConflict`
(Phase 5m's blanket rejection) is retired — nothing throws it any more.
The accepted candidate's `acceptedAt` is never touched either way; only the
job that held it becomes `superseded`, so it can never again reach
promotion through that job.

**The race, resolved by MongoDB's own transaction conflict/retry — no
extra locking.** Both sides read the job fresh inside their own
transaction and guard their write on what they just read: whichever
transaction commits first durably wins, and the loser's retried read sees
the winner's result and fails closed (abandonment sees the fence and
throws `FrontendBackendBuildPromotionOwned`; promotion sees `state !==
'accepted'` and throws `JobStateConflict`). Verified three ways: each
ordering pinned deterministically, plus one real `Promise.allSettled` race
against genuine concurrent Mongo transactions — the forbidden combination
(abandoned binding + any successful new promotion) is checked directly,
not inferred from timing.

**Legacy compatibility, verified not assumed.** A pre-5n `prepared` receipt
with no fence: Phase 5h backfills a fence matching the receipt's own
identity exactly and continues — no replacement receipt. A `committed`
receipt with its marker already in history, no fence: stays idempotent,
backfills the same way, no duplicate commit. Both are still blocked from
accepted-state abandonment by the unmodified promotion-evidence check
regardless of whether a fence was ever backfilled onto them.

**Scope held exactly where the brief drew it:** no HTTP abandonment
endpoint (the console still has no authentication — unchanged gap, not
addressed here); `scripts/abandon-build.ts` gained three caught-error
messages for the new domain errors, nothing else; no Luna; no deployment
change; no change to Phase 5g-1/5g-2, Phase 5k binding identity, Phase 5l
configuration/defaults, or `runProject`'s own default.

**Tests: net +26 (954 → 980), across the same 53 files — no test file was
added or removed.** +1 unit (`packages/contracts/test/job.test.ts`: the
`accepted -> superseded` transition is now structurally legal, so the two
tests asserting the opposite were replaced by three) and +25 integration:
`JobEngine`'s `acquirePromotionFence`/`supersedeAcceptedBeforePromotion`
(+13 — note `packages/job-engine/test/engine.test.ts` runs in the
*integration* suite, not the unit one, per `vitest.integration.config.ts`'s
own named-includes list), the Phase 5h fence sequence including both
mandatory crash scenarios and both legacy-receipt shapes (+6), and
accepted-state abandonment's four outcomes plus the three mandatory race
scenarios — abandonment-first, promotion-first, and the real concurrent
race (+6, net of the single blanket "accepted always fails" test Phase 5n
replaced). Full regression suite (5h/5i/5k/5l/5m) green throughout,
including two pre-existing Phase 5h tests whose `Collection.prototype`
crash-simulation mocks had to be narrowed to their exact intended
collection once Phase 5n added an earlier `findOneAndUpdate` call
(`jobs`, inside `acquirePromotionFence`) that a collection-agnostic
`mockImplementationOnce` would otherwise have caught instead.

Mutation-tested: fence-before-mutation ordering, the four fail-closed
guards (state, attempt/candidate binding, foreign fence, accepted-only
supersession), idempotent replay, and the accepted-abandonment gate
sequence (evidence check, fence check, dependency check) — see the
completion report for the exact list and kill results.

**Explicitly:** Phase 5n serializes accepted-build abandonment and
canonical promotion through one durable promotion fence, stored on the
job. Phase 5h cannot begin canonical publication unless the authoritative
accepted job owns the exact expected fence. The fence never expires and is
never cleared automatically. The canonical base commit lives inside the
fence so a restart can never silently adopt a different HEAD. Accepted
candidate history remains intact after abandonment. No replacement build,
no HTTP endpoint, no Luna, no deployment change.

## Phase 5o — one authenticated operator boundary for the production console — **DONE**

Phase 5l put the real production website-generation entrypoint in
`apps/console`, and Phase 5m's inspection recorded what that meant: the
console had no authentication of any kind, so anyone who could reach the
port could start production runs and read every run, project and generated
site. Phase 5o closes that, and nothing else.

**Mechanism: HTTP Basic (RFC 7617), one configured operator.** Chosen from
how the console is actually used, not from preference: `launch-form.tsx`
POSTs `/api/runs`, `run-view.tsx` polls `/api/runs/<id>` every two seconds,
and the preview is an `<iframe>` loading `/api/preview/<projectId>` — all
browser traffic. A bearer token would have to be handed to that client-side
JavaScript, which is exactly what a server-side credential must never be.
Basic is the one browser-safe transport needing no login page, no session
store, no cookie signing and no new dependency: the browser holds the
credential in its own credential cache, attaches it to same-origin
subresources (the preview iframe included) and never exposes it to page
scripts; `curl -u` works at a terminal for the same reason. No identity
provider was added (no Auth0/Clerk/NextAuth/Supabase), no user database, no
roles — Phase 5o has exactly one authority, the console operator.

**The primitive** — `apps/console/lib/auth.ts`, the single authority:
`requireConsoleOperator(request) -> ConsoleOperatorPrincipal | Response`
over `authenticateConsoleOperator`. `ConsoleOperatorPrincipal` is
`{ id, authMethod: 'basic' }` and nothing else; `id` is read from the
*configuration*, never from the submitted credential, so no byte of request
content can reach the principal even if the comparison were weakened.
Runtime-agnostic on purpose — Next middleware runs on the Edge runtime, so
the file imports no `node:` builtin: `atob`, `TextDecoder` and Web Crypto
only. Comparison is constant-time over SHA-256 digests of both sides, which
also makes different-length inputs compare over a fixed 32 bytes; both
halves of the credential are always compared, so timing never reveals that
the user id alone was right. Malformed input (wrong scheme, non-base64,
invalid padding, no colon) returns the ordinary failure rather than
throwing.

**Configuration** — `CONSOLE_OPERATOR_USER` and `CONSOLE_OPERATOR_PASSWORD`,
server-side only, read live per request. Missing, empty, whitespace-only, or
a user id containing a colon (unrepresentable in `user:password`) all
resolve to "no credential configured", and every caller turns that into a
**503**, never an anonymous request. There is no environment value in any
runtime that disables authentication, and no bypass was added.

**The boundary** — `apps/console/middleware.ts` protects the whole console,
pages included: the dashboard and run pages read run state directly in
their server components, so protecting only `app/api/**` would leave the
same data readable one URL over. Only `_next/static`, `_next/image` and
`favicon.ico` are excluded — framework build output, no run state. Each API
route handler (`/api/runs` GET and POST, `/api/runs/[runId]` GET,
`/api/preview/[projectId]/[[...path]]` GET) additionally calls
`requireConsoleOperator` as its own first statement, before any `await`,
`getStore` or `launchRun`, so a mistake in the matcher cannot expose one.
Both paths call the same function — there is no second copy of the
comparison, the configuration rules or the refusal. **There are no public
exceptions**: this console has no health, readiness or liveness endpoint,
and Phase 5o did not invent one to have an exception. The allowlist
(`PUBLIC_API_ROUTES` in the suite) is empty and asserted empty.

**Refusals** are minimal and identical: no credential, unreadable
credential and wrong credential all produce the same `401` with
`{"error":"Authentication required."}` and `WWW-Authenticate: Basic
realm="STATXAI console", charset="UTF-8"`. No token, configured user id,
length, hash, or hint about which failure occurred. Misconfiguration is
`503` with no challenge; a cross-site mutation is `403`.

**CSRF.** Basic credentials are ambient browser authority in the same way a
cookie is — once cached for the origin the browser attaches them to a
cross-site form POST too, and a form can send `text/plain` that
`request.json()` parses happily. So state-changing methods additionally
require a same-origin signal (`Sec-Fetch-Site`, falling back to `Origin`
against the request's own host). Secondary, never authentication: a client
sending neither header is not a browser — an operator's `curl`, which no
attacker page can make anyone's browser become — and still faces the
credential check that actually decides. No CSRF framework, token store or
double-submit cookie was added, because there is no session to protect.

**Logging.** This repository has no logging infrastructure and no generic
request logging, so Phase 5o added none: no `Authorization` header, cookie,
credential or hash is written anywhere. Nothing to audit for newly-exposed
credentials, because nothing logs requests at all.

**Scope held exactly where the brief drew it:** no HTTP abandonment
endpoint — `scripts/abandon-build.ts` remains the operator surface,
unchanged apart from the docstring that claimed the console has no
authentication (`--actor` still absent, `userInfo()` still the actor
source); zero changes to `packages/job-engine`, `packages/contracts`,
`runProject`, or Phase 5h/5i/5k/5m/5n promotion, binding and abandonment
authority; `FRONTEND_BACKEND_EXECUTION_MODE` semantics untouched
(production still defaults `job_lifecycle`, `runProject` still defaults
`legacy_direct`), as are `WORKSPACES_ROOT`/`VALIDATION_WORKSPACES_ROOT` and
`assertDistinctWorkspaceRoots`; no Luna; no deployment-authorization or
release-policy change — an authenticated console operator is not a website
publication decision.

**Tests: +27 unit (980 → 1007), in one new file**
(`apps/console/test/console-auth.test.ts`, the first suite under `apps/`, so
all three Vitest configs gained an `apps/*/test/**` include and the `@/*`
alias the console's own imports use — the unit/integration complement is
preserved). Covered: unauthenticated run start rejected before `launchRun`
or `getStore` is reached, wrong credential indistinguishable from none,
malformed Basic rejected without throwing, authenticated start proceeding on
the unchanged `job_lifecycle` default, the `legacy_direct` rollback still
working when authenticated, body/header actor spoofing ignored, cross-site
mutation refused, both read routes and the preview route protected with
existing behaviour preserved once authenticated, the middleware challenge
and matcher, fail-closed configuration, principal shape, secret absent from
body and headers, structural coverage of every route file, no
`process.env.NEXT_PUBLIC` and no client component importing the primitive,
and no abandonment route. Ten security mutations attempted, ten killed —
guard removed from `POST /api/runs`, invalid credential accepted, missing
config treated as anonymous, principal id taken from a request header, read
route unguarded, preview route unguarded, execution mode changed by the auth
work, matcher no longer covering `/api`, cross-site guard removed, and
malformed base64 throwing instead of failing (this last one initially
survived and exposed a real test gap — no input reached `atob`'s throw — so
two payloads that genuinely throw were added).

**Explicitly:** Phase 5o establishes one authenticated operator boundary for
the existing production console. Unauthenticated callers cannot start
production website-generation runs, read run state, or reach preview/run
APIs. Operator identity comes from trusted authentication state, not request
content. Credentials remain server-side and are never returned or logged.
Production fails closed when the required configuration is absent or
invalid. No customer authentication, RBAC or user database; no HTTP
build-abandonment endpoint; no change to Phase 5l's `job_lifecycle`
production default or Phase 5n's promotion/abandonment authority; no Luna;
no deployment-authorization change.

## Phase 5p — operator-reconciled durable release publication authority — **DONE**

Phase 5p began as *durable post-promotion outer `runProject` resume* and
stopped twice, correctly, before writing code. The first inspection found
that resuming across `publishRelease` would replay `deploySite` →
`vercel.deployments.createDeployment`, which had no durable authority at
all: a crash after Vercel accepted a deployment but before the manifest was
written left a live production deployment recorded nowhere, and the next
invocation deployed again. The second inspection asked whether that could be
made automatically safe and found it cannot — so this phase is the
prerequisite, and outer resume is still not implemented.

**The provider limitation, verified not assumed.** `@vercel/sdk@1.28.17`
contains no occurrence of `idempoten`; `POST /v13/deployments` documents only
`forceNew`, `skipAutoDetectionConfirmation`, `teamId` and `slug` — no
idempotency key, and no client-supplied deployment identity (`name` is the
project, `uid` is server-assigned). Deployment `meta` exists and is readable
back from `GET /v13/deployments/{id}`, but `GET /v7/deployments` has **no
metadata filter**, so "find the deployment for this release" is a scan whose
empty result proves nothing — least of all after a crash mid-request. The
`forceNew` flag implies a "deployment deduplication" whose key, window and
concurrency behaviour are specified nowhere, so nothing here relies on it.

**So the guarantee is narrower than "exactly one deployment", and true:**
after an external attempt becomes ambiguous, STATXAI issues no further
automatic deployment for that release until a trusted operator resolves it.

**`release_publications`** (`ReleasePublicationDocument`) — `_id` is the
deterministic `releaseId`, so the collection is its own idempotency ledger,
the shape Phase 5h's `job_promotions` established. `releaseId =
contentHash(projectId + the exact release-authorization ArtifactRef)`. Two
things are deliberately *not* inputs: `baseCommit`, because it is HEAD
*before* this release's own publication commit and would make the identity
unstable exactly when a retry needs to find its own receipt; and the
deployment target, because hashing it in would make a changed
`VERCEL_TEAM_ID` mint a *different* release and silently publish elsewhere —
bound in the receipt instead, the same change is detected as drift and fails
closed. Statuses: `prepared` (authority exists, nothing sent),
`publishing` (**a request may have reached Vercel; automatic retry
forbidden**, and never expiring — no timeout, restart or provider error
returns it to `prepared`), `retry_authorized` (one further attempt,
authorised by a human), `committed` (one exact deployment durably known). `attempts[]` is
immutable history — an ambiguous attempt is never erased to make room for
the next one, because it may correspond to a real production deployment.
One unfinished publication per project, enforced by a partial unique index
on `{ projectId }` filtered on `active: true` (a separate field because
Mongo's `partialFilterExpression` has no `$in` and "unfinished" spans three
statuses). `prepared`, `publishing` and `retry_authorized` all hold the slot;
it is released by the same guarded write that records final authority —
`$unset: { active }` in the *same* update as `status: 'committed'`, on both
the ordinary-success and operator-adoption paths — so a later release for the
project can never be blocked by a stale flag, and never starts while an
earlier one is unresolved.

**The ordering that is the whole phase:** receipt `prepared` → release
Git commit established → `prepared|retry_authorized -> publishing` with the
attempt appended, guarded by CAS on the exact `(status, attempt)` pair →
**only then** `createDeployment`. A process that dies one instruction after
that CAS leaves `publishing` behind, and every later invocation throws
`ReleasePublicationReconciliationRequired` instead of deploying. The same
CAS makes two concurrent publishers produce exactly one attempt, and makes
an operator's retry authorisation single-use.

**Git.** The release-authorized commit now carries `Statx-Release-Id:
<releaseId>`, and a retry recovers it by marker rather than making a second
one — Phase 5h's pattern, unchanged. Zero markers means nothing was
published yet, and then HEAD must still equal `receipt.baseCommit` or
publication fails closed (`ReleasePublicationBaseConflict`): no reset, no
rebase, no adopting a newer lineage. A clean tree legitimately produces no
commit, and the release then publishes `baseCommit` itself.

**Operator surface:** `pnpm release:reconcile show|adopt|retry`
(`scripts/reconcile-release.ts`), CLI only — Phase 5o's authenticated
console boundary exists, but a reconciliation API is a separate capability
and was not added. Actor comes from `userInfo()`, never a flag, as in
`abandon-build.ts`. **adopt** takes one exact deployment id the operator
found in the dashboard; the harness re-reads that deployment and refuses it
unless its `statxReleaseId` marker, Vercel project and target all match —
an operator cannot assert a URL into the receipt. **retry** authorises
exactly one more attempt and records who and why. Both name the exact
attempt they resolve, so a stale command can never resolve a newer one. This
is trusted, destructive authority: nothing can prove the process that
started the ambiguous attempt is dead.

**Behaviour changes, stated plainly.** A failed deployment request no longer
retries under the `failedDeployments` budget and no longer falls through to
a "local preview" manifest — after an ambiguous attempt that manifest would
be a claim the harness cannot support. Publication with no `VERCEL_TOKEN`
configured is unchanged and takes no receipt: nothing leaves the machine, so
there is nothing to fence. A `committed` release replays with zero provider
calls and zero new release commits, reconstructing the manifest from the
receipt — which covers both the crash-before-manifest and
manifest-written-but-project-not-`released` windows. Legacy releases have no
receipt; that means "historical", never "stuck publishing", and a legacy
manifest is still read as the next release's rollback target.

**Tests: +22 integration (1007 → 1029), one new file.** Receipt-before-
provider ordering, the mandatory crash-after-external-success window, a
failed request stopping identically, adoption and its three refusals, the
one-shot retry and a second ambiguity stopping again, stale reconciliation,
both concurrency races against real Mongo, committed replay in three crash
shapes, HEAD and target drift, legacy non-adoption, and release policy
untouched. Thirteen focused mutations attempted, twelve killed. The thirteenth —
dropping `attempt` from the `prepared|retry_authorized -> publishing` CAS
filter — survived, and only there: every transition *into* `publishing`
also moves the status, so that one guard is already sufficient by itself.
`attempt` is load-bearing in the other direction, where the status does
*not* move: `publishing(N)` and `publishing(N+1)` share a status, so the
success and adoption updates both pin the exact attempt. That is what stops
a late result from a superseded attempt committing over a newer one, and it
is covered by its own tests rather than assumed.

**Scope held:** zero changes to `packages/job-engine`, Phase 5n's promotion
fence, Phase 5m abandonment, Phase 5o authentication, Luna, the hosting
provider, or release authorization policy — the receipt proves publication
identity, never permission to release. No outer `runProject` resume, no
repair/replan cursor, no provider scanning as authority, no deployment
deletion, no Git reset/rebase, no artifact deletion.

## Phase 5h prerequisite — promotion materialises the exact accepted site tree — **DONE**

Canonical promotion was an overlay: `scaffoldSite(ws.siteRoot)` then
`ws.writeSiteFiles(candidate.files)`, with nothing removing a predecessor
file the accepted candidate no longer contains. That is indistinguishable
from a replacement until a candidate *drops* something — a revised plan that
removes a route produces a candidate with no file for it, and the
predecessor's page stayed committed and deployable. No gate caught it:
`spec-coverage` asks only whether every planned route was exported, never
whether an exported route is still planned. Found while scoping Phase 5q0,
which cannot route a replan rebuild through the lifecycle until promoting a
candidate actually yields that candidate.

**The promoted tree is now a set, not a diff.** `desiredPaths` (unchanged in
formula, renamed from `expectedPaths`) is `scaffoldTemplatePaths() ∪
candidate.files`, each resolved through `ws.siteFileRepoPath`; `stalePaths`
is `trackedSiteFiles() − desiredPaths`. Every stale member is therefore
tracked by git, inside the managed namespace, and provably absent from what
was accepted — no other file is eligible for deletion.

**`app/**` is the managed namespace, proven rather than assumed.** Every
desired path resolves through `safeSitePath` against `siteRoot`, so all 23
scaffold paths land under `app/` (`package.json` → `app/package.json`,
`lib/utils.ts` → `app/lib/utils.ts`) and traversal is refused with
`PathEscapesWorkspace`. Verified against a real workspace: 29 tracked files
under `app/` = 23 scaffold-owned + 6 candidate-supplied, while everything
tracked outside `app/` is artifact materialisation (`client/`, `decisions/`,
`design/`, `specs/`) and is never eligible. `app/.gitignore` is scaffold-owned
and so always in `desiredPaths` — deleting it would make `.next/`, `out/` and
`node_modules/` trackable and poison every later dirty check.

**Two new workspace APIs.** `dirtyEntries()` keeps git's two-letter `XY`
status beside each path; `dirtyPaths()` is now its path-level view, so the
specification and promotion guards that only ever asked "is this path
unexpectedly dirty?" are unchanged. `trackedSiteFiles()` reads `git ls-files
-z -- app` — the index, never a directory walk, which would also sweep up
untracked scratch files and ignored build output. A tracked file deleted in
the worktree but unstaged is still listed, which is what lets an interrupted
attempt recompute an identical stale set on retry.

**The dirty authority admits exactly two mutation classes**, and the
distinction is the safety property: a path in `desiredPaths`, or a git `D`
status on a path in `stalePaths`. A stale path that is *modified* rather than
deleted is somebody's uncommitted work on a file this promotion wants gone —
erasing it because the destination matches would be silent data loss, so only
a deletion qualifies. An untracked path can never qualify, because
`stalePaths` is drawn from the index; it is refused, not tidied away. The
post-mutation allowlist is `desiredPaths ∪ stalePaths`, never "anything under
the site root".

**Order:** scaffold → candidate writes → delete exact stale paths → one
commit. Deletion is last because `scaffoldSite` copies with `force: false`
and `writeSiteFiles` writes candidate paths, so deleting first would let
either resurrect a path the attempt had already removed. Writes and deletions
reach the index through the existing `git add -A`, so both land in the single
commit carrying `Statx-Promotion-Id` — no cleanup commit, no second marker,
no replacement receipt. Exact `rm` per stale path; no `clearSite`, no
recursive sweep.

**Unchanged:** `promotionId`, the receipt and its lifecycle, the Phase 5n
fence, `baseCommit` authority (still checked before any mutation, still
fail-closed on drift), and the marker-replay branch — which returns before
materialisation, so a committed replay deletes nothing and produces no churn.

**Crash windows.** Because deletion runs last, "interrupted after deleting"
and "interrupted after all filesystem mutations" are the same seam, and the
exact retry converges: the deleted file is still in the index, so
`stalePaths` recomputes identically and `dirtyEntries` reports the deletion
as this promotion's own expected work. Commit-succeeded-before-receipt still
recovers through the marker with the stale paths staying deleted.

**Tests: +5 workspace (12 → 17) and +14 promotion (35 → 49).** The workspace
five pin `dirtyEntries`' modified/deleted/untracked distinction, `dirtyPaths`
compatibility, and `trackedSiteFiles` scope including the deleted-but-indexed
and untracked cases. The promotion fourteen prove initial-promotion
regression, same-path-set update, route removal, rename, nested stale files,
`.gitignore` survival, outside-`app/` preservation, modified-stale refusal,
untracked preservation, single-marker commit, exact final-tree set equality,
committed replay without churn, crash-before-commit convergence,
commit-before-receipt marker recovery, base drift, and a structural check that
no `clearSite` or recursive deletion exists.

**Phase 5q0 remains unimplemented**; this prerequisite only changes what a
promotion materialises. Phase 5p release publication, the replan path and
`legacy_direct` are untouched.

## Phase 5q0 — durable authority for post-replan frontend/backend rebuilds — **DONE**

The initial `job_lifecycle` build already had strong durable authority — exact
profile and site-plan refs, a deterministic `JobSpec`, a build binding, a
fenced job, isolated validation, guarded acceptance, canonical promotion. A
*replanned* rebuild had none of it: the replan branch called `clearSite()` then
`buildFromPlan()` regardless of execution mode, so the resulting canonical tree
carried no evidence tying it to the plan it implements. That was the last
blocker before safe post-promotion outer-run recovery, because a recovering
process could not tell which plan the tree was built from without resolving
"latest", which is wrong the moment two generations exist.

**Canonical build authority is now an explicit chain.** The binding gained two
fields, written together or not at all: `predecessorBindingId` and
`replanDecision`. An initial build has neither — absent means "initial or
legacy", never "successor whose lineage was lost". A replan successor names the
exact binding it replaces and the exact `replan-decision` ArtifactRef that
authorised it, so `B0 -> B1 -> B2` is readable from durable state without
timestamps, newest-binding selection, or current HEAD as semantic identity.

**Exact refs, threaded rather than re-resolved.** `revisePlan` now returns
`RevisedPlan` carrying the `replanDecisionRef` it previously persisted and
dropped on the floor; the revised `sitePlanRef` was already exact. The
successor inherits the predecessor's exact `businessProfile` ref — discovery
never reruns — and its `JobSpec` is built from those exact refs, so
`computeBindingId({projectId, runIntentHash, jobSpecHash})` yields a
deterministic successor identity with no new id scheme: same profile means the
same `runIntentHash`, and the revised plan changes `jobSpecHash`.

**One successor per predecessor, enforced by the database.** A partial unique
index on `{ projectId, predecessorBindingId }` filtered on the field's
existence. Deliberately *not* filtered on `status` like the active-slot index:
that one frees the project once a build promotes, which is right for "may
another generation start?" and wrong for lineage — a promoted successor still
means its predecessor was replaced, so a second successor must stay impossible
forever. Pre-5q0 bindings lack the field, sit outside the index, and need no
backfill; the index builds against existing documents unchanged. A losing
racer gets `FrontendBackendBuildLineageConflict`, distinct from the run-intent
conflict the older index raises, because the recovery now asks which
constraint actually holds rather than assuming the older one.

**Lineage is immutable.** Exact replay converges on the same successor;
presenting a different predecessor, decision, plan or spec for the same
deterministic identity fails closed rather than rewriting stored authority —
including presenting a successor as though it were an initial build.

**The rebuild uses the ordinary lifecycle.** In `job_lifecycle` mode the replan
branch prepares the successor, commits its specification, and runs the same
coordinator with `JobOrigin { kind: 'replan', reviewCycle }` — same role, Terra
handler, tools, candidate convention, isolated validation, guarded acceptance,
Phase 5n fence and Phase 5h promotion identity. No `clearSite()`: the canonical
tree keeps implementing the predecessor while the successor is built and
validated elsewhere, and the exact-replacement promotion then removes the
routes the revision dropped. The coordinator is constructed once per
invocation and reused across the initial build and every replan, so there is
never a second `JobRunner` claiming the same role for the same project.
`canonicalBuild` advances only after a successful promotion — never when a
successor is merely prepared, built, validated or accepted.

**One guard had to learn a new fact.** `ensureSpecificationCommitted` refuses
foreign dirt, and on a first build the only dirty paths are the profile and
plan. A successor is prepared mid-run, when adjudication and the revision have
already materialised their own `decisions/…` records; the caller now names
those explicitly as expected. They are harness-authored and swept into the
commit by `git add -A` either way — the initial build passes nothing and is
unchanged.

**Tests: +11 integration, one new file** driving the real orchestrator through
two successive replans: exact R1/P1 and R2/P2 refs, `B1.predecessor = B0` and
`B2.predecessor = B1`, replan origin, one job per generation each fenced and
promoted with ordinary Phase 5h identity, `/services` and `/about` actually
absent from the canonical tree, `app/.gitignore` untouched. Separate focused
tests cover the concurrency race, replay convergence, immutable-lineage
refusal, prepared-successor survival across reconstructed objects, an
unpromoted successor leaving the predecessor canonical, an initial build with
no lineage fields, `legacy_direct` still taking the direct path, index
migration against historical bindings, and unchanged replan budgeting.

**Unchanged:** `legacy_direct`, Phase 5n fencing, Phase 5p release
publication, Luna repair, the JobEngine state machine, and replan policy and
budgets. Outer `runProject` recovery is still not implemented — that is Phase
5q, and it should now read the explicit `B0 -> B1 -> B2` lineage rather than
adding a workflow cursor of its own.

## Phase 5q prerequisite — durable active frontend/backend lineage authority — **DONE**

**Phase 5q could not start, and this is why.** Outer `runProject` recovery has
to begin by asking which build a project is actually continuing. That question
had no durable answer. The one-active-binding slot is filtered on
`status: 'prepared'`, so it frees the project the moment a build promotes —
correct for "may another generation start?", and exactly wrong for "is an
unfinished lineage still running?". A probe against the real replica set
confirmed it rather than arguing it: promote `B0`, and a second, unrelated
no-lineage root can be founded for the same project immediately. Structural tip
selection then returns two roots and two tips, separable only by `createdAt`.
Phase 5q stopped with zero changes on that ambiguity; this removes it.

**The invariant is scoped to unfinished work, not to history.** At most one
unfinished lineage owns a project at a time. It is deliberately *not* one
lineage root per project forever: that would lock a durably finished project out
of legitimate later work, and would silently mis-handle historical documents,
which carry no marker and therefore sit outside a partial index anyway.

**Two fields carry it.** `lineageRootBindingId` names the exact root of the
lineage a binding belongs to — an initial build is its own root, and a successor
inherits its predecessor's exact recorded value, so `B0 -> B1 -> B2` all name
`B0` without anyone walking or sorting. A successor never derives a root; it
reads one, and a predecessor that records none fails closed
(`FrontendBackendBuildLineageRootUnproven`) rather than guessing. `activeLineage`
marks the one root that currently owns the project, enforced by a partial unique
index on `{ projectId }` filtered to `activeLineage: true` — the same shape
`release_publications.active` uses, and named explicitly because the Phase 5k
active-slot index already occupies the default name Mongo derives from that key
pattern.

**The slot is acquired at preparation, not at promotion,** so even a `prepared`
build owns its project and Phase 5k's restart resume stays coherent. Successors
join a lineage that is already active and take no second slot: exactly one
binding per project ever carries the marker, and it is always the root.

**Promotion does not release it.** That was the whole gap. The lineage stays
owned through promotion, evaluation, adjudication, repair, replan, a successor's
own promotion, approval and publication.

**Only durable semantic terminal completion releases it,** and the release is
written in the same transaction as the terminal state, so a crash cannot leave a
project released while an unfinished lineage still claims it. Three sites,
matching the real contract rather than state names that merely sound final:
`released` (`publish.ts`) and the two `blocked` exits (`orchestrator.ts`).
`awaiting_human_review` deliberately keeps ownership — it is a run parked for a
person, not a finished one — and a build that never reaches `promoted` writes no
project state at all, so a dead invocation never frees a project whose work is
still live. Abandonment (Phase 5m) also releases, inside the transaction it
already owns: an explicit, recorded operator decision is the one ending that is
terminal without the outer run concluding, and releasing there is what keeps
Phase 5m's own contract intact — once abandoned, a fresh generation or a
`legacy_direct` rollback may proceed. Release is a guarded `$unset`, so replay
converges from either side and order does not matter.

**Two narrow reads, both structural.** `findActiveLineageRoot` is one indexed
equality lookup, never a scan-and-sort. `deriveActiveLineageTip` walks
`predecessorBindingId` links forward — Phase 5q0's one-successor index is what
makes each step well defined — and fails closed on every way the chain could
stop being a single path: a root that records a predecessor or a foreign root, a
branch, a successor claiming another root, a cycle, or members that claim the
root without being reachable from it. No `createdAt` anywhere in either.

**Historical bindings are left exactly as they are.** No backfill, no invented
roots. A legacy project with two unmarked roots reports *no* owner rather than
adopting the newer one, which is the honest answer and the one Phase 5q needs in
order to fail closed instead of guessing.

**One existing guard widened by one read.** `legacy_direct` already refused to
start while a binding was `prepared`; it now also refuses while an unfinished
lineage owns the project. Same property, asked one question later.

**Tests: +22 integration, one new file** — root identity and slot acquisition,
an initial build with no lineage fields, `B0 -> B1 -> B2` inheritance, exact
replay convergence, a real race in which exactly one of two fresh roots wins,
promotion (of root and of successor) not releasing, a real run whose build never
promotes keeping the project owned, real released and blocked runs releasing it,
idempotent replay across the crash window, a later generation acquiring the slot
afterwards, structural tip derivation, five distinct corrupt-chain refusals, a
source-level check that neither lookup mentions time, and legacy behaviour
including index migration with no backfill.

**Unchanged:** Phase 5h canonical promotion and exact replacement, Phase 5n
fencing, the Phase 5p release-publication state machine, the JobEngine state
machine, Phase 5k prepared-binding resume, and Phase 5q0's
one-successor-per-predecessor rule. `runs`/`run_events` remain telemetry and are
never consulted for authority. No workflow cursor was added: the only new
control-plane fact is which lineage currently owns unfinished continuation.

**This does not implement Phase 5q recovery.** No lookup happens before
`discoverProject`, nothing is rehydrated, and no recovery run is created. Phase
5q can now resolve `projectId -> exact active lineage root -> exact structurally
derived tip` with no newest/latest inference, and its mandatory gate should be
repeated against that.

## Phase 5q prerequisite — release publication bound to build lineage — **DONE**

**Why Phase 5q stopped a second time.** The active lineage names the current
build, but a release receipt named only a project and an authorisation version.
Once a receipt commits it leaves the project's active slot, so a historical
committed release and the current lineage's committed release were
indistinguishable without ordering by time.

**The receipt now carries exact build authority** — an optional, all-or-nothing
`buildAuthority { lineageRootBindingId, canonicalBindingId, promotionId }`.
Mandatory for every `job_lifecycle` release; absent on historical receipts and
on `legacy_direct` releases, which have no lineage and are never given a fake
one. Absent means "no proven association", never "probably current".

**Threaded from the run's own build, by exact id.** `runProject` passes the
canonical binding's `_id`; `publishRelease` re-reads that exact binding (the
in-memory copy is the pre-promotion snapshot) and refuses unless it is this
project's, `promoted`, and carries a promotion id and lineage root. Resolved
only when a receipt is actually needed, so local-preview releases are untouched.

**`releaseId` is unchanged,** pinned byte-for-byte in a test against values
captured from the unmodified code. This is an association, not a new identity.

**Immutable, both directions.** Replay must present the same root, binding and
promotion; a linked receipt replayed without authority, or an unlinked one
presented with authority, fails closed and is never rewritten. The
committed-replay short-circuit checks it too.

**One release per build lineage, ever.** A unique partial index on
`{ projectId, buildAuthority.lineageRootBindingId }`, deliberately not filtered
on `active` or status: a committed receipt still means that lineage has
published. A duplicate reports the permanent `ReleasePublicationLineageConflict`
before the temporary `ReleasePublicationConflict`; the project's active slot is
unchanged and orthogonal. A later lineage has its own receipt.

**Exact lookup.** `findReleasePublicationForLineage` is one indexed read by
lineage identity, in every status including `committed`, never sorted.
`assertReceiptMatchesCanonicalBuild` refuses a receipt whose root matches but
whose binding or promotion does not — a receipt for `B1` is not authority for
`B2`.

**Operators unaffected.** Adoption and retry update fields in place, so the
linkage survives both without anyone retyping ids.

**Tests: +24 integration, one new file** — two real `runProject` runs (linked
`job_lifecycle`, unlinked `legacy_direct`), refusal of unpublishable builds,
pinned `releaseId`, replay and every mismatch direction (including the
committed-replay path through `publishRelease`), lineage uniqueness
under a race and after commit, a later lineage, the unchanged active slot,
lookup across prepared/publishing/retry_authorized/committed/adopted,
historical receipts ignored and indexed with no backfill, and the moved-tip
refusal.

**Unchanged:** the Phase 5p state machine and provider metadata, the
`release-authorization` artifact, Phases 5h/5n, and active-lineage semantics.
Runs and run events remain telemetry. **Phase 5q is still not implemented**;
its gate should be re-run, including the window where an authorisation exists
but its receipt was never prepared.

## Phase 5q — durable post-promotion outer runProject recovery — **DONE**

**The gap.** A `job_lifecycle` run whose build had already promoted could die
during evaluation, repair, approval or publication. The next invocation reached
`discoverProject`, which deletes the project document and its budgets — or, since
the active-lineage prerequisite, was refused outright. Unfinished work could be
neither lost nor continued.

**Checked before any destructive step.** Intake validation stays first, so
malformed intake still has no side effects. Phase 5k keeps precedence: a
`prepared` binding resumes exactly as before. Only when nothing is mid-build does
`resolvePostPromotionRecovery` run, and only when it returns nothing does
discovery run.

**Derived, not remembered — no cursor and no recovery document.** The project's
active lineage root (one indexed read) leads to the structural tip, and the tip
must be `promoted`. Its promotion is re-proven from its own evidence: the
accepted job, its promotion fence, the committed promotion receipt, the matching
commit SHA, and exactly one commit carrying that promotion's known marker. The
tip's exact bound profile and plan refs are reused — `B2`'s plan after two
replans, never a newer artifact. The incoming run intent must equal the lineage's
own, otherwise `ActiveContinuationIntentConflict` is raised with nothing reset,
rebound or committed. Runs and run events are never consulted; a recovery under
`launchRun` simply gets a new run id.

**Budgets are kept.** The project and budget documents are reused as they are.
`reviewCycle` is not reset to zero: it is exactly `used.reviewRejections`, because
that spend is the counter's only writer. Every limit remains the existing durable
database guard.

**Workspace safety.** A clean tree is evaluated as it is, including a committed
repair after the promotion, with no requirement that HEAD equal the promotion
SHA. Uncommitted harness decision records (`decisions/**`, the deployment
manifest) are tolerated. Anything else — typically an interrupted Luna repair
under `app/**` — fails closed with `ActiveContinuationWorkspaceDirty` and is left
untouched.

**Normal continuation re-enters `evaluateSite`,** skipping discovery, planning,
routing, build, validation, acceptance and promotion. A run parked in
`awaiting_human_review` is refused rather than re-evaluated, so a pending human
decision can never be overtaken by a fresh approval.

**An existing release wins.** `findReleasePublicationForLineage` plus the exact
canonical-build match picks the lineage's receipt; historical receipts are
unreachable. With a receipt, recovery never evaluates, approves or authorises
again. It rebuilds the manifest inputs from the receipt's own authorisation and
the exact approval, test-report and review versions it recorded, then hands off
to Phase 5p unchanged:

- `prepared` publishes;
- `publishing` stops with reconciliation required and no provider call;
- `retry_authorized` spends its one attempt;
- `committed` finishes the manifest and the atomic terminal release with no
  deployment.

**Authorisation stored, receipt not yet prepared.** Nothing external or canonical
has happened in that window — the receipt precedes the release commit and the
provider call — so recovery re-evaluates. That mints a new, unused-safe
authorisation version, and lineage uniqueness still admits exactly one receipt.
No link from the authorisation to the build was needed.

**`legacy_direct` cannot bypass it.** `runProject` itself now refuses a
`legacy_direct` run while a `job_lifecycle` lineage owns the project, in addition
to the `launchRun` guard. Terminal history holds no active lineage, so later
legitimate work proceeds normally.

**Tests: +26 integration, one new file,** each crashing a real run at an exact
point:

- the first evaluation compile;
- the publish phase before any receipt exists;
- the release commit;
- the provider call;
- plus the atomic committed-receipt window, reproduced exactly.

They cover matching recovery, exact refs, two replans, budgets, repaired and
dirty trees, harness dirt, malformed intake, conflicting intent, human review,
four corruption variants (binding, receipt, fence, marker), a non-promoted tip,
Phase 5k precedence, `legacy_direct`, every receipt status, a historical
receipt, missing run history with a new run id, and terminal-then-fresh.

**Unchanged:** Phases 5h, 5n and 5p semantics, the JobEngine, release
authorisation, and the Phase 5k resume.

## Central model invocation / model runtime authority — **DONE**

**Every production model invocation now crosses one harness-owned boundary.**
`ModelRuntime` (`packages/agents/src/runtime.ts`) sits above the existing
`ModelClient`, which remains the provider adapter, and the one `OpenAiProvider`.
All ten production call sites across the eight skills — Sol plan, route,
adjudicate, replan and approve; Terra build (whole site, anchor, page) and
review; Luna repair — call `runtime.invoke`. None of them holds a client.

**Skill and tier identity are explicit.** Each invocation names its skill by the
skill's existing name and its tier. `MODEL_SKILL_TIERS` is the one authority for
which tier a skill runs at, and a mismatch or an unknown skill is refused before
any provider call. Each invocation also gets a unique id, used for evidence and
tracing only.

**Model selection is unchanged.** Tier-to-model resolution (`modelFor`, the
`MODEL_*` overrides), schema projection, strict Zod parsing, the
`ModelRefusal` / `MalformedModelOutput` distinction and the single truncation
retry all stay exactly where they were. The provider keeps its 20-minute timeout
and transport retries. Prompts are byte-identical, and there is no new retry
policy and no provider fallback.

**Usage is reported by the runtime, not the caller.** The run constructs one
runtime with its usage sink. The runtime reports each successful invocation
exactly once, with the final attempt's usage — the same accounting as before.
The ten caller-side `track` calls are gone, so a skill cannot skip reporting and
a fabricated result cannot add to it. Failed invocations still report nothing.
Durable budgets are untouched: they never counted tokens.

**Cancellation now reaches the provider.** The Terra job handler's lease signal
is forwarded through the build phase and the runtime to the provider request. An
aborted call rejects with the caller's own abort reason — what its existing
`throwIfAborted()` checks already raise — and is never retried or reported as
usage.

**Structurally enforced.** A test scans `packages`, `apps` and `scripts`, and
nothing outside a named allowlist may reference `ModelClient`, a provider or the
vendor SDK. The allowlist is the runtime, the adapter, the provider files, the
re-export index, and the `model-check` operator diagnostic. The same test proves:

- every skill invokes under its own name and tier;
- no orchestrator module reports usage itself;
- only `runProject` constructs the runtime;
- the runtime imports no state, workspace, job-engine or filesystem authority.

The acceptance, promotion, validation and policy boundary tests now forbid
`ModelRuntime` as well as `ModelClient`.

**Tests:**

- **+31 unit tests:** runtime authority, mapping, usage, retry, refusal, malformed
  output, provider failure, cancellation and the provider's timeout; every skill
  call site; the structural boundary; phase-level signal forwarding.
- **Two existing end-to-end suites** had asserted usage invented by faked skills.
  Their review and approval fakes now go through the real runtime via a scripted
  provider, and the parity suite asserts exactly two usage events for its one
  review and one approval.

**Not in this slice:** no tool gateway, no tool permissions, no model↔tool loop,
and no new authority for models. The runtime returns typed results and never
touches project state, artifacts, jobs, Git, promotion, release or recovery.
Phase 5q is unchanged.

## Explicit Luna repair write scope — **DONE**

**Why this and not a tool gateway.** A tool-gateway pass stopped with no changes:
`ToolId` is declarative only, `JobSpec.allowedTools` is never read, and nothing
executes a tool. The real authority debt it surfaced was `REPAIR_COMPANIONS` —
not a tool permission, but a hidden widening of Luna's write set. Every repair
invocation built its allowed output set from the files it had been shown, which
always included `app/layout.tsx` and `app/globals.css`.

**The write set is now one explicit value, decided before Luna is asked.**
`repairWriteScopeFor(primaryPath, availablePaths)` in `defects.ts` returns a
frozen `RepairWriteScope`: the primary path, the companion paths, what Luna is
shown (`contextPaths`) and what it may rewrite (`writablePaths`). The policy
behind it, `REPAIR_SCOPE_POLICY`, names each shell file with a `read` or `write`
access, so being shown a file and being allowed to rewrite it are separate
facts. Both shell files stay writable, because the defect contract cannot yet
tell which defects need them, so behaviour is unchanged. What Luna is shown is
byte-for-byte the same.

**Luna cannot widen it.** Output is split by `partitionRepairOutput` against
`writablePaths` alone, by exact path — never against context, and never
normalised, so traversal, absolute and alternate spellings are refused.
Paths come only from the project's own source list, a target outside it is
refused, and every write still goes through `safeSitePath`. The repair phase no
longer names any file path itself.

**Unchanged:** prompts and `BuildOutput`, per-file repair calls, refusal counting,
repair budgets, harness-owned writes and the one per-cycle commit. `ToolId`,
`JobSpec.allowedTools`, `ModelRuntime` and Phase 5q are untouched.

**Tests: +16 unit.** They cover the scope policy (primary, layout-only,
globals-only, context-only, primary-only, invalid target, source ordering,
freezing, unsafe spellings), phase-level escalation and refused output never
reaching a real commit, and a structural guard against hidden grants.

## Bounded Terra scaffold inspection — the first real tool — **DONE**

**Why this tool.** Terra builds into a platform scaffold it had never been shown:
the shadcn `components/ui` sources whose props it must use, the `globals.css`
theme it is told to extend, the template layout, `lib/utils`. Before a Terra
call no project workspace exists. The pre-candidate is exactly `templates/site`,
which `scaffoldSite` copies into every candidate. Reading it on demand gives Terra
information it genuinely lacked.

**One tool, one operation.** `ToolId` `filesystem` now has a real contract
(`contracts/tools.ts`): read one file by site-relative path. The result is the
content, the full byte count and a `truncated` flag, or a typed `not_found`,
`not_a_file` or `not_text`. There is no write, list, glob or exec operation.
The adapter:

- validates paths strictly instead of normalising them — absolute paths, drive
  letters, empty/`.`/`..` segments, backslashes, hidden files (so any `.env`)
  and the scaffold's excluded trees are all refused;
- refuses any path whose resolved location, symlinks followed, is outside the
  scaffold root;
- opens files read-only and caps each read at 12 KB.

**A minimal gateway.** `ToolGateway` (`orchestrator/tool-gateway`) is the only
path to an adapter:

- the effective grant is the claimed job's `JobSpec.allowedTools` intersected
  with the handler's supported tools, and the handler supports only
  `filesystem`;
- a refusal happens before any adapter runs — permission denied, a permitted
  tool with no adapter (unavailable), or invalid input — and execution failure
  and cancellation stay distinct errors;
- evidence records ids, tool, outcome, duration and the path — never content or
  credentials;
- it registers exactly one adapter. Control-plane operations are not tools.

**Durable authority.** The production `frontend_backend` spec now declares
`allowedTools: ['filesystem']`. Its deterministic `jobId` changes accordingly;
in-flight bindings still resume from their own stored spec. A job with `[]`
is offered no tools and builds exactly as before.

**A bounded loop, inside Terra's build skill.** All three Terra build call shapes
(whole site, anchor, page) share one loop with one `ModelRuntime.invoke` site.

- *Without tools* the request is byte-identical to before.
- *With tools* each turn is an ordinary invocation — same skill and tier, its own
  usage event — returning one strict action: a tool request, or the final
  `BuildOutput`. The prompt gains one appended section describing reads; the
  system prompt and base prompt are unchanged.
- *Bounds:* 4 model turns, 3 distinct reads, 24 KB returned in total. A repeated
  identical read is served from the build's own record without re-executing,
  and still spends a turn.
- *Cancellation:* the lease signal is checked before and after every step, and
  also reaches the provider and the read.
- *Callers* only ever receive `BuildOutput`.

**Separation.** `ModelRuntime` executes no tools, and the gateway invokes no
model. Sol and Luna get no tool access. The agents package touches no file
system. Validation, acceptance, promotion and release are unchanged.

**Tests: +60 unit.** They cover the loop, the gateway and the adapter against the
real scaffold, the real handler end to end (grant, narrowing, denial, evidence,
isolation, cancellation), and structural boundaries. Focused mutations: 24/24
killed. Two survived at first because overlapping path rules masked them; tests
for empty-segment and drive-letter paths now kill them.

**Not implemented:** `test_runner`, browser, Git, shell and filesystem writes.

## Model candidate write boundary — **DONE**

**Why.** A `test_runner` gate stopped on a live hole. `GeneratedFile.path` accepts
any string, and `isModelWritable` — meant to confine model output to `app/**`
and `components/site/**` — was called by no production code. A candidate could
replace `package.json`, the lockfile or a config file before `pnpm install` and
`pnpm build` ran it in official validation, the direct build or canonical
evaluation.

**One shared boundary.** Every production path that lands model output reaches
the file system only through `ProjectWorkspace.writeSiteFiles`: 5g-1 validation,
the direct build (including a legacy replan rebuild), Luna repair and 5h
promotion. That method now runs `assertModelWritableFiles` over the whole
candidate before writing a single file. A job-lifecycle replan goes through the
same validator and promotion. Trusted harness content is unaffected: the
scaffold is copied by `scaffoldSite`, and harness records use
`materialiseArtifact`.

**Stricter ownership, no normalisation.** `isModelWritable` now decides on the
path exactly as spelled:

- **Refused:** a leading `/`, backslashes, NUL, drive letters, empty, `.` or `..`
  segments, and hidden segments (`.env`, `.git`); also `components/ui/**`
  (scaffold-owned) and anything outside `app/` and `components/site/`.
- **All or nothing:** a mixed candidate is rejected whole, naming every refused
  path.
- **Reads unchanged:** `safeSitePath` still guards reads by containment.
- **Changed on purpose:** a leading-slash path used to be rewritten to
  site-relative. It is now refused, so a model emitting `/app/page.tsx` fails
  closed. Current Terra and Luna prompts name bare `app/...` paths.

**Refused before any side effect.** The 5g-1 validator checks immediately after
parsing the candidate, before creating its temp workspace, scaffolding or
compiling. 5h promotion checks before the fence, the receipt or any canonical
write. A refused validation leaves the job `validating`, as a malformed
candidate already did.

**Tests.** The ownership rules cover every forbidden form, and mixed candidates
write nothing. The validator refuses `package.json`, the lockfile, `next.config`,
`tsconfig`, `components/ui` and mixed candidates with zero compiles and zero temp
workspaces. Promotion leaves no receipt, no fence and no canonical change. The
direct build commits nothing. A structural test pins the four materialisers, the
check-before-write order, the single ownership rule and both replan paths.
Fixtures that faked foreign canonical edits through `writeSiteFiles` now write
to disk directly, and old normalisation expectations were updated.
Focused mutations: 11 of 13 killed. The two survivors — removing the explicit
`components/ui` exclusion and removing the drive-letter check — are equivalent
under the allowlist, since neither path can start with `app/` or
`components/site/`; both stay as defence in depth.

**Not in this slice:** sandboxing. Page code still executes during `next build`
with harness privileges; that isolation is the next prerequisite before a
`test_runner`.

## Sandboxed candidate builds — **DONE**

**Why.** `next build` executes the model's code: server components run during
prerender, and config and PostCSS modules run at load. `buildSite` ran
`pnpm install` and `pnpm build` on the host with a copy of `process.env`, the
whole host filesystem and an open network. A timeout killed only `pnpm`, and its
descendants kept running. Both the 5g-1 validator and canonical evaluation reach
that build through `runDeterministicGates`.

**Platform.** Production runs on a Linux host/VM with Docker, so the sandbox is a
container. The image is pinned by digest (`node:20.18.0-bookworm-slim`) and
pulled as a trusted step; a run never pulls.

**One executor.** `buildSite(siteRoot, { signal?, limits?, sandboxRoot? })` keeps
its result shape and delegates to `executeCandidateBuild`, which:

1. materialises a fresh workspace from the platform template, then copies in only
   the regular, model-writable files of `siteRoot` (no symlinks);
2. runs `node node_modules/next/dist/bin/next build` via `runSandboxed` — a
   harness-chosen argv, so no manifest script is ever consulted;
3. after the container is gone, copies back only regular files of `out/`, within
   a 512 MB budget;
4. removes the workspace however the run ended.

`siteRoot` gains `out/` and nothing else — no `.next`, `node_modules` or
`next-env.d.ts`.

**Isolation** (`packages/workspace/src/sandbox.ts`, arguments built in one pure
`sandboxCreateArgs`):

- **Environment:** built, not filtered — `HOME=/tmp`, `CI`,
  `NEXT_TELEMETRY_DISABLED`, `NODE_ENV=production`, `HTTPS_PROXY`. The `docker`
  client itself gets only `PATH`, `HOME` and `DOCKER_*`.
- **Filesystem:** read-only root; a `noexec` tmpfs `/tmp`; the disposable
  workspace read-write at `/site`; trusted `node_modules` read-only over it.
  Nothing else is mounted — no repository, home or socket.
- **Network:** a per-run `--internal` Docker network with no route out. Its only
  peer is `statxai-sandbox-egress`, a harness-owned CONNECT proxy that forwards
  only to `fonts.googleapis.com:443` and `fonts.gstatic.com:443`. `next/font/google`
  self-hosts brand faces at build time through it; every other host, port, IP
  literal, plain HTTP and the metadata endpoint get `403`. The proxy container is
  long-lived, unprivileged, read-only and capped at 128 MB and 64 PIDs.
- **Privileges:** harness uid/gid, or `nobody` if the harness is root — never
  root. `--cap-drop ALL`, `no-new-privileges`.
- **Limits:** memory 4 GiB with no swap, 2 CPUs, 1024 PIDs, 10 min wall clock,
  1 GiB tmpfs, 256 KiB captured output.

**Dependencies.** `prepareTrustedDependencies` installs from the template's
`package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` only, with
`--frozen-lockfile`, an explicit environment and no candidate present. Entries are
cached by content hash and published by atomic rename. A candidate manifest is
never read, let alone installed from.

**Cancellation.** The container is created, then started, so there is always one
to kill. Timeout and abort send SIGKILL to the container, which ends its whole
PID namespace, then force-remove it and verify it is gone; a survivor raises
`SandboxCleanupFailed`. Abort rejects with the signal's reason, and
`runDeterministicGates(…, signal)` runs no gates after a cancelled build.

**Outcomes.**

- **Build verdicts (resolve `ok: false`, reported as `BUILD-001` as before):** a
  compile failure, a timeout (`Build terminated: it exceeded the Ns time limit.`)
  and an OOM kill.
- **Rejections (never a verdict):** an abort, and `SandboxUnavailable` — Docker,
  the image or the trusted install missing. Neither is repairable by editing the
  site.

**Diagnostics.**

- **Bounds:** captured through a tail buffer, then cut to the existing 4,000
  characters.
- **Sanitisation:** workspace paths become `/site`, and other home, repository
  and temp paths become `<host-path>`. Secret-shaped harness values,
  `SECRET_NAME=value` lines and credentialed URL userinfo are redacted.

**Authority unchanged.** The sandbox modules import only Node built-ins and each
other, and know nothing of jobs, acceptance, promotion, release or project state.
5g-1 still verifies identity, writes through the write boundary, builds via
`runDeterministicGates` and registers authentic success only on a pass. Sandbox
execution is not exposed through ToolGateway.

**Tests.**

- **`sandbox.test.ts`:** exact env, mounts, network, user, capabilities, limits,
  image and sanitizer rules.
- **`sandbox-boundary.test.ts` (structural):**
  - only `sandbox.ts` and the git-only `ProjectWorkspace` spawn processes;
  - no other production file names a package-manager or Next argv;
  - `buildSite` → `executeCandidateBuild` → `runSandboxed`, and the materialiser
    filters through `isModelWritable`;
  - both `runDeterministicGates` callers stay sandboxed, and the validator order
    is boundary → workspace → build → authentic success;
  - no authority imports and no wholesale `process.env`.
- **`sandbox.integration.test.ts` (Docker):** probes from inside real containers:
  - fake OpenAI, Vercel and Mongo secrets are absent in the process and its
    children;
  - host sentinel reads fail and outside writes land nowhere;
  - the dependency mount is read-only, with no sockets and zero capabilities;
  - direct egress, DNS and the metadata endpoint are blocked, and the proxy
    allowlist holds;
  - non-root uid; OOM kill at the memory limit; fork refusal at the PID limit;
  - timeout, and abort with no surviving `sleep` descendants on the host;
  - bounded output, and no leftover containers or networks.
- **`candidate-build.integration.test.ts` (real `next build`):**
  - a hostile page probes the sandbox during prerender;
  - it builds from a canonical workspace tampered on disk (malicious
    `package.json`, `next.config.ts` and fake `next` binary);
  - it builds with fonts, sees no secrets, sentinel, network or socket, and runs
    non-root;
  - it uses the template manifest and config hashes; the tampered ones never run;
  - canonical files, Git HEAD and status are unchanged;
  - compile failure, timeout and abort all clean up.
- **`sandboxed-validation.integration.test.ts`:**
  - the real 5g-1 validator with a real sandboxed build: authentic success with
    job, project and artifacts unchanged, then normal acceptance;
  - a type error stays a failure, with a sanitized, bounded `BUILD-001` that
    acceptance refuses;
  - a fabricated passing result is refused;
  - a `package.json` candidate is refused before any run exists.

**Mutations: 19 of 20 killed, plus one extra variant (13b), also killed.** Each
ran against the sandbox unit and structural suites and the matching Docker suite,
on a daemon cleared of sandbox containers and networks after every mutation.

- **Container environment:** inheriting `process.env`, or exposing the OpenAI,
  Mongo or Vercel secret — unit and in-container probes.
- **Network and host exposure:**
  - enabling the bridge network — in-container probes;
  - mounting the repository root or home — unit arguments only (the probe reads
    host paths, not the new mount targets);
  - mounting the Docker socket — unit and probe.
- **Privileges and limits:** running as root, and removing the memory or PID
  limit — unit and enforcement.
- **Cancellation:** removing the wall timeout — enforcement.
- **Build path:**
  - skipping workspace cleanup — structural and real build;
  - overlaying the candidate `package.json` — the real build's manifest-hash
    probe;
  - calling a privileged legacy build, or bypassing the sandbox from the validator
    or canonical evaluation — structural.
- **Diagnostics:** unbounded output — enforcement; leaking host paths — unit
  sanitizer.

**The survivor, mutation 13**, is equivalent in outcome. Abort kills only the
`docker` client instead of the container, but `runSandboxed`'s `finally` still
force-removes the container, ending its whole PID namespace, before the call
rejects. The descendant check therefore holds.

**Variant 13b** removes that second layer too: client-only kill plus a non-forced
cleanup. It is killed. That variant also exposed a leak, now fixed: when
container removal throws, the per-run network is still closed.

Sources were restored byte-identical after each mutation.

**Not in this slice:** `test_runner` and browser rendering. The future
`test_runner` should be a thin adapter over `runSandboxed`.

## Bounded Terra test feedback — the second real tool — **DONE**

**Why.** Terra could read the scaffold but not check a build before answering, so
a type error or blocking gate finding surfaced only at official validation. With
the sandbox in place (`b69e841`), Terra can ask the platform to measure a
proposed build first.

**One execution core, advisory only.** `test_runner` (`tool-gateway/test-runner.ts`)
takes a proposed `BuildOutput` and measures it exactly as 5g-1 validation does:

1. **Refuse** unless every file is model-writable (`assertModelWritableFiles`).
2. **Materialise** a fresh disposable workspace from the platform scaffold via
   `writeSiteFiles`.
3. **Measure** with `runDeterministicGates` — the same sandboxed build and the
   same gates that official validation and canonical evaluation run.
4. **Clean up**: the workspace is removed however the run ends.

The adapter starts no process, and holds no store, registry, job engine or
project workspace. It cannot record authentic validation, accept, promote,
release or change project state. The official validator still validates Terra's
final `BuildOutput` from scratch, even when it is byte-identical to a candidate
that already passed. Advisory builds run one at a time per job.

**Contract** (`contracts/tools.ts`).

- **Input:** `TestRunnerInput` is a strict `{ candidate: BuildOutput }`. A
  command, working directory, environment, Docker option or limit is refused,
  not ignored.
- **Result (`TestRunnerResult`):**
  - `status`: `passed`, `failed`, `timed_out`, `refused` or `unavailable`;
  - `passed`, `candidateHash`, and `compile` (`{ ok, diagnostics }`);
  - `findings` (`{ gate, severity, location, message }`, most severe first),
    `findingCount`, `refusedPaths` and `truncated`.
- **Outcomes:**
  - a compile failure or blocking gate finding is a successful tool call with
    `passed: false`;
  - a sandbox time-limit hit is `timed_out` (`BuildResult` gained an optional
    `limit` field);
  - `SandboxUnavailable` is `unavailable`;
  - any other infrastructure error, or cancellation, fails the tool call.
- **Bounds:**
  - at most 20 findings, 400 characters per message and 160 per location;
  - 3,000 characters of compiler-diagnostic tail, and 12 KB for the whole result;
  - text passes through the sandbox sanitizer again.
  - For scale: gate message templates run 60–111 characters, and a real measured
    scaffold page returned 2 findings in 550 bytes.

**Authority.**

- **Grant:** `frontend_backend` `JobSpec.allowedTools` is now exactly
  `['filesystem', 'test_runner']`. That changes the deterministic `jobId` of new
  frontend_backend specs.
- **Handler:** `FRONTEND_BACKEND_SUPPORTED_TOOLS` matches. Permission is still
  the intersection of the two.
- **Gateway:** the handler builds one per claimed job, registering exactly the
  scaffold filesystem and a test runner bound to that job's pinned profile and
  plan. The model never supplies them.
- **Replan:** a job-lifecycle replan uses the same factory and handler, so it gets
  the same grant. The legacy direct build still receives no tool access.
- **Other skills:** Sol and Luna receive no tools.
- **Evidence:** records `candidateHash`, `files`, `status`, `passed` and
  `findings`, never candidate source (new adapter `summarize` hook).

**Loop** (`terra-build.ts`, still one `runtime.invoke` site serving whole-site,
anchor and page builds).

- **Protocol:** each turn is exactly one strict action — a `filesystem` read, a
  `test_runner` request whose input must be `{ candidate }`, or a final
  `BuildOutput`.
- **Bounds:**
  - model turns stay at 4 (read → test → retest → final fits);
  - reads stay at 3, and file feedback at 24 KB;
  - tests are capped at 2, independently of reads.
- **Duplicates:** an exact duplicate request is served from the build's own
  record. It spends a turn but not a run.
- **Cancellation:** stops the loop between every step. Tools create no model
  usage; only turns do.

**Tests.**

- **`terra-tool-loop.test.ts`:**
  - flows: test-only; read → test → final; failed test → corrected final;
    test → test → final (3 usage events, 2 runs);
  - limits: a third test refused; duplicate caching; budget independence;
    last-turn refusal;
  - scope: all three call shapes, and cancellation with no further turn;
  - strictness: command, cwd, env, malformed-candidate and crossed inputs are
    refused.
- **`test-runner.test.ts`:**
  - permission denied by the JobSpec and by the handler;
  - strict input;
  - outcomes: passed; compile failure (sanitized, bounded, still `succeeded`
    evidence); gate findings (sorted and bounded); `timed_out`; `unavailable`;
    infrastructure failure; `refused` manifest;
  - cancellation reaching the build with no gates after;
  - independent serialised workspaces, and safe evidence.
- **`terra-test-feedback.test.ts`:** the real handler and gateway, from a read
  through a failed test and a corrected test to the staged final. Also zero-tool
  answers, the default gateway, Sol, a filesystem-only grant being denied, and a
  lease lost mid-test.
- **`terra-test-feedback.integration.test.ts` (Mongo):**
  - a byte-identical candidate that passed `test_runner` is still validated
    officially, then accepted and promoted;
  - when official validation fails, the advisory pass accepts, promotes and
    changes nothing;
  - an advisory result is not authentic, and a forged validation built from it is
    refused, as is promotion.
- **`test-runner.integration.test.ts` (Docker):** a real TS2322 failure; a
  hostile candidate that reports no secrets, no sentinel, no network and the
  trusted manifest; real gate findings; unchanged canonical workspace and HEAD;
  real cancellation leaving no containers.
- **Structural:**
  - exactly two adapters, both constructed only by the handler;
  - the adapter path is write boundary → workspace → `runDeterministicGates` with
    cleanup, and nothing else;
  - no validation, acceptance, promotion, release, job or project authority;
  - one loop with independent budgets;
  - the replan grant is untouched, and only the handler supplies tool access.

**Mutations: 24 of 24 killed.** Each ran against the tool, loop, runtime and
sandbox unit and structural suites, plus the matching integration test where one
applies; sources were restored byte-identical after each.

- **Behavioural suites:**
  - permission removed, union instead of intersection, and forced grant;
  - bypassing `BuildOutput` validation, or accepting a command, cwd or
    environment;
  - bypassing the sandbox — structural, unit and real sandbox;
  - `process.env` back in the build — sandbox unit and the real hostile probe;
  - recording authentic validation — structural and the Mongo acceptance test;
  - compile failure thrown as an infrastructure failure;
  - removing the diagnostic bounds or sanitisation;
  - removing the test or turn limit;
  - cancellation not stopping the next turn;
  - a duplicate rerunning the sandbox;
  - a test creating model usage;
  - a Terra call shape bypassing the loop.
- **Structural suite only**, because these are code-shape properties with no
  runtime entry point: Sol or Luna gaining `ToolAccess`, advisory code importing
  acceptance or promotion, and the replan grant being edited.
- **Mongo lifecycle test only:** skipping official validation after an advisory
  pass.

**Not in this slice:** browser rendering, screenshots and visual review.

## Isolated browser rendering — **DONE**

**Why.** Gates read the exported HTML, and the reviewer reads text. Nothing ever
ran the site in a browser, so a page that throws while hydrating, loses a local
asset or redirects away looked fine. Screenshots and visual review need a real,
isolated, deterministic render of the exact build first.

**Gate findings.**

- **Export:** the exact export is `siteRoot/out`, rewritten by the sandboxed
  `buildSite` on every evaluation. Only gates, deployment and the preview read it.
- **Routes:** plan routes are schema-restricted, and map deterministically to
  export files (`/services` → `services.html`).
- **Runtime network:** fonts are self-hosted at build time, and the links gate
  already blocks remote assets, so no current site needs internet at runtime.
- **Identity:** `runProject` holds the exact `sitePlanRef`, and in job_lifecycle
  mode the canonical build binding. Both are now handed to `evaluateSite`.
- **Chromium's own sandbox:** it cannot start under `--cap-drop ALL` plus
  `no-new-privileges`, so it is off. The hardened container is the boundary.

**Runtime.**

- **Image:** `mcr.microsoft.com/playwright:v1.63.0-noble`, pinned by digest.
- **Client:** `playwright-core@1.63.0`, installed through the existing trusted
  install (`prepareTrustedDependencies`) from `templates/browser-runtime`'s own
  lockfile, with integrity pinned. No workspace package depends on a browser
  driver.

**BrowserRenderer** (`workspace/src/browser-renderer.ts`, `renderInBrowser`).

- **Per run:** one disposable container holds a trusted loopback static server
  and Chromium. It reuses the sandbox's container primitives, which are now
  exported unchanged.
- **Filesystem:**
  - a regular-file snapshot of the export, read-only at `/site`, digested;
  - the trusted client and this run's trusted runner, both read-only;
  - a read-only root, plus capped `/tmp` and `/dev/shm`. Nothing else.
- **Network:** `--network none`. Every other-origin request is also aborted in
  the browser and recorded.
- **Environment:** `HOME=/tmp` only.
- **Privileges:** non-root, capabilities dropped, `no-new-privileges`.
- **Limits:** 2 GiB memory with no swap, 2 CPUs, 512 PIDs, and a wall clock of
  startup plus a per-target budget, capped at 15 minutes.
- **Cancellation:** timeout and abort kill the container, then force-remove and
  verify it. The run directory is always removed.
- **Server:** GET and HEAD only; clean URLs; no traversal, runner files or host
  files.

**Policy** (one location each).

- **Viewports:** desktop 1440×900, tablet 768×1024 (touch), mobile 390×844
  (touch), all at scale 1.
- **Readiness:** `load` within 20 s, fonts settled within 5 s, 2 animation
  frames, a 250 ms settle, all within 10 s; `reducedMotion: 'reduce'` and
  service workers blocked.
- **Matrix:** every planned route at every viewport. Routes are rendered in plan
  order with the homepage first, capped at 24, and any `omittedRoutes` are
  reported.
- **Routes:** planned routes only, re-checked against the route grammar. An
  external URL, `//host`, `javascript:`, `file:`, a port, a query or a traversal
  is refused before anything runs.

**Report** (`contracts/browser.ts`, `BrowserRenderReport`).

- **Subject:** `projectId`, the exact `sitePlan` ArtifactRef, `sourceCommit`, and
  `exportDigest` over the bytes actually rendered.
- **Authority:** `legacy_direct` (no binding, stated honestly) or `job_lifecycle`
  with `buildBindingId`, `promotionId` and `promotionCommitSha`.
- **Also carries:** runtime and viewports, a run `status`, per-(route, viewport)
  renders (`status`, `httpStatus`, timings, findings), `omittedRoutes`,
  `passed`, `truncated` and `reason`.
- **Finding categories:**
  - blocking: `navigation_failed`, `http_error`, `runtime_exception`,
    `local_resource_failed`, `unexpected_navigation`, `readiness_timeout`;
  - recorded only: `console_error` and `external_request_blocked`.
- **Status:** the harness, not the runner, derives a render's status from its
  findings.
- **Bounds:** 10 findings per category per render, 500 characters each, 256 KB
  overall, dropping non-blocking findings first. All page text passes the sandbox
  sanitizer.
- **Runner robustness:** every page event handler is guarded, so hostile page
  behaviour becomes a finding rather than a crashed render. A `window.open` popup
  previously crashed the runner during testing.

**Integration.** `evaluateSite(ctx, { sitePlan, authority })` renders the exact
export after the deterministic gates and before Terra review, only when the build
compiled.

- **Advisory:** the report is returned on the evaluation (`browserRender`) and
  summarised in progress. It adds no defect, and changes no gate, adjudication or
  release decision.
- **Not durable yet:** the screenshot slice will define the durable artifact
  bound to this subject, rather than reusing project-scoped `visual-review`.
- **Unavailable:** a missing browser runtime gives `status: 'unavailable'`, not a
  crash.

**Tests.**

- **`browser-renderer.test.ts`:** pins, viewports, readiness, route authority
  and refusals, exact container arguments, the runner contract, and report bounds
  and sanitisation.
- **`browser-renderer.integration.test.ts` (real Chromium):**
  - home and second route at all viewports, with the exact subject and digest;
  - 404, missing CSS and JS, runtime exception, and `console.error` (not warn);
  - the live container inspected for no secrets, only three read-only mounts, no
    repo, home, `/tmp` or socket, `none` network, non-root and a read-only root;
  - blocked: external fetch, metadata, another local port, image, WebSocket
    (outer boundary), server traversal and runner and host files, `file:`,
    external redirect, meta refresh, iframe and popup;
  - host export byte-identical; giant console bounded and sanitized;
  - never-loading and blocked-after-load pages time out deterministically;
  - wall clock, abort and pre-aborted signal leave no container or Chromium;
  - malformed route and empty export start nothing;
  - a real sandboxed Next export renders cleanly.
- **`frontend-backend-build-boundary.integration.test.ts`:** `runProject`
  subject identity for legacy_direct (exact plan version and history commit) and
  job_lifecycle (exact binding, promotion and plan).
- **`browser-render-boundary.test.ts` (structural):**
  - only the renderer drives a browser, and only in its runner;
  - no package depends on a driver;
  - the renderer holds no job, promotion, release or model imports;
  - no `browser_preview` tool, and no screenshot, PDF or video;
  - evaluation order gates → render → review, and `evaluateSite` is the sole
    caller, with the exact plan ref and authority threaded.

**Mutations: 24 of 24 killed.** Each ran against the renderer unit, structural,
sandbox and tool-gateway suites, plus the matching real-browser or `runProject`
test where one applies. Sources were restored byte-identical and container debris
cleared after each.

- **Unit arguments plus the live-container inspection:** mounting the
  repository, home or Docker socket; a writable export; enabling network; and
  running as root.
- **Unit arguments only:** removing the memory or PID limit.
- **Unit and structural only:** inheriting `process.env`. Its integration run did
  not execute (all tests skipped), so it is not counted as an integration kill.
- **Structural only:** running Chromium on the host, writing job state, and
  registering `browser_preview`.
- **Unit route tests:** accepting an arbitrary route.
- **Real Chromium suite only:**
  - the metadata endpoint allowed;
  - the render timeout removed;
  - `pageerror`, `console.error` or failed local resources ignored;
  - an external redirect allowed;
  - the readiness bound removed.
- **Real abort test plus structural:** abort not destroying the container.
- **Unit bounds tests:** removing the diagnostic bounds (harness and runner).
- **`runProject` subject tests plus structural:** the subject losing its exact
  plan identity, and evaluation bypassing the renderer.

**Not in this slice:** screenshot artifacts, multimodal review, visual
refinement and any browser tool.

## Durable screenshots bound to the exact build — **DONE**

**Why.** Multimodal visual review needs images, and the images must be of the
exact revision under review — never "the latest homepage.png".

**Gate findings.**

- **Storage:** `ArtifactRegistry` stores JSON only (canonical-JSON sha256,
  immutable versions), and there was no binary store. Base64 inside artifact JSON
  would bloat documents that listings read whole.
- **Capture:** it fits inside the existing browser run, after the same readiness,
  with no weaker isolation. Images return over the runner's existing bounded
  output rather than a new writable mount.
- **Size and determinism (real Chromium):**

  | Page | Viewport | Size | Height |
  |---|---|---|---|
  | Scaffold homepage | Desktop | 10 KB | 900 px |
  | Scaffold homepage | Mobile | 7 KB | 844 px |
  | 40-section page | Desktop | 711 KB | 17,280 px |
  | 40-section page | Mobile | 584 KB | 25,120 px |

  Repeat captures of an unchanged page were byte-identical.

**Blob storage** (`workspace/src/blob-store.ts`, `state` `blobs` collection).

- **Keying:** content-addressed, `_id` `sha256:<hex>`, BSON Binary, one atomic
  insert, 12 MB per blob.
- **Deduplication:** identical bytes are one document, and a second write is a
  verified no-op.
- **Integrity:** a read re-hashes the bytes, and corruption raises `BlobCorrupt`.
- **Lifecycle:** immutable — no update, delete or garbage collection yet.

**Policy `statxai-screenshot@1`** (`SCREENSHOT_POLICY`).

- **Format and targets:** PNG only, one per route × viewport (desktop 1440×900,
  tablet 768×1024, mobile 390×844), scale 1.
- **Settings:** CSS scale, `reducedMotion: 'reduce'`, animations disabled, caret
  hidden.
- **Crop:** full page from the top, cropped to the viewport width and at most
  16,000 CSS px tall. The page's own size is recorded, and `truncated` marks a
  taller page.
- **Limits:** 8 MB per capture and 64 MB per set. A run may tighten them, and
  the set records the effective values.

**Capture** (inside `captureInBrowser`, the same runner and container).

- **When:** only when the page answered (HTTP < 400) and reached readiness. A
  page that loaded then threw is captured as diagnostic evidence; a 404 or
  never-ready page is `render_not_ready`, with no image.
- **Checks:** the runner enforces height, byte and set bounds. The harness
  re-validates every image: PNG signature, IHDR dimensions matching the claim,
  viewport width, and the height, byte and set bounds. Anything else is
  `invalid_image`.
- **Other outcomes:** a failing screenshot is `capture_failed`. A target with no
  line, including after a run timeout, is `not_run`.
- **Unchanged:** `renderInBrowser` still returns the report alone.

**Evidence** (`screenshot-evidence.ts`, `persistScreenshotSet`,
`contracts/browser.ts` `ScreenshotSet`).

- **Order:** blobs are written first, each checked against its captured sha256
  (a mismatch is `storage_failed`, never captured), then one `screenshot-set`
  artifact is written as an ordinary new version.
- **Contents:**
  - the exact subject: project, site-plan ref, source commit, export digest, and
    authority (`legacy_direct` carries no binding fields);
  - the effective policy and a browser summary;
  - `expectedCaptures`, `capturedCount`, `missingCount`, `totalBytes` and
    `omittedRoutes`;
  - `complete`, only when every target has a durable image from a completed run;
  - per capture: route, full viewport, reason, render status, finding
    categories, page size, `truncated`, image (blob, sha256, bytes, width,
    height) and detail.
- **Failures:** if the artifact write fails, no set claims anything, and any
  unreferenced blobs remain inert.
- **Repeats:** a repeated evaluation adds a new version, and the old version is
  untouched.

**Integration.** `evaluateSite` does capture → persist → review, and returns
`screenshotSet`, the exact ref it wrote (plus `browserRender` as before).

- **Advisory:** no defect, and no model call.
- **Abort:** a cancelled capture rejects before anything is persisted.

**Tests.**

- **`screenshot-evidence.integration.test.ts` (Mongo):**
  - blob round trip, deduplication, corruption, size bound and missing blob;
  - exact subject, policy, target and image metadata, with hash and bytes
    matching stored blobs;
  - legacy authority has no binding fields; missing targets make the set
    incomplete, as does an incomplete run;
  - blobs are written before the set;
  - failure modes: storage failure, hash mismatch and artifact write failure;
  - repeated evaluation is additive, with a deduplicated blob.
- **`screenshot-capture.integration.test.ts` (real Chromium plus Mongo):**
  - a real Next export's 6 captures, durable after the container is gone, with
    valid PNGs and policy dimensions, bound to the subject;
  - long page truncated at 16,000 px; runtime-error page captured with its
    finding; external image blocked and captured;
  - animation byte-identical across runs; responsive mobile layout;
  - 404 and never-ready pages get no image;
  - byte cap, set cap, height cap and `capture_failed` enforced;
  - the live container inspected (no secrets, read-only mounts, no network,
    non-root);
  - abort persists nothing.
- **`runProject` subject tests:** the exact `screenshot-set` ref is returned, and
  its subject matches for legacy_direct and job_lifecycle.
- **Structural:**
  - a screenshot is taken only in the isolated runner, and no PDF or video;
  - evidence code holds no model, job, promotion or release authority;
  - the set is written with `registry.put`, and never read by name anywhere;
  - `store.blobs` is touched only by the blob store;
  - blobs are written before the set;
  - evaluation returns the exact ref, and no tool or skill reaches screenshots.

**Mutations: 22 of 22 killed.** Each ran against the browser, sandbox and
tool-gateway structural and unit suites, plus the matching persistence,
real-capture or `runProject` test. Sources were restored byte-identical and
container debris cleared after each.

- **Persistence suite:** the subject losing its plan ref, source commit, export
  digest or binding authority; route, viewport or policy-version metadata
  dropped; hash verification removed; blobs written after the set; an incomplete
  set marked complete; repeated evaluation overwriting old sets.
- **Real Chromium suite:** the pixel bound, byte cap or aggregate cap removed; a
  failed route fabricating a capture; a cancelled run completing.
- **Structural suite only:** host Chromium, a model import, the browser tool
  registered, and a latest-version lookup (a single evaluation's latest equals
  its own version, so the `runProject` test cannot see it).
- **`runProject` subject tests only:** evaluation skipping persistence.
- **Both structural and `runProject` tests:** images written only to a temp
  directory.

**Not in this slice:** multimodal review, visual scoring, refinement,
customer or editor UI, and any browser tool.

## Multimodal Terra visual review — **DONE**

**Why.** Every quality judgement so far read source or HTML text. The exact
screenshot set from `b9ef481` lets Terra judge the rendered pixels a visitor
actually sees.

**Gate findings.**

- **Provider path:** text-only. `ProviderRequest` had one prompt string, and
  `OpenAiProvider` sent a string user message. The installed SDK (openai 7.4.0)
  accepts base64 data-URL `image_url` parts.
- **Provider image limits:** fit into 2048 px, then the shortest side scaled to
  768 at high detail. A 1440×16,000 capture sent whole would be about 184 px wide,
  so tall captures need deterministic derivatives.
- **Existing `visual-review`:** textual (source and exported HTML against
  `ReviewOutcomeInput`, P0–P3 defects that can block). It is also read by
  latest-version lookups in `release.ts` and the console. Those lookups are
  untouched.

**Runtime.** `ModelInvocation`, `CallOptions` and `ProviderRequest` gain an
optional `images` field of labelled PNG bytes.

- **Provider:** `OpenAiProvider.userContent` sends each label, then the image, as
  a high-detail base64 data URL.
- **Text-only:** a request without images stays a plain string, byte-for-byte.
- **Retries:** a truncation retry keeps the images.
- **Usage:** one invocation is still one usage event, from the runtime alone.

**Frames (`statxai-visual-review-frames@1`, `workspace/src/review-frames.ts`).**

- **Decoder:** exact, for 8-bit RGB and RGBA non-interlaced PNGs (all five
  filters), verified on real Chromium captures. Anything else is refused.
- **Framing:**
  - frames are one viewport tall at native width, never scaled;
  - at most 4 per capture; a taller page is sampled evenly from its top to its
    bottom, never only the hero;
  - encoding is deterministic (filter 0, fixed deflate level);
  - each frame records route, viewport, index and count, offset, size, sha256,
    and its source screenshot's sha256 and height.
- **Budget:** 48 frames and 20 MB per review. Frames per capture drop first; then
  captures beyond the budget, in set order, are listed as `notReviewed`.
- **Immutability:** durable screenshots are only read.

**Contract (`contracts/visual-review.ts`).**

- **Model output, `VisualQualityAssessment`:** strict.
  - `overallScore` plus 8 scores, all integers 0–100: `composition`,
    `typography`, `spacingRhythm`, `hierarchy`, `brandDistinctiveness`,
    `assetQuality`, `conversionClarity`, `mobileQuality`;
  - `summary`, `routeReviews`, `strengths`;
  - `issues`: VQ id, route, viewports, dimension, severity (major, moderate,
    minor), problem, direction;
  - `antiPatterns` from a fixed list of 10 template patterns;
  - up to 10 ranked `refinementPriorities`.
  - Nothing executable.
- **Persisted artifact, `visual-quality-review` (`VisualQualityReview`,
  `statxai-visual-review@1`):**
  - the frame policy version, the exact `screenshotSet` ref, the screenshot
    policy version and the exact subject;
  - `status` and coverage: expected and reviewed targets, `missing` with
    reasons, `notReviewed`, and `complete`;
  - the frames, the assessment, the failure, and the reviewer's skill, tier,
    model, invocation ID and tokens.
- **Historical `visual-review`:** keeps its name and textual meaning, is still
  written, and does not parse as a multimodal review.

**Review (`phases/visual-review.ts`, `reviewScreenshotSetVisually`).**

- **Inputs:** the set is read by the exact ref via `registry.resolve`. Every
  image is read by its exact blob key and re-hashed against the set's recorded
  sha256 and byte count.
- **Fail closed:** a missing, altered or undecodable image is `evidence_invalid`,
  with no model call. A set with nothing captured, or nothing fitting the budget,
  is `no_evidence`.
- **Invocation:** one `terra-review` invocation (label `terra:visual-review`) with
  the frames as images, plus the brand system, pages, a list of targets not
  shown, and concise browser findings.
- **Model failures:**
  - a refusal is `refused`;
  - a malformed answer is `malformed_output`;
  - any other error is `provider_failed`;
  - an answer describing a target it was not shown is also `malformed_output`,
    with no assessment kept.
- **Persistence:** every outcome writes an additive `visual-quality-review`, and
  the exact ref is returned.

**Integration.** `evaluateSite` runs:

> screenshot set → visual review → the existing textual review

and returns `visualQualityReview` (exact ref plus content).

- **Sol:** `seekRelease` and `adjudicateDefects` receive it from the evaluation,
  never by lookup. Both Sol prompts gain a "rendered visual quality review"
  section naming `visual-quality-review@N of screenshot-set@M`. The approval
  record stores the exact `visualQualityReview` ref.
- **Advisory:** no defect, gate, adjudication or release policy changes.
- **Authority:** no tools (the ToolGateway stays filesystem and test_runner), no
  build output, and no files, Git, jobs, promotion or deployment.

**Tests.**

- **`terra-visual-review.test.ts`:**
  - labelled images reach the request, with one usage event;
  - the prompt names all 8 scores and 10 patterns, and the schema has nothing
    executable;
  - out-of-range, missing score, build-output and unknown-dimension answers are
    malformed;
  - refusal and provider failure stay distinct, and a truncation retry keeps its
    images;
  - OpenAI request contract: `image_url` data URLs of the exact bytes, and
    text-only requests unchanged.
- **`review-frames.test.ts`:** all filters for RGB and RGBA; refusal of anything
  undecodable; the offset policy, including even top-to-bottom sampling; exact
  frame rows; the source untouched; determinism.
- **`visual-review.integration.test.ts` (Mongo):**
  - desktop, tablet, mobile and the second route all reach the request as real
    frame bytes;
  - the tall page gets 4 frames to the bottom; the durable blob is unchanged;
  - provenance: exact set ref, both policy versions and the subject;
  - coverage names the missing target, and full coverage is not claimed;
  - reads the given set, not a newer one;
  - an unseen-target answer is malformed; repeated reviews are additive;
  - corrupt, missing and set-hash-mismatched blobs fail closed with no call;
  - refusal, malformed output and provider failure each keep their status;
  - no evidence means no call; the budget reduction is deterministic;
  - a historical textual review is not parsed as multimodal.
- **`screenshot-capture.integration.test.ts`:** real Chromium PNGs decode and
  frame exactly.
- **Parity:** Sol's evidence names the exact review, and the approval record
  stores its exact ref; lineage gains `visual-quality-review@1`.
- **Phase 5q recovery:** re-evaluation writes a fresh set and review bound to the
  recovered binding.
- **`visual-review-boundary.test.ts` (structural):**
  - only `terra-review` sends images, in one runtime invocation, and only the
    provider builds image parts;
  - the skill has no tools, build output or files;
  - only the phase calls the skill, and only evaluation runs the phase;
  - the phase uses `resolve` and `put` only, reads by blob key, re-hashes, and
    has no lookups;
  - no tool, file, Git, job, promotion or deployment authority;
  - evaluation order, exact hand-off to Sol, and no refinement consumers.

**Mutations: 22 of 22 killed.** Each ran against the visual-review structural,
agents, frame, browser and tool-gateway unit suites, plus the phase, parity or
recovery integration tests where applicable. Sources were restored
byte-identical after each.

- **Phase suite:**
  - the set resolved by latest, and the set-hash check removed;
  - the desktop image, mobile image or second route omitted, and a tall page
    reduced to its hero;
  - an incomplete review marked complete;
  - the set ref, screenshot policy version or review schema version omitted.
- **Agents contract and runtime suite:**
  - the composition, brandDistinctiveness or mobileQuality score omitted, and
    score range validation removed;
  - the model call bypassing `ModelRuntime`, and images replaced by a text-only
    prompt;
  - usage recorded twice, the skill given tool permission, and a `BuildOutput`
    accepted as a review.
- **Parity suite plus structural:** Sol recording a latest-lookup reference,
  instead of the exact ref.
- **Parity lineage and Sol evidence tests:** the multimodal review written under
  the historical `visual-review` name.
- **Parity, Phase 5q recovery and structural tests:** evaluation skipping visual
  review.

**Known flake:** the pre-existing `acceptance vs abandonment race` integration
test is timing-sensitive. It failed once in 18 runs with this change, passed 8 of
8 at baseline, and exercises no code this capability touches.

**Not in this slice:** visual refinement, customer UI, and any browser tool.

## Typed build-successor provenance — **DONE**

**Why.** A build binding with a `predecessorBindingId` could only ever be a
replan successor, so a predecessor implied a replan. A visual refinement needs
to be a successor too, with its own exact reason, before any refinement loop can
exist.

**Gate findings.**

- **Writer:** the orchestrator's replan is the only production code that prepares
  a successor.
- **Readers:** Phase 5k consistency (resume, abandonment, prepare convergence),
  the active-lineage walk, Phase 5q recovery, and the duplicate-key rival lookup.
- **Index:** the one-successor index is keyed on `{ projectId, predecessorBindingId }`
  alone, so it is already reason-independent.
- **Release publication:** reads only lineage root and canonical binding IDs, so
  it is unchanged.

**Contract (`contracts/build-lineage.ts`).** `BuildSuccessorProvenance` is a
discriminated union of two strict shapes:

- `replan`: the exact `replan-decision` ref;
- `visual_refinement`: the exact `visual-quality-review` and `screenshot-set`
  refs, plus `refinementCycle` (integer, 1–1000).

Ref names are enforced. The contract is identity only: no budget, threshold or
eligibility.

**Persistence. No migration or backfill.**

- A replan successor is still written as `predecessorBindingId` plus
  `replanDecision`, exactly as before, so historical replan successors are
  already in the new format.
- A visual-refinement successor is written as `predecessorBindingId` plus
  `successorProvenance`.
- An initial build writes neither, and still takes `activeLineage: true`.
- Every successor inherits its predecessor's `lineageRootBindingId`, whatever its
  reason.

**One reader, `readBuildLineage`.** It returns either `initial` or `successor`
(the exact predecessor and typed provenance). These shapes are corrupt, and
nothing is guessed:

- a predecessor with no reason;
- a reason with no predecessor;
- both encodings at once;
- a malformed ref, ref name or cycle.

**Consistency and lineage.**

- `prepareFrontendBackendBuildBinding` takes `lineage: { predecessorBindingId,
  provenance }`. It validates the provenance before anything is read or written,
  and refuses an invalid one with `FrontendBackendBuildSuccessorProvenanceInvalid`.
- `verifyBindingConsistency` requires the exact predecessor, the same kind and
  exactly the same provenance. A successor presented as an initial build is
  corrupt.
- `deriveActiveLineageTip` classifies the root and every member through the
  reader; malformed provenance is `FrontendBackendBuildLineageCorrupt`.
- One successor per predecessor holds across reasons: a replan successor blocks a
  visual one, and the reverse (`FrontendBackendBuildLineageConflict`).

**Phase 5q.** Recovery reads the tip's lineage position and proves it
structurally with the stored provenance. A proven `visual_refinement` tip is then
refused with `ActiveContinuationSuccessorNotOwned`: never corrupt, and never
continued as a replan. Replan tips recover as before.

**Tests.**

- **`build-successor-provenance.integration.test.ts` (Mongo, 29 tests):**
  - historical initial and replan bindings read unchanged, and nothing is written;
  - a typed replan persists in the replan encoding;
  - a visual successor persists exact refs and cycle, inherits the root, and
    takes no active-lineage slot;
  - exact replay converges; any other cycle, review, set or kind is corrupt;
  - 9 invalid reasons are refused with nothing written;
  - 9 contradictory stored shapes are corrupt;
  - one slot per predecessor in both directions;
  - mixed replan and visual chains derive one tip;
  - the walk fails closed on malformed member provenance, a root carrying a
    reason, and an unreachable member;
  - 5q: a visual tip is not owned, and a replan tip passes lineage.
- **`build-successor-provenance-boundary.test.ts` (structural, 10 tests):**
  - the union is exhaustive and strict, and the contract imports nothing but Zod
    and primitives;
  - stored reason fields are read only in `readBuildLineage`;
  - there is no predecessor-implies-replan branch;
  - the walk and consistency go through the reader, and preparation validates
    before insert;
  - the index is keyed on the predecessor alone, and lineage has no time or
    version ordering;
  - 5q verifies before refusing;
  - the replan is the only successor caller, with no refine skill, `JobOrigin`,
    budget or threshold.
- **Migrated:** the active-lineage, replan-lineage and release-publication
  lineage tests pass `provenance: replan(...)`. The browser-render and
  visual-review boundary tests now allow the typed identity to name
  `screenshot-set` and `visual-quality-review` refs, and nothing more.

**Mutations: 22 of 22 killed.** Each ran against the structural test plus the
provenance integration test (and the active-lineage test for the root check).
Sources were restored byte-identical after each.

- **Reader:**
  - legacy `replanDecision` ignored;
  - a predecessor with no reason read as a replan;
  - a reason with no predecessor read as initial;
  - hybrid encodings accepted;
  - the visual encoding accepting any kind.
- **Preparation:**
  - validation skipped, and ref names not enforced;
  - a visual reason persisted in the replan encoding;
  - a visual successor taking the active-lineage slot, or founding its own root;
  - the rival lookup restricted to replans.
- **Consistency:**
  - exact provenance ignoring the cycle or screenshot set;
  - a kind mismatch accepted;
  - a visual successor presented as initial accepted.
- **Lineage:**
  - the walk skipping member validation;
  - a root with a reason accepted;
  - the index filtered on a reason.
- **5q and orchestrator:**
  - a visual tip continued as a replan, or reported as corrupt;
  - the tip verified without its stored lineage;
  - the orchestrator's replan writing a non-replan reason.

**Not in this slice:** the visual-refinement loop, `terra-refine`, a
`visual_refine` job origin, refinement budget or thresholds, and any production
caller that prepares a visual-refinement successor.

## Bounded Terra visual refinement — **DONE**

**Why.** A canonical build now has an exact screenshot set and an exact
multimodal review. This slice lets the harness act on that review. It allows a
small, durable, policy-bounded number of Terra refinements, and each one is an
ordinary successor build.

**Gate findings.**

- **Source authority.** The binding's `promotionId` names a committed receipt,
  and that receipt names the exact accepted `build-candidate` and commit. The
  candidate alone is not the current source, because Luna repairs commit
  directly to the canonical tree after promotion. The exact rendered source is
  the commit in the screenshot set's `subject.sourceCommit`.
- **Job identity.** The job id is `contentHash` over the whole spec except
  `jobId`. A refinement that pinned only the profile and plan would collide with
  B0.
- **Budgets.** `BudgetDocument` had no honest key for refinement.
  `spend` is a guarded `$expr` update that runs inside a transaction.
- **Successor spec commit.** `ensureSpecificationCommitted` throws when there is
  nothing to commit, and Phase 5q requires `specificationCommitSha`. The plan does
  not change, so the refinement's own harness record is what gets committed.
- **Prepared successors.** Phase 5k resume already refuses any prepared successor
  (`verifyBindingConsistency` with no lineage). That behaviour is unchanged here,
  so a prepared refinement successor is refused exactly as a prepared replan
  successor is.

**Source (`contracts/visual-refinement.ts`, `ProjectWorkspace.readModelSourceAtCommit`).**
Before anything is read, the authorisation proves all of these:

- the build is promoted, with a committed receipt for the same job and commit;
- exactly one canonical commit carries its promotion marker;
- the build is the exact active-lineage tip;
- the review's subject is this build and plan;
- canonical HEAD equals `sourceCommit`;
- `sourceCommit` descends from the promotion commit.

It then reads the model-owned source files (`isModelSourceFile`) tracked at
exactly that SHA from Git's object store. It never reads the working tree, and it
accepts only a full SHA. The snapshot is bounded to 80 files and 400 KB, and a
larger site is refused (`source_too_large`), never truncated. The
`visual-refinement-source` artifact records the predecessor, the promotion, the
source commit, the cycle, the review and set refs, the files and `filesDigest`.
The filesystem tool is unchanged: it still reads the platform scaffold only.

**Policy (`visual-refinement/policy.ts`, `statxai-visual-refinement-policy@1`).**
The policy is pure, and it reads structured evidence only. It checks, in order:

1. Fences: `awaiting_human_review`, or any release publication for the lineage
   in any status.
2. Review status is `reviewed`. Otherwise the review is `review_unusable`.
3. Coverage is complete.
4. Budget remains.
5. At least one trigger holds:
   - overall score below 80;
   - composition, typography, hierarchy or mobileQuality below 70;
   - any `major` issue.
6. When the build is itself a visual refinement, its overall score must be
   strictly above the score of the review that triggered it. Otherwise the
   result is `not_improved`: refinement stops, and nothing is rolled back.

Refinement priorities and prose never trigger a pass.

**Durable budget and intent.**

- **Budget.** `visualRefinements` has a limit of 2 (`DEFAULT_BUDGET_LIMITS`). The
  field is optional, so a budget written before it existed matches no guarded
  spend and is never refined. There is no backfill.
- **Intent.** `visual_refinement_intents` holds one document per predecessor,
  with a deterministic `_id` and a unique index on `{ projectId,
  predecessorBindingId }`. It records the review, set, cycle, policy, source
  commit, source ref, job spec, job id, successor binding id and budget slot.
- **Transaction.** One transaction spends the slot, puts the source and inserts
  the intent, before any model call.
- **Replay.** A replay for the same build returns the stored intent. That covers
  a restart and a re-evaluation with a newer review alike. A replay spends
  nothing and makes no new decision, although the fences still apply.
- **When a slot is spent.** It is spent at authorisation and never refunded. A
  model failure, an invalid output and a failed validation each keep it.
- **Cycle.** The cycle is derived by walking exact predecessor ids.

**Job.**

- **Spec.** `createFrontendBackendVisualRefinementJobSpec` uses the same identity
  primitive, grant (`filesystem`, `test_runner`) and output as a build. It has its
  own objective and three extra pinned inputs, each with a content hash:
  `visualRefinementSource`, `visualQualityReview` and `screenshotSet`. B0, B1 and
  B2 therefore differ deterministically.
- **Origin.** `{ kind: 'visual_refine', refinementCycle }`, strict.
- **Consistency.** `verifyBindingConsistency` requires a visual successor's spec to
  pin exactly its provenance's review and set. No other binding's spec may pin
  refinement inputs.

**Terra-refine (`agents/skills/terra-refine.ts`).**

- It is a distinct skill at tier `terra`. `terra-review` is unchanged.
- It runs through Terra's existing bounded build loop, with the same turn, read
  and test bounds.
- The loop now takes a skill, a system prompt and images, and every stateless
  turn carries the same images.
- Its input covers:
  - the profile, the fixed plan and its routes;
  - the allowed namespaces;
  - the cycle and predecessor;
  - the exact source;
  - the scores, summary, ranked priorities, issues, anti-patterns and strengths;
  - the exact reviewed frames.
- It returns a strict, complete `BuildOutput`.
- **Frames.** The handler recuts them with `reproduceReviewFrames`. Each image is
  read by exact blob key and re-hashed, and each frame must match the review's
  recorded sha256, offset and size.

**Lifecycle (`orchestrator.ts`).** Refinement is considered only when nothing
blocks, and before `seekRelease`.

1. Authorise the refinement.
2. Prepare the successor, with `successorProvenance.kind = visual_refinement`.
3. Set the project state to `building`.
4. Materialise and commit `decisions/visual-refinement.json` as the specification
   commit.
5. Run `lifecycleCoordinator.run(intent.jobSpec, { kind: 'visual_refine' })`.
   That is the Terra handler, the write boundary, sandboxed 5g-1 validation, 5g-2
   acceptance, the 5n fence, the 5h receipt and exact-replacement promotion.
6. Finalise the binding, then `continue` to a fresh evaluation.

The fresh evaluation runs gates, render, a new screenshot set and a new review,
all bound to the new build. A non-promoted refinement stops the run as `blocked`,
exactly as an unpromoted replan rebuild does.

Validation of a refinement job adds `plan-conformance` findings (P0) for an added
or dropped page route. Sol's approval therefore always receives the final build's
exact review.

**Phase 5q.** `ActiveContinuationSuccessorNotOwned` is removed. A promoted
visual-refinement tip is proven like any other tip and then evaluated. Whether to
refine again is decided from its own typed provenance: the cycle, and the
triggering review for the improvement rule. The call that produced it is never
replayed.

**Tests.**

- **`visual-refinement-policy.test.ts` (31):**
  - the pinned policy and budget defaults;
  - exact thresholds;
  - every unusable status;
  - incomplete coverage;
  - the model cannot ask for a pass;
  - fences and budget, including a missing budget;
  - improvement, equal and worse second passes;
  - B0, B1 and B2 identity, replay identity, sensitivity to each pinned input,
    and refusal of unhashed refs.
- **`terra-refine.test.ts` (9):**
  - a distinct terra skill, one usage event per invocation, strict `BuildOutput`;
  - labelled images and the exact evidence and source in the prompt;
  - the same images on every tool-loop turn;
  - only filesystem and test_runner described;
  - an ungranted tool is malformed, and the turn bound holds;
  - advisory tests are never the answer.
- **`source-snapshot.test.ts` (6):** the exact tracked model source at a SHA,
  pinned against later commits and the dirty tree, deterministic, bounded,
  exact-SHA only, and ancestry.
- **`visual-refinement-authority.integration.test.ts` (17):**
  - one slot, source and intent;
  - a source read at a post-promotion repair commit, never the stale candidate;
  - replay across a restart with a newer review, and concurrent convergence;
  - nothing spent when refinement is ineligible;
  - no third pass, and a legacy budget refines nothing;
  - fail closed on a stale HEAD, a non-descendant commit, a different build, a
    missing receipt or a foreign promotion;
  - working-tree independence;
  - the tip requirement, and no replan branch from the same predecessor;
  - human review, including on replay, and each release status.
- **`visual-refinement-run.integration.test.ts` (8), real `runProject`:**
  - **B0 → B1 → B2:**
    - typed provenance, root and cycles;
    - fresh gates, render, sets and reviews bound to each build;
    - Terra saw the exact triggering review, set, frames and predecessor source;
    - job origins, fences and receipts;
    - the budget stopping a third pass;
    - Sol judged once, on B2's exact review.
  - **No improvement:** the worse build stays canonical and is judged.
  - **Good review:** no refinement.
  - **Validation failure:** blocked, the slot kept, B0's tree kept.
  - **Forbidden path:** refused at the write boundary.
  - **Model failure:** the slot kept, and the next run refuses the prepared
    successor, as Phase 5k does for any successor.
  - **Crash after B1 promoted:** recovery evaluates B1 without re-refining or
    re-spending.
  - **Recovered second pass:** cycle 2.
- **`visual-refinement-boundary.test.ts` (13, structural):**
  - skill separation, with no write or authority imports;
  - the loop carries images on every turn;
  - only filesystem and test_runner adapters, and the filesystem tool is not
    widened;
  - the source is read only after its proofs;
  - the pure policy, reached only through the authorisation and the run;
  - the transactional budget, with no process counter;
  - refinement before Sol, and only through the coordinator;
  - no latest lookups, and a pinned identity;
  - recovery never refines.
- **Migrated to the new truth:** the runtime skill table, the model-boundary
  shared-loop rule, the tool-gateway suppliers, the state-transition counts
  (`building` ×4), the browser-render promotion sites and screenshot viewers, the
  visual-review image senders, consumers and frame reproduction, the provenance
  suites (5q now owns visual tips, and specs pin refinement inputs) and the budget
  defaults.

**Mutations: 36 of 36 killed.** Each ran against the relevant unit or structural
suites and the authority or run integration tests. Sources were restored
byte-identical after each.

- **Policy:**
  - eligibility removed;
  - a high-quality review refined;
  - an unusable review refined;
  - the limit removed;
  - a non-improving build given another pass;
  - a third pass allowed.
- **Budget and replay:**
  - a memory counter instead of the durable spend;
  - replay spending twice;
  - a failed refinement refunding its slot;
  - crash replay spending another slot.
- **Identity:**
  - B0 and B1 sharing a job id;
  - the source snapshot, screenshot set or review removed from the job;
  - the source commit replaced by the promotion commit.
- **Source and tools:**
  - the source read without HEAD and ancestry proof;
  - the filesystem tool widened;
  - terra-refine bypassing `ModelRuntime`;
  - images omitted;
  - terra-review returning `BuildOutput`;
  - `browser_preview` granted.
- **Lifecycle:**
  - official validation skipped;
  - the write boundary bypassed;
  - the successor labelled a replan;
  - the predecessor substituted;
  - the provenance refs substituted;
  - the one-successor index made reason-specific;
  - the promotion fence skipped.
- **Evidence:**
  - B1 reusing S0 or V0;
  - Sol judging before refinement;
  - final approval using the stale review.
- **Recovery and fences:**
  - crash replay restarting from the predecessor;
  - 5q rejecting a visual tip;
  - the human-review fence bypassed;
  - the release fence bypassed.

**Not in this slice:** a structured editable site model, a customer editor, a
browser tool, automatic rollback, visual release-blocking policy, and automatic
resume of a prepared, unpromoted successor, for replans and refinements alike.

## Structured editable site model — **DONE**

**Why.** Future editing needs stable semantic identity. It must be able to
say "update field X" or "move section Y" without source lines, selectors, DOM
positions or text matching. This slice establishes that identity, binds it to
every build, and defines the bounded operations over it. There is no editor UI.

**Gate findings.**

- **`SitePlan`** is planning authority. It holds the strategy and value
  proposition, and a brand system: palette strings, typography strings, radius
  and art direction. It holds pages with a route, title, meta description, goal
  and primary action. Each page holds sections with a Sol-chosen `id`, a
  `heading`, a `purpose`, a bounded `layout` and `contentBindings`. It has no
  assets, blocks or copy beyond headings.
  - The `route` and section `id` are stable semantic keys.
  - `purpose`, `goal` and `contentBindings` are instructions, not editable
    content, so they stay out of the model.
- **`BuildOutput`** is only `files[] + notes`. Terra emits no semantic
  metadata, and generated HTML carried no markers.
- **Content.** Copy other than headings, titles and descriptions exists only
  inside Terra's JSX. Visual refinement can rewrite any text.
- **Consequence.** The model claims only what the harness can deterministically
  prove in every build:
  - page identity, `<title>` and meta description;
  - section identity, order and visibility;
  - section headings;
  - any blocks and fields the model contains.
  
  All other in-section content remains implementation owned. Generated React is
  the implementation layer, not a model AST.
- **Export.** `data-*` attributes survive a real sandboxed `next build` static
  export, including values passed as component props
  (`site-model-export.integration.test.ts`).

**Contract (`contracts/editable-site-model.ts`, `statxai-editable-site-model@1`).**

- **Model:** `EditableSiteModel` is strict and holds `projectId`, an exact
  `sitePlan` ref, `provenance`, `design`, `pages`, `assets` and `identity`.
- **Identity:** opaque typed IDs `pg_ / sec_ / blk_ / fld_ / ast_` followed by 16
  hex characters.
- **Pages:** each has `route`, `title` and `description` fields, and ordered
  sections.
- **Sections:** each has `planKey`, a bounded `layout`, `visibility`, a single
  `heading` field and `blocks`.
- **Blocks:** blocks are `SUPPORTED_BLOCKS`, and each kind fixes its fields:
  - `text`, `cta`, `card`, `stat`, `step`, `faq_item`;
  - `phone`, `email`, `address`, `image`.
- **Fields:** field types are `text`, `cta` (label plus a safe href), `phone`,
  `email`, `address` and `asset`.
- **Assets:** an asset slot (`assetId`) is separate from what fills it
  (`unassigned`, or a sha256 blob with media type and size).
- **Design tokens:** colour values (hex or colour functions, never
  declarations), single font families, size and scale patterns, radius enum and
  art-direction prose.
- **Refinements:** unique IDs across all kinds, no retired ID in use, unique
  routes and a homepage, unique plan keys per page, each block's fields exactly
  its kind, and no dangling asset references.
- **Markers:** `SITE_MODEL_MARKERS` defines the public attributes
  `data-statx-{page,section,block,field,asset}-id`. IDs are sha256-derived and
  expose nothing secret.

**Identity authority (`orchestrator/src/site-model/identity.ts`).** IDs come into
being in only two ways, both inside the harness:

- **Derived:** `sha256(schema, prefix, project, parent, key)`.
  - A page derives from its route.
  - A section derives from its plan key on its page.
  - A field derives from its key on its owner.
  - Nothing positional, textual or source-derived is ever part of the key.
- **Minted:** from the lineage's monotonic `identity.minted` counter. This is
  used for patch-added blocks, or when a derived ID is retired or taken.
- **Retirement:** retired IDs are carried forever in `identity.retired`, and
  allocation skips used and retired IDs.

**Materialisation and replan (`site-model/materialize.ts`).**

- **`modelFromPlan`** runs in `runProject` before the first build's spec is
  created. It is deterministic.
- **`reconcileModelWithPlan`** is a true replan.
  - A page survives if the revised plan still has its route. A section survives
    if its page survives and its plan key remains.
  - Survivors keep their IDs, blocks, visibility and field IDs. Headings, layout,
    title and description take the revised plan's values.
  - New objects get new IDs, never retired ones.
  - Removed objects are retired with all their descendants.
  - A renamed route is a removed page plus a new page, with no fuzzy matching.
- **Unconstructible plans:** a plan that cannot be expressed as a model (a
  non-colour value, duplicate plan keys) fails closed before any build.

**Artifact (`site-model/persist.ts`).**

- **Record:** `recordEditableSiteModel` validates the model and puts an
  additive `editable-site-model` version, whose ref carries its content hash.
- **Resolve:** `resolveEditableSiteModel` reads exactly one ref. It refuses a
  wrong name, a missing hash, a hash mismatch, another project or an invalid
  model.
- **Commit:** `commitSemanticPatch` resolves the exact base, applies the patch
  and records a new version with `semantic_patch` provenance. That provenance
  holds the base ref, the operation and the target, and the base is never
  rewritten.
- **No latest lookups:** no production code reads a model by name or latest.

**Semantic patches (`contracts` union, `site-model/patch.ts`).**

- **Operations:** `set_field_value`, `set_asset`, `set_visibility`,
  `move_section`, `set_section_layout`, `set_design_token`, `add_block` and
  `remove_block`.
- **Exact base:** every patch names an exact base `editable-site-model` ref with
  its content hash.
- **Purity:** `applySemanticPatch` is pure. It works on a `structuredClone`,
  holds no store, clock or randomness, and always gives the same result for the
  same input.
- **Rejections (typed codes):**
  - `base_mismatch`, `invalid_patch`, `wrong_target_type`, `unknown_target`;
  - `stale_expectation` (the value the author saw is no longer there);
  - `invalid_value`, `invariant_violation`.
- **Additions:** `add_block` mints its block ID.
- **Removals:** `remove_block` retires the block and its field IDs.
- **Source:** patches write no source and trigger no build. Applying a model to
  code is later work.

**Build contract and render binding.**

- **Job spec:** `createFrontendBackendJobSpec` and the refinement factory take
  an optional exact `editableSiteModelRef`. New `job_lifecycle` generations
  always pin one.
- **Handler:** the handler resolves the model exactly, checks it describes the
  pinned plan, and hands it to Terra. The build, anchor, page and refine prompts
  get `semanticIdentityBrief` with exact IDs, headings, titles and rules. Luna's
  prompt forbids touching markers.
- **Gate:** the site-model gate (`gates/site-model-markers.ts`) runs inside
  `runDeterministicGates` whenever a model is pinned. That covers official
  validation, advisory test_runner and canonical evaluation. For every page it
  checks:
  - the route exported, and the exact `<title>` and meta description;
  - exactly one page marker;
  - every visible section once, inside the page, in model order, with no hidden
    section rendered;
  - every field and block once, inside its owner, with its exact value (a CTA as
    `<a href>` plus its label; an asset through the asset marker);
  - no duplicates, no IDs from another page, and no unknown IDs.
  
  Findings are P0 on the route's source file, so a candidate that breaks
  identity never validates, and a canonical tree that does becomes a repairable
  defect.
- **Browser DOM:** the gate reads the static export the renderer serves. It does
  not add a check inside the Playwright DOM.

**Refinement, repair, replan.**

- **Refinement** pins the predecessor's exact model ref, and the refine prompt
  requires marker and text preservation. Validation enforces it: a refinement
  that drops a marker fails. It never creates a model version.
- **Luna repairs** are measured by the next evaluation's site-model gate.
- **A replan** records a reconciled version pinned by the successor.
- **Phase 5q recovery** evaluates against the tip's pinned model.

**Legacy.** Specs without a model ref, meaning historical bindings and
`legacy_direct` runs, have no site-model gate and no model. They behave exactly
as before, and no model is fabricated for them.

**Tests.**

- **`editable-site-model.test.ts` (47):**
  - typed, unique, opaque IDs that are independent of position and text;
  - contract rejections: duplicates, routes, homepage, mistyped IDs, dangling
    assets, block fields, retired IDs in use, CSS in tokens or sections, and
    `javascript:` links;
  - replan survival, retirement and no reuse;
  - every patch operation and rejection code;
  - determinism, and the base left unchanged;
  - the gate's detections.
- **`editable-site-model-artifact.integration.test.ts` (5):** exact refs, additive
  versions, provenance, historical readability, stale patches, and ref refusal.
- **`editable-site-model-pipeline.integration.test.ts` (8):**
  - the model is recorded before the build, pinned in the spec, binding and job,
    handed to Terra, and gated in validation and evaluation;
  - `legacy_direct` is unchanged;
  - five kinds of Terra tampering fail validation;
  - a marker-dropping Luna repair becomes a blocking site-model defect.
- **`site-model-export.integration.test.ts` (2):** a real Next export keeps the
  markers and passes the gate, and fails it against a different model.
- **`site-model-brief.test.ts` (4):** exact per-call briefs, no hidden sections,
  a model-less build unchanged, and refinement told to preserve.
- **`editable-site-model-boundary.test.ts` (13, structural):**
  - distinct from `SitePlan` and `BuildOutput`;
  - bounded tokens;
  - IDs only in the identity module and derived from semantic keys, with no
    hard-coded IDs and no minting in agents;
  - the patch engine is pure and nothing applies patches to source;
  - no console UI;
  - exact-ref resolution only;
  - the gate sits in the one measurement path;
  - markers and prompts;
  - the gateway is still filesystem and test_runner.
- **Additions to existing suites:**
  - visual refinement: the same model is pinned, and a refinement dropping a
    marker fails;
  - replan: the model chain, survivor IDs and retired routes.
- **Migrated:**
  - the nine runProject suites fake their export from the pinned model
    (`test/support/site-model-export.ts`), so the real gate runs;
  - structural call-site assertions in tool-gateway, sandbox and
    browser-render;
  - recovered release checks now include `site-model`.

**Mutations: 20 of 20 killed.** Each ran against the model or boundary unit
suites, plus the artifact, pipeline or refinement integration tests where
relevant. Sources were restored byte-identical after each, and a created file was
removed.

- **Identity:**
  - a duplicate ID accepted;
  - an ID derived from its array index;
  - a move regenerating the section ID;
  - retirement dropped on removal;
  - an asset slot re-identified when its image changes.
- **Patches:**
  - an unknown target accepted;
  - a wrong target type accepted (still refused, but as `invalid_patch`, so the
    typed code caught it);
  - the base mutated in place;
  - the result losing its exact base provenance;
  - a CSS string accepted as a colour token.
- **Authority:**
  - the model losing its exact site-plan ref;
  - the build resolving the model by latest;
  - validation ignoring the pinned model, so Terra could replace IDs;
  - refinement not pinning the model;
  - a console editor page introduced;
  - the handler gaining `browser_preview`.
- **Gate:**
  - page markers not required;
  - section markers not required;
  - duplicates ignored;
  - foreign-page IDs ignored.
  
  A missing section marker and a duplicated section are also caught by the gate's
  independent order and containment checks, so for those two the pipeline test
  still refused the candidate and the unit gate tests are what killed them.

**Not in this slice:** customer editor or UI, chat or click editing, applying
patches to source, asset upload, rich text, and a Playwright-DOM marker check.

## Customer authentication and project tenancy — **DONE**

**Why.** The customer-editor gate stopped. The repository had one operator HTTP
Basic login, no customer identity, no accounts, no project ownership, and APIs
that trusted a `projectId` from the request. This slice is the security
foundation: server-owned proof that authenticated customer P may view, or
separately edit, project X. It builds no editor.

**Gate findings.**

- **Apps:** `apps/console` is the only app. Its operator middleware matches the
  whole app except the `_next` build output, so adding customer routes there would
  mean carving holes in operator protection.
- **Auth libraries:** no auth library, IdP or customer configuration existed. The
  registry is reachable, so OpenID Certified `openid-client` 6.8.8 (with `jose`
  and `oauth4webapi`) is used. It is standards-based and provider-configurable,
  so no vendor decision was needed.
- **Tenancy storage:** discovery deletes and recreates `ProjectDocument` on every
  fresh run, so a tenancy field stored on it would vanish.

**Boundary.**

- **Package:** `packages/customer-auth` holds the framework-agnostic
  `Request → Response` authority.
- **App:** `apps/customer` is a separate Next app on its own origin and port 3200.
  It exposes only `GET /api/auth/login`, `GET /api/auth/callback`,
  `POST /api/auth/logout` and `GET /api/auth/me`. It has no pages, no middleware
  and no operator code.
- **Operator side:** operator middleware and routes are unchanged.

**Protocol and configuration.**

- **Flow:** OpenID Connect Authorization Code with PKCE S256, plus `state` and
  `nonce`. Discovery, the code exchange and ID token validation (issuer,
  audience, expiry, nonce, state) are the library's.
- **Signatures:** `enableNonRepudiationChecks` also verifies every ID token
  signature against the provider JWKS.
- **Environment variables (server-only):** `CUSTOMER_OIDC_ISSUER`,
  `CUSTOMER_OIDC_CLIENT_ID`, `CUSTOMER_OIDC_CLIENT_SECRET` (optional: public
  client plus PKCE), `CUSTOMER_APP_ORIGIN` and `CUSTOMER_SESSION_TTL_SECONDS`.
- **Fail closed:**
  - https is required in production;
  - http is allowed only for a non-production localhost, and only there are
    cookies not Secure;
  - an unconfigured or undiscoverable provider makes every route return 503.
- **Checks in our code:** the callback URL is rebuilt from the configured origin,
  never the Host header. The ID token `iss` must equal the configured issuer, and
  `sub` must be non-empty.
- **Test-only setting:** `allowInsecureRequests` appears only in tests.

**Principal, identity and sessions.**

- **Boundary:** `requireCustomerPrincipal(request)` is the only way to resolve a
  customer. It reads only the customer session cookie, never `Authorization`, so
  Basic and bearer credentials are ignored.
- **Session check:** it resolves a `customer_sessions` row keyed by the token's
  sha256, which must be unexpired and unrevoked, then an active `customer_users`
  row.
- **Principal:** `{ customerUserId, externalIdentity: { issuer, subject }, authMethod: 'oidc_session' }`.
- **Users:**
  - `customer_users` has a unique index on `(issuer, subject)` and opaque
    `cu_` ids;
  - email and name are profile metadata only, and nothing looks a user up by
    them;
  - no provider token is stored.
- **Login attempts:** a login attempt (state, nonce, PKCE verifier, a validated
  same-site `returnTo`) is held server-side under a hashed, 10-minute cookie
  token, and consumed exactly once.
- **Cookies:** `__Host-` prefix, HttpOnly, SameSite=Lax, Path=/, host-only,
  Max-Age bounded to 12 h by default and at most 7 days, and Secure.
- **Revocation:**
  - logout (a same-origin POST) revokes the session server-side at once;
  - `revokeAllCustomerSessions` revokes everything a person holds;
  - TTL indexes clean expired rows, and expiry is always checked on read.
- **Same-origin rule:** `isSameOriginCustomerMutation` is the mutation rule every
  future customer mutation route must call. Together with SameSite=Lax it replaces
  any per-route token scheme.

**Tenancy.**

- **Accounts:** `customer_accounts` has opaque `acct_` ids, `status` and
  `displayName`.
- **Memberships:** `customer_memberships` holds `{accountId, customerUserId,
  role: owner|editor|viewer, status}`, uniquely indexed on
  `(accountId, customerUserId)`.
- **Project ownership:** `project_account_bindings` is keyed by project id and
  holds `{accountId, boundBy, boundAt}`. It is insert-only, is never transferred,
  and survives discovery resetting the project document.
- **Provisioning:** `createCustomerAccount`, `grantCustomerMembership`,
  `setCustomerAccountStatus`, `setCustomerMembershipStatus` and
  `bindProjectToCustomerAccount` are trusted server functions, not HTTP routes.
- **Invite-only:** signing in creates no account and no membership.

**Authorization.**

- **Checks:** `authorizeCustomerProjectView(store, principal, projectId)` and
  `authorizeCustomerProjectEdit(store, principal, projectId)`. They take no
  account, role or membership parameter.
- **Resolution, in order:**
  1. the user is active, and their issuer and subject match the principal;
  2. the project exists;
  3. its persisted binding exists;
  4. the account is active;
  5. that user's membership in that account is active;
  6. the role grants the permission.
- **Roles:** `CUSTOMER_ROLE_PERMISSIONS` gives owner and editor view and edit,
  and viewer view only.
- **Denial:** typed denials stay server-side.
  `customerProjectDenialResponse()` is one generic 404, so a project id reveals
  nothing.
- **Multiple accounts:** a person in several accounts gets authority only from
  the project's own account.

**Legacy.** Projects with no binding, meaning every historical and operator
project, remain fully usable by the operator and are inaccessible to customers.
There is no backfill and `ProjectDocument` is unchanged.

**Tests.**

- **`customer-auth.integration.test.ts` (24):**
  - the real OIDC login against a local provider that signs RS256 tokens and
    verifies PKCE;
  - rejection of a tampered state, a foreign nonce, a wrong issuer, a wrong
    audience, an expired token, a missing or empty subject, and a foreign
    signing key;
  - a wrong PKCE verifier, replay, a missing login cookie and a stale attempt;
  - no secret or token in any response, and safe `returnTo`;
  - identity uniqueness, email changes and same-email different subjects;
  - logout revocation, cross-origin logout, expiry, revoke-all, forged cookies
    and a disabled user;
  - Basic and bearer credentials produce no principal;
  - a safe `/me`.
- **`customer-tenancy.integration.test.ts` (17):**
  - the role matrix and no-membership case;
  - disabled and re-enabled memberships and accounts;
  - disabled users and identity mismatch;
  - cross-tenant view and edit, dual-account authority, and smuggled fields;
  - identical 404s;
  - legacy projects;
  - insert-only binding, survival of project resets, and durable membership
    uniqueness;
  - account validation.
- **`customer-auth.test.ts` (13):** fail-closed configuration, cookie policy
  and parsing, return paths, the same-origin rule, and the store never touched
  without a session cookie.
- **`apps/customer/test/customer-app.test.ts` (7):**
  - a customer cookie does not authenticate the operator, and operator Basic
    still works;
  - exactly four routes;
  - every route returns 503 unconfigured, even with operator Basic.
- **`customer-auth-boundary.test.ts` (13, structural):**
  - separation from operator auth;
  - our explicit issuer and subject checks pinned;
  - identity comes only from the cookie, and no route reads tenant ids;
  - library-only OIDC with PKCE, state, nonce and signature checks;
  - no insecure requests in production, and server-only secrets;
  - hashed sessions and cookie flags;
  - authorization resolves persisted tenancy only, bindings are insert-only, and
    indexes are unique;
  - no editor, patch endpoint or build import;
  - no new successor kind, and the tool gateway unchanged.
- **Build:** `next build` of `apps/customer` succeeds with no configuration,
  producing four dynamic routes.

**Mutations: 22 of 22 killed.** Each ran against the relevant unit, structural
or integration suites. Sources were restored byte-identical after each.

- **Separation:**
  - operator Basic accepted as a customer principal;
  - a customer session accepted as operator, at the console's auth function or
    at a route.
- **Identity checks:**
  - our explicit issuer check removed;
  - subject validation removed;
  - identity keyed by email;
  - external identity uniqueness removed.
- **Sessions and cookies:**
  - expired sessions accepted;
  - revoked sessions accepted;
  - HttpOnly dropped;
  - Secure disabled in production;
  - a session token exposed in `/me`.
- **Tenancy:**
  - the project's account replaced by a browser-claimed one;
  - a project with no binding allowed;
  - a missing membership allowed;
  - a viewer allowed to edit;
  - a disabled membership allowed;
  - a disabled account allowed;
  - cross-tenant view allowed;
  - cross-tenant edit allowed;
  - a duplicate membership accepted;
  - the edit check bypassed.

Two notes on how they were killed:

- **Issuer check removed:** `openid-client` independently rejects a wrong issuer,
  so the login test still refused the tampered token. The explicit check is
  pinned structurally, and that structural test killed the mutation.
- **Browser-claimed account:** the first run exposed a weak test that smuggled
  an account the attacker did not belong to. It now smuggles the attacker's own
  account and is killed behaviourally.

**Not in this slice:** the customer editor, project routes, invitations or signup
UX, organisation UI, IdP logout (RP-initiated), semantic-edit successor
provenance, and patch-to-build application.

## Semantic-edit build successor provenance — **DONE**

**Why.** A customer semantic edit will turn model M0 into M1, and M1 must become
a successor build B1. That successor is neither a replan nor a visual
refinement, so it needs its own typed reason before any edit lifecycle can exist.
This slice records lineage identity only.

**Gate findings.**

- **Union:** it was `replan | visual_refinement`.
- **Persistence:** replans persist as `replanDecision`, both legacy and new.
  Visual refinements persist as typed `successorProvenance`.
- **Reader:** `readBuildLineage` is the single reader. It parsed the typed field
  only as a visual refinement, so a third kind read as corrupt.
- **Other kind switches:** `sameProvenance` and the refinement-input consistency
  check. The refinement cycle counter and triggering-review lookup only look for
  `visual_refinement`.
- **Phase 5q:** it owned every well-formed tip.
- **Model provenance:** a semantic-patch model records its exact base ref,
  operation and target, and every model ref carries its content hash. But a
  future edit build may implement a patch chain M0→M1→M2, so the result's own
  provenance base is not necessarily the model the predecessor build carried.
  Proving that relation needs the artifact registry, which belongs to the
  lifecycle, not to lineage.
- **No-ops:** `commitSemanticPatch` always records a new version, so base and
  result can never be the same version.
- **Index:** the one-successor index is `{projectId, predecessorBindingId}`,
  which is reason-independent.

**Contract (`SemanticEditSuccessorProvenance`, strict).**

- **Fields:** `{ kind: 'semantic_edit', baseEditableSiteModel, editableSiteModel }`.
  Both are exact `editable-site-model` refs, and each requires a content hash.
- **Version check:** base and result versions must differ.
- **Why these fields:** this is the smallest shape that binds both models to
  builds without resolving artifacts. It is build identity, not a copy of the
  edit.
- **Kept out:** no patch copy, customer, session, source or time.

**Persistence.** A semantic edit persists in the typed `successorProvenance`
encoding, discriminated by `kind`. `readBuildLineage` parses that field as
`visual_refinement | semantic_edit` and nothing else. Replans keep their
historical encoding. There is no migration, and visual refinement persistence is
unchanged.

**Consistency.**

- **Equality:** `sameProvenance` compares both refs exactly: name, version and
  hash.
- **Preparation:** refused unless the base is exactly the model the predecessor
  build's spec pins, and this build's spec pins exactly the result.
- **Verification:** `verifyBindingConsistency` refuses a semantic-edit successor
  whose stored spec does not pin exactly its result model.
- **Presentation:** a semantic edit presented as an initial build is corrupt.

**Lineage.**

- **Root and slot:** the successor inherits the predecessor's root and takes no
  active-lineage slot.
- **One successor:** it shares the one successor slot, so a replan or refinement
  blocks an edit and the reverse.
- **Duplicate lookup:** it names the existing successor, whatever its reason.
- **Mixed chains:** these derive one tip.
- **Walk:** branch, cycle, foreign-root and unreachable rules are unchanged.

**Phase 5q.** A promoted semantic-edit tip is proven structurally, then refused
with `ActiveContinuationSuccessorNotOwned`. It is never reported as corrupt and
never continued as another kind. Replan and visual-refinement tips are still
owned.

**Scope.** Nothing in production creates a semantic-edit successor. There is no
semantic-edit JobOrigin, job spec, skill, editor route or patch-to-build path.

**Tests.**

- **`semantic-edit-successor-provenance.test.ts` (14):** the contract's valid
  shape and every rejection, including carried customer, session, patch or time
  data, unknown kinds, and cross-kind parsing.
- **`semantic-edit-successor-provenance.integration.test.ts` (24):**
  - preparation, root inheritance and reading back;
  - replay and consistency, including mismatched model refs, other kinds and
    presentation as an initial build;
  - the base and result bound to builds;
  - invalid reasons refused before anything is written;
  - legacy root, legacy replan and visual refinement unchanged;
  - six contradictory stored shapes;
  - the slot in all four directions, with the exact rival named;
  - a mixed replan → visual → edit → replan lineage;
  - walk rejections, and an index-level branch;
  - 5q refuses an edit tip as not owned while replan and refinement tips stay
    owned.
- **Structural updates** in the provenance, visual-refinement, editable-model and
  customer-auth boundary suites:
  - the three-kind union;
  - only the contract, the reader, recovery and the document type know
    `semantic_edit`;
  - no kind decided by elimination;
  - reason fields limited to the two models;
  - no edit JobOrigin, spec, skill or route;
  - build lineage free of customer identity, and customer auth independent of it.

**Mutations: 20 of 20 killed.** Each ran against the semantic-edit contract,
provenance-boundary and integration suites. Sources were restored byte-identical
after each.

- **Classification:**
  - a semantic edit read as a replan;
  - a semantic edit read as a visual refinement;
  - the lineage walk treating a semantic edit as corrupt.
- **Contract:**
  - the editable-site-model name check removed;
  - the base ref made optional;
  - a customer id added as required authority.
- **Consistency:** model mismatches ignored.
- **Stored shapes:**
  - a root carrying semantic-edit provenance;
  - a successor persisted without its predecessor;
  - legacy `replanDecision` beside a semantic edit.
- **Lineage and slot:**
  - a new lineage root started;
  - the index keyed by reason;
  - the index excluding typed reasons;
  - the walk ignoring semantic edits;
  - the duplicate lookup filtering out semantic edits.
- **Phase 5q:**
  - a semantic edit continued as a replan;
  - a refusal aimed at visual refinement instead.
- **Regressions:**
  - historical replan normalisation broken;
  - visual refinement parsing broken.
- **Scope:** production orchestration creating semantic edits.

**Known flake:** the pre-existing `acceptance vs abandonment race` test failed once
under full-suite load. It passed 5 of 5 in isolation and touches no lineage-kind
code.

## Canonical draft authority — **DONE**

**Why.** Applying a semantic edit stopped at its gate. `activeLineage` means an
unfinished run owns what happens next, and it is released only at `released`,
`blocked` or abandonment. So no durable state said "this exact promoted build is a
finished, unreleased draft". Release also trusted any build that had once been
promoted: a live run that evaluated B0 could publish B0 after canonical authority
moved to B1.

**Gate findings.**

- **Project states:** `intake`, `intake_insufficient`, `planning`, `building`,
  `validating`, `awaiting_human_review`, `releasing`, `released`, `blocked`,
  `rolled_back`. They are a TypeScript union with no runtime parser, and no
  exhaustive switch or map consumes them.
- **Where `activeLineage` is released:**
  - the release manifest transaction, which also sets `released`;
  - the two blocked terminals, which also set `blocked`;
  - abandonment, which is root-scoped.
  Every release shares its transaction with the terminal state write.
  `awaiting_human_review` keeps the slot.
- **Lineage walk:** `deriveActiveLineageTip` was a purely structural walk from
  whatever root it was handed. It never checked the slot and took no session.
- **Release:** `loadReleaseBuildAuthority` checked only that the build was
  promoted and carried a root. Nothing re-derived the tip, and the local-preview
  path did not even load build authority.
- **Phase 5q:** with no active root it returned `null`, and discovery then wiped
  the project.
- **Primitives:** a transaction helper with snapshot isolation, and partial unique
  project slots (`activeLineage`, the `active` publication).

**Record (`canonical_drafts`, `CanonicalDraftDocument`).**

- **Fields:** `{ _id, projectId, lineageRootBindingId, canonicalBindingId,
  promotionId, promotionCommitSha, status: 'available' | 'claimed', claim?,
  current?: true, createdAt, updatedAt }`.
- **Identity:** `_id` is `canonical-draft-<hash(projectId, root, binding, promotion)>`.
- **Uniqueness:** the partial unique index `projectId_1_currentDraft` on
  `{ current: true }` allows one current draft per project. Earlier drafts stay as
  history outside the slot.
- **Timestamps:** metadata only, never read to decide anything.

**Project state `draft`.** The run has concluded and no lineage or release owns
the project. Exactly one current draft names its tip.

**Conclusion (`concludeCanonicalDraft`).**

1. The promotion's marker commit is proven. This is immutable Git history.
2. In one transaction, these are proven:
   - the project, in `planning`, `building` or `validating`;
   - the binding;
   - the active root being the binding's root;
   - the structural active tip being the binding;
   - `promoted` status with the exact promotion id and commit;
   - the committed receipt;
   - no active publication for the project and no publication for the lineage;
   - no current or same-id draft.
3. In the same transaction:
   - the draft is inserted;
   - the project moves `state → draft`, guarded on its previous state;
   - `activeLineage` is `$unset` on the exact root, guarded and counted.
4. Exact replay returns the existing, re-proven draft. Anything else is refused
   with no write.

No production run calls conclusion yet. Its first caller is the semantic-edit
lifecycle.

**Proof of an existing draft (`loadCurrentCanonicalDraft`).**

- **State and record together:** `draft` state and a current record come as a
  pair. Either one alone, or two current records, is corrupt.
- **Every read re-proves:**
  - identity;
  - claim consistency;
  - no active lineage;
  - the stored root is its own root;
  - `deriveLineageTipFromRoot` reaches exactly the draft's build;
  - the build carries the draft's root, exact promotion and committed receipt;
  - no release owner.
- **Marker:** `assertCanonicalDraftPromotionMarker` proves the Git marker.

**Lineage.**

- **`deriveLineageTipFromRoot(store, root, { session })`** is the one structural
  walk. Branch, cycle, foreign-root and reachability rules are unchanged.
- **`deriveActiveLineageTip`** now also requires `root.activeLineage === true`,
  then delegates to it.

**Claiming (`claimCanonicalDraft`, `releaseCanonicalDraftClaim`).**

- **Claimant:** strictly `{ kind: 'semantic_edit' | 'release', operationId }`,
  where `operationId` is bounded to `[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}`. No extra
  field is allowed, so no session, token or customer identity.
- **Claim:** in one transaction the draft is re-proven, then checked:
  - `no_current_draft` when there is none;
  - `stale_draft` when the id differs;
  - `stale_tip` when the binding differs;
  - then a CAS `updateOne` on `{ _id, current, status: 'available', canonicalBindingId }`.
- **Outcomes:** a replay by the same claimant is idempotent. A different claimant
  gets `claimed_by_another`, however old the claim is.
- **Release:** only the holder can release, by CAS on `claim.kind` and
  `claim.operationId`. Releasing an available draft is a no-op.
- **No expiry:** there are no leases or timeouts.
- **Side effects:** a claim builds, publishes and reactivates nothing.

**Phase 5q and run start.**

- **Concluded draft:** with no active root, a valid draft and its marker throw
  `ActiveContinuationConcludedDraft`. It is concluded, not interrupted: nothing is
  evaluated, approved, released or discovered.
- **Corrupt state fails closed:**
  - malformed draft authority;
  - an active root beside a current draft;
  - an active root with project state `draft`.
- **Other refusals:**
  - `assertNoActiveLineageForLegacyDirect` refuses drafts too;
  - `prepareFrontendBackendBuildBinding` refuses a fresh root while a draft is
    current, with `FrontendBackendCanonicalDraftOwnsProject`.
- **Unchanged:** a project with neither owner, including `released` and `blocked`,
  still takes the fresh path.

**Release tip fence.** `publishRelease` calls `assertReleaseBuildIsCurrentTip`
when a job-lifecycle build is named. It runs first, before:

- the `releasing` state;
- the deployment-configured branch, so local preview is fenced too;
- any receipt, release commit or provider call;
- the manifest.

It requires the active root's structural tip to equal the build. A stale build,
or a draft with no active root, fails with `FrontendBackendReleaseBuildNotCurrent`.
A run owns its lineage exclusively, so nothing advances the tip between the proof
and publication. Releasing a draft will be an explicit claim.

**Compatibility.** No migration or backfill. Released, blocked and historical
projects get no draft records. The Phase 5p receipt and provider semantics are
unchanged.

**Scope.** No semantic-edit intent, `terra-edit`, JobOrigin, source snapshot or
customer route. Customer auth is untouched.

**Tests.**

- **`canonical-draft-authority.integration.test.ts` (67):**
  - conclusion, atomicity under an injected failure, and concurrent snapshot
    observers;
  - replay, mismatched replay, stale or non-promoted builds, promotion, receipt
    and marker proofs;
  - no lineage or a foreign lineage, refused states, and release owners;
  - the durable slot and concurrent conclusion;
  - thirteen corrupt-draft shapes;
  - inactive-root walks over mixed lineages, plus branch, cycle, foreign root and
    orphan;
  - claim CAS, replay, conflicts, age, concurrency, claimant secrets and release;
  - 5q concluded and corrupt drafts, the fresh path, fresh-root and legacy
    refusals;
  - real `runProject` in both modes;
  - release of the current tip, stale refusal before receipt, state or provider,
    local preview, and draft release refusal.
- **`canonical-draft-boundary.test.ts` (17):** structural. The provenance
  boundary suite was updated for the shared walk and the claim-category mention.

**Mutations: 28 of 28 killed.** Mutation 26 (5q allowing an active lineage beside
a draft) survived at first, masked by the `draft` state check. After a narrower
test assertion it was killed.

## Semantic patches applied through the build lifecycle — **DONE**

**Why.** A customer edit must turn draft D0 (build B0, model M0) into a new draft
through the same authority every build has. Terra proposes source; the harness
owns every decision.

**Gate findings.**

- **Claim state:** `claimCanonicalDraft` left the project `draft` with no active
  lineage. That is not enough to own a build.
- **Owners:** Phase 5q and run start treated any current draft beside an active
  lineage as corrupt.
- **Conclusion:** it refused whenever a current draft existed.
- **Chosen design:** reactivate the draft's own lineage root, never a new root.
  This keeps one lineage, the exact predecessor, the one successor slot, and
  `concludeCanonicalDraft`'s existing proof.
- **Prepared successors:** `runProject` cannot resume one, because
  `verifyBindingConsistency` is called without lineage. The edit's own exact
  replay can, through the same `prepareFrontendBackendBuildBinding` and lifecycle
  coordinator Phase 5k uses. No second recovery path.
- **Dead workers:** nothing in production calls `reclaimExpiredLeases`. A job
  whose worker died mid-attempt stays `in_progress` for an edit exactly as for a
  run's build.

**Draft handoff (`handOffCanonicalDraft`, in the caller's transaction).**

- **Writes:** a CAS claim by `{ kind: 'semantic_edit', operationId: intentId }`;
  then `activeLineage` on the draft's own root, only while no lineage holds it;
  then the project from `draft` to `building`. Each write is conditional and
  counted.
- **Handed-off state:** `resolveCanonicalDraftAuthority` reports it as
  `handed_off` and proves all of:
  - the draft is claimed by a building operation;
  - its own root is active;
  - the project is `building` or `validating`;
  - the draft build is still promoted by its promotion;
  - the tip is that build or its one successor;
  - no release owner exists.
- **Refusals:** anything else is corrupt. `releaseCanonicalDraftClaim` refuses a
  handed-off draft.

**Conclusion with supersession.** `concludeCanonicalDraft({ supersede, completeInTransaction })`:

- **Allowed only when:** the current draft is exactly the handed-off D0, claimed by
  exactly that claimant, on this lineage, with the new tip exactly one generation
  on.
- **One transaction:**
  - D0 loses `current` and gains `supersededByDraftId`, keeping its claim as history;
  - D1 is inserted current and available;
  - the project becomes `draft`;
  - the lineage is released;
  - the operation completes.
- **Replay:** re-proves supersession and calls completion idempotently.

**Intent (`semantic_edit_intents`).**

- **Identity:** `semantic-edit-<hash(project, draft, predecessor, base model, patch digest)>`.
- **Uniqueness:** unique on `{ projectId, sourceDraftId }`, so one edit per draft, ever.
- **Records:** the draft, root, predecessor, M0 and M1, the patch and its digest,
  the source commit and snapshot, the job spec and id, and the successor id.
- **Actor:** an optional `requestedBy.customerUserId`, for audit only.
- **Status:** `building → promoted → evaluated → completed`, each by CAS. A replay
  that lost a race continues from the durable record.

**Application (`applySemanticEdit`, `resumeSemanticEdit`).**

1. **Patch first.** The patch is proven against exactly M0 with the pure
   `applySemanticPatch`, which yields typed patch refusals.
2. **Replay check.** An existing intent is reused.
3. **Authority.** It proves:
   - the concluded available draft;
   - the expected draft and build;
   - the base model equal to B0's pinned ref.
4. **Source.** It proves:
   - the promotion marker;
   - no uncommitted non-harness work;
   - HEAD descends from the promotion;
   - source read with `readModelSourceAtCommit` under the refinement bounds, never truncated.
5. **One transaction:** handoff, M1, source snapshot, intent.
6. **Build.** Continuation prepares B1 as a `semantic_edit` successor (M0→M1),
   commits the specification, and runs the existing lifecycle coordinator with
   origin `{ kind: 'semantic_edit', intentId }`. It records promotion only after
   `promoted`.
7. **Evaluation.** B1 is evaluated afresh: gates, render, screenshots and review
   bound to B1. Evidence refs are recorded before conclusion.
8. **Conclusion.** It concludes D1 with supersession.

A stop before promotion leaves claim, lineage and job durable; replay resumes that
job. Nothing refines, adjudicates, approves, releases or deploys.

**Terra.**

- **Skill:** `terra-edit`, tier terra, through Terra's bounded build loop
  (filesystem and test_runner only, same turn, read and test bounds).
- **Handler:** `prepareSemanticEdit` resolves the exact snapshot (hash, digest,
  both models, patch) and proves M1 is the patch applied to M0.
- **Validation:** the plan-conformance gate and the site-model gate against the
  pinned M1 are unchanged.

**Phase 5q and run start.**

- **Phase 5q:** an active lineage beside a handed-off draft throws
  `ActiveContinuationSemanticEditOwned`, naming the intent. Its continuation is
  `resumeSemanticEdit`. A semantic-edit tip without a handoff is corrupt.
  `ActiveContinuationSuccessorNotOwned` is gone.
- **Run start:** `runProject` refuses any current draft, concluded or handed off,
  before resume, recovery or discovery.

**Scope.** No customer route, editor, preview, domain, lead or publish work.

**Tests.**

- **`semantic-edit-application.integration.test.ts` (22):**
  - the whole edit;
  - completed replay;
  - sequential M0→M1→M2;
  - stale draft, build and base, and five patch refusals;
  - active, parked, released, blocked, release-owned and claimed projects;
  - uncommitted work, divergent HEAD, oversize source, and a Luna repair as source;
  - concurrent edits;
  - four validation stops and a forbidden path;
  - a model failure resumed on the same job;
  - crash after promotion, recovered through 5q and `resumeSemanticEdit`;
  - crash before conclusion;
  - a missing intent.
- **`canonical-draft-authority.integration.test.ts`:** handoff and supersession cases.
- **`semantic-edit-identity.test.ts` (8):** unit tests of identity.
- **`semantic-edit-boundary.test.ts` (13):** structural.
- **`terra-edit.test.ts` (5):** the skill.
- **Structural pins updated** that asserted semantic editing did not exist yet.

**Mutations: 39 of 40 killed.**

- **Equivalent survivor:** "replay rebuilds after promotion" cannot re-run Terra,
  because the coordinator never re-executes an accepted, fenced job.
- **Tightened after a first survival:** four tests (7, 13, 18, 21).

## Draft-targeted run completion — **DONE**

**Why.** Semantic editing starts from an available canonical draft, but nothing in
production created the first one: a successful run always sought release. A run
can now target a draft instead.

**Gate findings.**

- **Run intent:** the run's immutable intent was
  `runIntentHash = hash(projectId, profile)`, stored on every binding. Recovery
  matched the incoming request against the root and tip, then always sought
  release. Completion behaviour was implicit.
- **Human review:** `awaiting_human_review` is produced only by release
  authorisation, meaning Sol's release recommendation or an autonomy mode that
  needs a person to release. That comes after adjudication, repair, replan and
  visual refinement have settled.
- **Deterministic readiness:** build, blocking defects and gates were checked
  inside `authorizeRelease`.
- **legacy_direct:** it holds no lineage authority.

**Contract.**

- **Type:** `RunCompletionTarget = 'release' | 'draft'`, strict.
- **Default:** `normalizeRunCompletionTarget` treats absence as `release` and
  refuses anything else.
- **Placement:** `RunOptions.completionTarget` is normalised before intake is
  validated.

**Durability.**

- **Run intent:** `computeRunIntentHash` adds `completionTarget: 'draft'` only for
  drafts, so every release-targeted and historical hash is byte-identical. Two
  otherwise identical runs with different targets are different intents.
- **Root binding:** the root records `completionTarget: 'draft'` at preparation,
  before any build work. Absence means release, with no migration. Successors
  record nothing and belong to their root's run.
- **Recovery:** `readRunCompletionTarget` reads the root. Phase 5q refuses a
  request whose target differs from the root's, and a draft-targeted lineage that
  has a release publication.

**Branch point.** Inside the evaluate loop, once nothing blocking remains and no
further visual refinement is authorised, immediately before Sol is asked to judge
release.

- **Readiness:** a draft run applies `releaseReadinessRefusal`, the same
  deterministic build, blocking-defect and gate rules release authorisation now
  shares.
- **Not ready:** it is blocked (`mark_blocked`, lineage released), exactly as a
  release refusal would be.
- **Ready:** it concludes the run's exact `canonicalBuild` and promotion through
  `concludeCanonicalDraft`. The build must pin an exact editable site model, or
  the run fails closed.

**Skipped in draft mode.** Only release-specific steps: Sol's release
recommendation, release authorisation, publication, provider deployment and the
manifest.

**Kept.** Planning, build, validation, promotion, evaluation, screenshots, visual
review, adjudication, repair, replan and bounded refinement.

**Human review.** Human review is release authority. A draft run never
authorises a release, so it never parks for one. Releasing a draft later must
pass release authorisation. A lineage already parked for review is still refused
by Phase 5q, and conclusion refuses that state.

**Result.** `outcome: 'draft'` with `completionTarget` and `draft`, which carries:

- `canonicalDraftId`
- `lineageRootBindingId`
- `canonicalBindingId`
- `promotionId`
- `promotionCommitSha`
- the exact `editableSiteModel`

`RunStatus` gains `draft`.

**Recovery and replay.**

- **Crash after final promotion:** recovery re-evaluates and concludes the exact
  tip, and never releases.
- **Asking the crashed project to release:** refused as a different intent.
- **After conclusion:** every run stops at the concluded draft
  (`ActiveContinuationConcludedDraft`). There is no second draft and no new root.
- **Malformed draft:** fails closed.

**legacy_direct.** A draft target is refused with `RunCompletionTargetUnsupported`
before anything is created.

**Console.** Unchanged; omitted means release.

**Tests.**

- **`draft-target-run.integration.test.ts` (14):**
  - the B0 draft;
  - generated D0 consumed by `applySemanticEdit` to produce D1;
  - refinement concluding B2, and replan concluding B1;
  - not-ready and review-unavailable runs blocked;
  - legacy refusal and unknown-target refusal;
  - omitted and explicit release unchanged, with the historical hash;
  - human review parking;
  - crash recovery, including the refused release switch;
  - a parked lineage;
  - a malformed draft;
  - a mismatched resume.
- **`draft-target-run.test.ts` (9):** contract, hash, reader, readiness, and
  structural pins.
- **Pin updated:** the canonical-draft boundary pin now allows exactly one draft
  conclusion in `runProject`.
- **Updated call sites:** direct `resolvePostPromotionRecovery` callers in tests
  pass `completionTarget`.

**Mutations: 19 of 19 killed.** Removing the run-start draft guard survived the
draft-run suites, because Phase 5q independently refuses a concluded draft. It is
killed by the guard's own semantic-edit and draft boundary suites.

## Immutable site export snapshots — **DONE**

**Why.** The operator preview serves `WORKSPACES_ROOT/<project>/app/out`, which
every canonical compile rewrites. A semantic edit's evaluation of B1 rewrites it
while D0 is still the current draft, so it cannot be revision authority. Evidence
kept only the export's digest and screenshots.

**Gate findings.**

- **Where the export is written:** `buildSite` writes the export into
  `siteRoot/out`. It clears the directory, then copies the export out of the
  sandbox. Only `evaluateSite` (and legacy paths) compile the canonical workspace;
  validation and `test_runner` compile disposable workspaces.
- **Concurrency:** writers are serialised only by project ownership (lineage and
  draft). A live run and a crashed one are indistinguishable, so correctness must
  not assume a single writer.
- **Digest:** the export digest was computed only in the browser renderer, as
  sha256 over `path \0 sha256 \n` in path order. It walked copies and silently
  skipped non-regular files.
- **Blob store:** keys are sha256, entries are immutable and deduplicated, reads
  are re-hashed, and each blob is at most 12 MiB. A deduplicated write with a
  different content type is refused as corrupt.

**One digest.** `exportDigestOf` (`workspace/src/export-digest.ts`, pure) is the
only implementation, with the same algorithm, so historical render digests keep
their meaning.

- **Compile:** `buildSite` now returns `exportDigest` of exactly the files it
  wrote into `out`.
- **Renderer:** the browser renderer uses the same function.

**Capture (`evaluateSite`).**

1. **Gates:** after the deterministic gates run against the compiled export.
2. **Read:** `captureSiteExportSnapshot` reads `out` once. Only regular files are
   accepted; symlinks, FIFOs and devices are refused. The read is bounded.
3. **Check:** it refuses unless the read digests to the compile's own digest
   (`export_changed`), so a directory another writer touched is never captured.
4. **Store:** it writes every file as a blob, then one strict manifest artifact.
5. **Render:** the render then runs on a private copy materialised from those
   captured bytes.
6. **Fence:** a render whose digest differs from the snapshot's throws
   `EvaluationSiteExportMismatch` before screenshots are persisted.

A refused capture leaves `siteExportSnapshot: null` with a reason. Release and
render behave as before; draft conclusion fails closed.

**Artifact (`site-export-snapshot`).**

- **Manifest:** `policyVersion`, `subject`, `exportDigest`, `files`, `totalFiles`
  and `totalBytes`.
- **Subject:** the render subject (project, exact site plan, source commit, build
  authority with binding and promotion) plus the exact `editableSiteModel`.
- **Files:** `{ path, blob, sha256, bytes }`, with paths canonical, relative,
  unique and ascending. No raw bytes.
- **Policy `statxai-site-export-snapshot@1`:** at most 4,096 files; each file at
  most 12 MiB (exactly the blob limit); at most 256 MiB in total.
- **Refusals (never truncation):** `too_many_files`, `file_too_large`,
  `snapshot_too_large`, `invalid_entry`, `empty_export`, `export_changed`.
- **Failure model:** blobs are written before the manifest, so a failure may leave
  deduplicated orphan blobs but never a manifest naming a missing blob. No
  garbage collection.
- **Content type:** every snapshot blob is stored as `application/octet-stream`.
  Media type comes from the trusted path when served.

**Reader.**

- **`readSiteExportSnapshot(registry, projectId, ref)`:** exact ref only, with a
  content hash required. It checks the stored document's hash, the schema and its
  invariants, the project, and re-derives the digest from the entries.
- **`readSiteExportFile`:** reads by exact manifest path through `BlobStore.get`,
  which re-hashes, and re-checks against the entry.
- **`resolveSiteExportRequest`:** decodes once and refuses traversal, encoded
  traversal, backslashes, absolute segments, malformed percent-encoding and NUL.
  It resolves `/` to `index.html`, a route to `route.html` or `route/index.html`,
  and assets exactly, against the manifest only. Unknown paths are `null`, with no
  filesystem fallback.

**Drafts.**

- **Record:** `CanonicalDraftDocument.siteExportSnapshot` holds the exact ref.
- **Conclusion:** `concludeCanonicalDraft` requires the caller's exact snapshot. It
  re-reads it and refuses a snapshot of another project, binding, promotion,
  promotion commit, site plan or editable model, a ref that does not prove
  itself, and a replay with a different snapshot.
- **Draft-targeted runs:** pass their final evaluation's snapshot.
- **Semantic edits:** record it on the intent's evaluation and conclude D1 from
  exactly that ref, including after a crash before conclusion. D0 keeps S0
  byte-for-byte while `out` holds B1.
- **Legacy drafts:** they have no snapshot, stay readable, and
  `requireCanonicalDraftExportSnapshot` refuses them. Nothing is backfilled and
  `out` is never a substitute.

**Unchanged.** Release and publication semantics, the operator preview, and the
provider. No customer preview route, editor or edit worker.

**Tests.**

- **`workspace/test/site-export.test.ts` (33):** contract, digest, tree reading
  (byte-exact, symlink, FIFO, bounds), request resolution, traversal and media
  types.
- **`workspace/test/site-export.integration.test.ts` (9):** capture and blobs,
  byte-exact reads, dedup and versioning, `export_changed`, immutability after
  `out` changes, exact-ref refusals, a forged manifest, a corrupt blob, and a real
  browser render digest equal to the snapshot's.
- **Integration additions:**
  - canonical draft: snapshot recorded, six wrong-subject refusals, a forged ref,
    a replay mismatch, a legacy draft;
  - draft run: D0 names S0 of B0, the render digest matches, nested routes resolve,
    and `export_changed` or render mismatch never drafts;
  - semantic edit: S0 immutable while `out` is B1, D1 names S1, and recovery
    reuses the recorded S1.
- **`site-export-boundary.test.ts` (8):** structural.
- **Pins updated** for the pure digest module and the render input.

**Mutations: 20 of 20 killed.** Two of them — draft conclusion and semantic-edit
recovery choosing the latest snapshot — are killed structurally, because in those
scenarios the latest snapshot is also the exact one.

## Durable semantic-edit worker — **DONE**

**Why.** `applySemanticEdit` authorised an edit and ran the whole build lifecycle
in one call. A request cannot wait for Terra, validation, promotion and
evaluation, and a process that dies mid-call must not strand the edit.

**Split.**

- **`submitSemanticEdit`:** the preparation transaction only — handoff, M1, the
  source snapshot and the intent with its job spec and successor binding id. It
  returns `building` and never calls Terra. Replay returns the same intent with no
  second M1 or source snapshot.
- **`applySemanticEdit`:** the same preparation followed by the one continuation.
  There is no second implementation of either half.
- **`resumeSemanticEditIntent(deps, { projectId, intentId }, execution)`:** the
  worker's entrypoint. It reads the intent by exact id; the continuation re-proves
  everything the intent names.

**Two kinds of ownership.**

- **Semantic authority:** the draft claim `{ kind: 'semantic_edit', operationId }`.
  It never expires, and nothing in the worker reads, releases or re-derives it.
- **Execution lease (`intent.execution`):** `token`, `owner`, `claimedAt`,
  `heartbeatAt`, `expiresAt`. Liveness only.
  - **Claim:** atomic, the oldest runnable intent, or one exact id.
  - **Runnable:** `building | promoted | evaluated`, no `disposition`, and no
    lease or an expired one. A live lease is never taken.
  - **Heartbeat, release, disposition:** each is a CAS on the exact token.
  - **Continuation fence:** every intent write (`advanceIntent`, the conclusion
    hook) also requires the token. A worker that lost its lease throws
    `SemanticEditExecutionLeaseLost` at its first write and changes nothing.

**Job leases.** `JobEngine.reclaimExpiredJobLease(jobId, actor)` reclaims one exact
job, only when `running` on an expired lease.

- **Result:** `ready` on the same id and attempt, or `failed` when that was the
  final attempt. Both are audited with `reason: 'lease_expired'`.
- **Stale tokens:** the dead attempt's heartbeat, submission and failure are
  rejected by the existing holder, attempt and expiry fences.
- **Worker use:** the worker reclaims only the intent's own `jobId`, and never
  calls the broad reaper.

**Worker (`SemanticEditWorker`, `scripts/semantic-edit-worker.ts`).**

- **Process:** a standalone Node process (`pnpm worker:semantic-edit`), not Next
  and not a request promise. It polls `semantic_edit_intents`; there is no second
  queue. It holds no customer identity and makes no latest lookups or release
  calls.
- **Limits:** `concurrency` 1 (1–16), `pollMs` 5000, `leaseMs` 120000,
  `heartbeatMs` 30000 (at most half the lease), `maxExecutionFailures` 3. Invalid
  configuration refuses to start.
- **Losing the lease:** a failed heartbeat aborts the execution between steps.
- **Shutdown:** SIGTERM/SIGINT stops claiming, aborts running work and waits at
  most the grace period. Draft claims are never released; unreleased leases
  expire.
- **Settling:**
  - completed → release the lease;
  - lifecycle `validation_failed` → disposition `validation_failed`;
  - `failed | blocked | superseded | repair_requested | draft` → `build_failed`;
  - evaluation unavailable → counted, then `evaluation_unavailable` at the bound;
  - an unexpected error → counted, then `execution_failed` at the bound;
  - corrupt authority → `authority_corrupt`;
  - otherwise → release the lease and retry later.
- **After a failure:** a dispositioned edit is never claimed again, and its draft
  stays claimed.
- **Logs:** one JSON line per event, with ids only and no tokens.

**Status (`readSemanticEditExecutionStatus`).**

- **Lookup:** exact project and intent.
- **States:** `queued | running | finishing | completed | failed`.
- **Public failures:** `validation_failed | build_failed | temporarily_unavailable
  | needs_attention`.
- **Never exposed:** tokens, job ids or provider text.

**Unchanged.** Customer routes and editor, release and publication, cron, and the
draft authority model.

**Tests.**

- **`semantic-edit-worker.integration.test.ts` (16):**
  - durable submission and replay;
  - a worker on a separate connection;
  - lease exclusivity and token fencing;
  - two workers executing once;
  - the concurrency cap;
  - dead-worker job reclaim on the same job (attempt 2);
  - a live job lease never stolen;
  - a mid-build lease loss that writes nothing;
  - validation, model and infrastructure bounds;
  - the crash matrix (before job claim, after acceptance, after evaluation,
    after completion);
  - polling and shutdown.
- **`semantic-edit-worker-process.integration.test.ts` (2):** the real process
  starts, connects, polls and exits 0 on SIGTERM; invalid configuration exits 1.
- **`reclaim-job-lease.integration.test.ts` (5):** the engine reclaim and its
  stale-token fences.
- **`semantic-edit-worker.test.ts` (17):** limits plus structural boundaries.
- **Pin updated:** `semantic-edit-boundary.test.ts`, for the preparation split.

**Mutations: 25 of 25 killed** (the 24 targets, with the job-lease target split
into engine and worker).

- **Killed only structurally:**
  - the worker skipping its own job-lease expiry check (the engine still refuses);
  - latest model or snapshot lookups;
  - release or customer-auth imports;
  - fire-and-forget continuation after submit.
- **Stale-token test tightened:** it now asserts the refused call left the intent
  un-promoted and un-evaluated.

## Customer editor foundation — **DONE**

**Why.** Customers could sign in, and drafts could be edited semantically by a
durable worker, but no customer could see or change their site.

**Surface (`apps/customer`, logic in `@statxai/customer-editor`).**

- **Pages:** `/projects` (the projects of the customer's active memberships) and
  `/projects/[projectId]/editor`. Both are server components that resolve the
  customer through `requireCustomerPrincipal` and redirect to login otherwise.
- **Routes:** thin wrappers over framework-agnostic handlers:
  - `GET /api/projects`
  - `GET /api/projects/:projectId/editor`
  - `GET /api/projects/:projectId/preview/:draftId/[...route]?channel=…`
  - `POST /api/projects/:projectId/edits`
  - `GET /api/projects/:projectId/edits/:intentId`
- **Client boundary:** the editor UI and the error boundary are the only client
  components. They import `@statxai/customer-editor/client` and the new
  browser-safe `@statxai/contracts/editable-site-model` subpath — never a store,
  customer auth or the orchestrator.
- **Worker dependency:** customer edits are continued only by the standalone
  `pnpm worker:semantic-edit` process. Run it beside the customer app; the app
  never starts it.

**Project discovery.** Active memberships by `customerUserId` → active accounts →
`project_account_bindings` by `accountId` (both indexed, bounded to 200). Each
project is authorised again through `authorizeCustomerProjectView`. The list
shows project id, account name, role and draft state only.

**Editor state (`loadCustomerEditorState`, the one loader).**

1. Authorise view (every denial is the generic 404).
2. `resolveCanonicalDraftAuthority`: a concluded or a handed-off draft.
3. The draft's exact build, the exact editable-site-model ref its job spec pins
   (resolved by hash), and the draft's exact `siteExportSnapshot` — proven to be
   of exactly that build, promotion, promotion commit and model.
4. While a semantic edit holds the draft: its customer-safe status.

- **Two outputs:** a bounded DTO for the browser (exact model and snapshot refs,
  a model view without plan, provenance, identity ledger, plan keys or blob keys,
  preview routes, permissions, edit status), and a server-only authority the
  preview and edit routes act on. No build id, promotion, lineage, job or token
  reaches the browser.
- **While an edit runs:** D0, M0 and S0 stay the editor's authority; the edit's
  M1 is never shown. Editability is `edit_in_progress`, and submission is closed.
- **After a terminal failure:** D0 stays shown and claimed; editability is
  `edit_failed` with one safe reason. Nothing releases the claim.
- **Unprovable drafts:** a missing snapshot, a snapshot of another build, a
  missing model pin — reported as `draft_unavailable`, never with the cause.

**Preview transport.**

- **Gate finding (real Chrome):** a frame sandboxed `allow-scripts` without
  `allow-same-origin` has an opaque origin. Its document request carries the
  `SameSite=Lax` session, but its subresource requests are cross-site and carry
  none.
- **Design:** so each preview is one self-contained document of the exact current
  draft's snapshot. No capability token exists.
  - HTML is parsed with parse5; CSS with postcss and postcss-value-parser.
  - Linked stylesheets (and `@import`) become `<style>`; fonts and images the
    HTML, `srcset`, `style` attributes or CSS reference become `data:` URIs, read
    through `readSiteExportFile` by exact manifest path.
  - `/_next/static/...`, relative and `../` URLs resolve only inside the manifest.
    Anything unresolved, external or of another type is dropped; nothing ever
    points at the customer app's origin.
  - Removed: every script, `on*` attribute, `javascript:` and all other link
    targets (links become `#`), meta refresh, `<base>`, frames, objects, form
    actions, preloads, comments. CSS that could close its `<style>` is dropped.
  - Bound: 24 MiB of inlined bytes per document — refused with 413, never
    truncated.
  - Exactly one script is injected: the selection bridge, with a per-response
    nonce.
- **Response policy:** `default-src 'none'; script-src 'nonce-…'; style-src
  'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; …;
  form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`, plus
  `no-store`, `nosniff` and `no-referrer`. Even a direct top-level visit is
  sandboxed with an opaque origin and no network.
- **Authority:** only the current draft id previews; a superseded draft id is not
  found. No workspace, `app/out` or file is ever read.

**Selection.**

- **Bridge:** outlines the marked object under the pointer, stops site clicks,
  submits, auxclicks and drags, and posts the nearest `data-statx-*-id` of each
  kind around a click. It holds no credential and makes no request.
- **Editor acceptance:** a message counts only when `event.source` is exactly the
  preview frame's window, its random channel matches, and it parses strictly.
- **Resolution:** precedence `field > asset > block > section > page`; the chosen
  ID must parse as its kind and exist on the previewed page of the exact model.
  An unresolvable marker selects nothing — no lower marker is substituted.
- **Keyboard path:** a page outline outside the frame selects the same objects.

**Supported edits** — every control builds the existing `SemanticPatch` through
the contract's own schemas:

- **Fields:** text, CTA (label and contract link), phone, email and address, on
  pages, section headings and blocks (`set_field_value` with the value seen).
- **Sections:** show or hide, bounded layout, move up and down (IDs unchanged).
- **Blocks:** show or hide, edit fields, remove, and add any supported kind whose
  fields are editable here (harness-minted IDs).
- **Deferred:** asset slots are shown read-only (no safe chooser exists); design
  tokens; drag and drop; image blocks.

**Submission (`POST …/edits`).** Principal → same-origin → edit authorisation
(viewer: 403; outsider: 404) → the one loader → strict body `{ expectedDraftId,
baseModel, patch }` → exact concurrency against the loaded authority →
`submitSemanticEdit` only → `202 { intentId, state, baseDraftId, baseModel }`.

- **Conflicts:** a stale draft, stale model or stale expectation is
  `409 stale_revision`; a held draft is `409 edit_in_progress`. A patch is never
  rebased.
- **Malformed:** a malformed, over-claiming or invalid body or value is
  `400 invalid_edit`.
- **Never in the request:** no model, build, validation, promotion, evaluation or
  release, and no background execution.

**Status and UX.**

- **Status route:** view authorisation, then the intent of exactly this project,
  as five fields: `intentId`, `state`, `failure`, `baseDraftId`, `resultDraftId`.
- **Polling:** every 2 s while non-terminal, stopping on completion, failure or
  unmount.
- **Pending:** "Saving changes…", "Building new revision…", "Validating and
  finishing…" over the unchanged D0 preview, with the inspector disabled.
- **Completion:** a fresh editor state; the current draft (D1, or a newer one,
  which is said) is loaded, selection is kept only if it still resolves, the frame
  reloads from the new snapshot, and only then "Changes applied".
- **Wording:** "Draft · Ready to edit". No approval or publish wording, and no
  publish, chat, prompt, source or CSS editor.

**Tests.**

- **`customer-editor.test.ts` (29):** model view, selection and precedence,
  patch shapes and validators, messages and words, transport (scripts, handlers,
  links, markers, inlining, traversal, style escape, bounds).
- **`customer-editor-boundary.test.ts` (16):** structural authority, preview,
  selection, submission, UI and client-boundary pins.
- **`customer-editor.integration.test.ts` (25):** discovery, editor load and
  fail-closed cases, preview authority and paths, submission security and
  concurrency, in-progress, status, completion (D1/M1/S1), added and removed
  blocks, terminal failure, a same-project snapshot of another build, and operator
  Basic credentials on every route — with the real lifecycle and worker.
- **`editor-preview-browser.integration.test.ts` (14):** Chrome — opaque origin,
  no cookie, no subresource or API request, no generated script, handler,
  `javascript:` link, navigation or form escape, CSP on a top-level visit, design
  rendering from the snapshot, bridge source checks, marker chains, identity by
  marker.
- **`customer-editor-e2e.integration.test.ts` (2):** the real customer app
  (`next dev`) in Chrome with a signed-in customer: list → editor → route switch →
  click heading → save (202) → queued and running over D0 → worker completes →
  D1 and S1 with the new heading; a viewer is read-only and refused.
- **Pins updated** for the new customer surface: customer auth, canonical draft,
  semantic-edit, successor provenance, site export, editable site model, draft
  target run, browser renderer (the customer editor's dev dependency on
  `playwright-core` for isolation tests) and the worker.

**Mutations: 30 of 30 killed.** Some are killed only by structural pins, because
another layer also enforces the rule:

- **Bridge source check (`event.source`):** the browser suite's parent page
  reimplements the check instead of loading the editor.
- **A stale model against the request:** submission re-proves the base model.
- **Fire-and-forget resume, promotion or release imports** after submit.
- **A chat or prompt control.**

One mutation first survived because it was too weak: provider error text read
from the wrong job. Pointed at the edit's failed job, it is killed.

## Customer self-service project creation — **DONE**

**Why.** A customer could sign in and edit an existing draft, but every project
still had to be created by an operator. A brand-new customer could not sign in,
describe a business, and land in the editor with a real D0 on their own.

**Authority.** The customer never mints a project id, a job id, a lease token or
a draft id — every one is server- or harness-minted. `POST /api/projects`
resolves and re-authorises which account the request is for
(`authorizeCustomerAccountCreate`, centralised in `@statxai/customer-auth`
alongside the existing view/edit checks — owner and editor may create, viewer
never can), validates the intake against the existing `BusinessProfile`
contract (`validateIntake`, reused from `@statxai/orchestrator`, never a
parallel schema), and hands off durably. Nothing plans, builds or evaluates
inside the request.

**Durable creation (`createInitialDraftRequest`, `@statxai/orchestrator`).** One
new collection, `initial_draft_requests`. `_id` is deterministic — a content
hash of the account, the customer user and the exact intake — so a
double-submitted or retried identical request always resolves to the same
request and the same project; a *different* intake is simply a different,
independent request, never a conflict. Creation also inserts the project's
`project_account_binding` and a minimal placeholder `projects` document (so the
customer's own tenancy check succeeds immediately, before any worker has
touched the project) — `discoverProject` deletes and recreates that placeholder
exactly as it already does for an operator-launched run, and tenancy is
untouched by that because it lives in the binding, not the project document
(the same property the existing tenancy suite already pinned for operator
runs). A small, explicit, best-effort bound
(`MAX_ACTIVE_INITIAL_DRAFTS_PER_ACCOUNT = 2`) limits concurrent generations per
account — not billing infrastructure, and not itself transactional with
insertion, on purpose (see the module doc).

**Execution (`resumeInitialDraftGeneration`, `InitialDraftWorker`, standalone
`pnpm worker:initial-draft`).** A worker leases one runnable request
(`initial_draft_requests`, CAS-fenced on an opaque token, liveness only —
exactly the semantic-edit worker's shape, deliberately a *separate* process and
collection rather than folding a second kind of work into that one) and:

1. Checks whether the project's canonical draft is already concluded — the
   crash window between `runProject` concluding and this module recording it.
   If so, records completion without calling `runProject` again.
2. Reclaims a `frontend_backend` build job left `running` by a worker that
   crashed mid-build, and only once its lease has truly expired.
   `reclaimExpiredJobLease` existed only for the semantic-edit worker's own
   jobs before this; nothing else in the codebase reclaimed this build
   boundary's stuck leases, so without this step a crash here would resume
   forever without making progress.
3. Calls `runProject` directly with `completionTarget: 'draft'` and
   `frontendBackendExecutionMode: 'job_lifecycle'` — the same entrypoint and
   the same `runIntentHash`-keyed idempotent resume machinery
   (`findActivePreparedBinding`, Phase 5q's `resolvePostPromotionRecovery`,
   `assertNoCanonicalDraftOwnsRun`) an operator run already has. Nothing new was
   built to make this resumable; the worker's own addition is only steps 1–2
   above, the gap that machinery does not already cover.

Never `launchRun`'s fire-and-forget pattern (`apps/console/app/api/runs/route.ts`
explicitly does not await its run): the customer route only ever writes the
durable request and returns 202; the process that drives `runProject` is always
the separate worker, never the Next.js request.

**Customer-safe progress and failure.** `runProject`'s own progress events are
mapped to a bounded, non-authoritative `progress` field
(`queued|planning|building|validating|finishing`) on the request, fenced on the
execution token. Failure collapses to four safe categories
(`invalid_request|generation_failed|temporarily_unavailable|needs_attention`)
— never a provider message, job id or lease token.

**Status route and completion proof (`GET …/generation`).** Never reports
`completed` on the stored request's word alone: it re-proves the exact
canonical draft through `loadCustomerEditorState` — the same one editor-state
authority the editor itself uses — and only reports `completed` once that
project's editor state genuinely has a draft, and it is exactly the draft this
request produced. A stored `completed` status whose draft cannot (yet, or ever)
be proven reads as `finishing`, not a premature signal to redirect.

**Customer surface (`apps/customer`).**

- `/projects/new`: a single-flow form (business name and industry first, then
  location, audience, services, differentiators, tone, goals, contact) using
  only the existing intake fields, with bounded client-side validation mirroring
  `intakeGaps` and double-submit prevention.
- `/projects/[projectId]/generating`: a progress page that polls the status
  route every 2.5 s, stops on a terminal state or unmount, resolves purely from
  durable server state (never in-memory), and redirects into the *existing*
  `/projects/[projectId]/editor` only once the server itself reports proven
  completion. The editor is not forked.
- `/projects`: a "+ Create website" action for authorised users, a "Generating…"
  badge for in-flight projects (never a broken editor link), a product empty
  state for zero-project customers, and a customer-facing display name derived
  from the intake's business name (falling back to the project id for legacy,
  operator-created projects, exactly as it showed before this capability).

**Tests.**

- **`initial-draft-worker.test.ts` (19, unit):** worker configuration bounds;
  creation is distinct from execution (no plan/build/evaluate in
  `createInitialDraftRequest`, exactly one `runProject` call site, no
  launch-and-forget); standalone entrypoint and script; discovery only through
  `initial_draft_requests`, no external queue; the exact job-lease reclaim
  pattern, bounded to the request's own job and only once truly expired; the
  already-concluded fast path checked before any resume; lease fencing; no
  customer identity or release authority reachable; bounded concurrency and
  graceful shutdown; `completionTarget` is always the literal `'draft'`;
  process separation from the semantic-edit worker.
- **`initial-draft-generation.integration.test.ts` (11):** durable idempotent
  creation (exact replay, distinct intake, distinct account, the concurrency
  bound and its replay exemption); the execution lease's claim, heartbeat,
  release, complete and disposition lifecycle, fenced on its token; an expired
  lease reclaimable by another worker.
- **`customer-tenancy.integration.test.ts` (+7, 24 total):** the account-create
  role model (owner/editor yes, viewer never), every denial (no membership,
  disabled membership, disabled account, disabled user, unknown account),
  cross-tenant refusal, and the eligible-accounts list excluding viewer-only and
  disabled accounts.
- **`creation.integration.test.ts` (13):** unauthenticated and cross-origin
  refusal; viewer refused, owner/editor accepted with silent single-account
  default; a browser-claimed foreign account always re-authorised and refused;
  multiple eligible accounts require an explicit choice; malformed and thin
  intake refused before any durable write; an oversized body refused before
  parsing; idempotent double-submission; the accounts picker; the
  generation-status route's exact-draft proof (including the mismatched/missing
  draft case reading as `finishing`, and a real, fully concluded draft reading as
  `completed`); the standalone worker's crash-recovery fast path against a real
  draft, with no re-run of generation; the projects list surfacing a generating
  badge.
- **Pins updated** for the new customer routes and pages: customer auth,
  customer editor, canonical draft, build-successor provenance, draft-target
  run, semantic-edit, site export, and the semantic-edit worker's own
  exact-route-list assertions.

**Mutations: 8 of 8 attempted killed live**, each verified by immediate,
byte-identical restore: viewer granted create permission; the intake digest
excluded from the idempotency key; `completionTarget` set to `'release'`; the
job-lease reclaim's expiry check removed; the generation-status route trusting
stored `completed` without re-proof; the account binding omitted from creation;
a generating project reporting no generation state on the projects list; the
request-body byte bound raised. A ninth (an account-membership check in
`authorizeCustomerAccountCreate` bypassed entirely) was refused by this
environment's own safety tooling before it could run — reverted immediately
without being exercised live; the property itself is still covered by that
function's own non-mutated `no_membership` denial test, which was passing
before and after.

**What was not built or verified here, honestly.** The 115-test, 30-mutation
inventory this capability's brief enumerated was not delivered at that literal
scale — the properties it named are covered, but by a smaller, focused suite
(above) rather than by every individually listed case. A full customer-driven
generation through a real `runProject` call (planning through a real or even
fully mocked Sol) was not exercised end-to-end: the shared integration rig
(`packages/customer-editor/test/support/rig-mocks.ts`) fakes the build,
evaluate and gates layer but has no Sol-planning fake, so a fresh request's
*first* pass through the worker into `runProject` is proven only structurally
(the one call site, the literal `'draft'` target) and by `runProject`'s own
substantial existing test suite for the `job_lifecycle` + draft path — not by a
new, real, worker-driven generation in this suite. The worker's *resume* path —
the harder, more novel half, and the one this capability actually adds new
logic for — is proven for real, against a real concluded draft. No manual
browser walkthrough was performed for this capability in this session; it would
need a running Mongo, both workers, and either real model credentials or a
rig-based workaround, given a pre-existing, unrelated bug in Sol's plan output
(`design.typography.scale` sometimes a full sentence rather than a bare ratio,
failing the strict `DesignTokens` schema) observed and reported during prior
manual verification in this project, and not fixed here — out of this
capability's scope.

## Phases 6–17

Not started.
