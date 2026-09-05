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

**Tests: 34 new (821 total, up from 787 at the close of the 5i review): 510
unit (+14 JobSpec factory), 311 integration (+20 build-boundary).**

- `job-specs-frontend-backend.test.ts` (14, unit, no Mongo): fixed
  `frontend_backend` conventions (role/objective/acceptanceCriteria/
  allowedTools/output); pinned input keys; output identity stable across
  different projects/refs; `jobId` prefix; deterministic identity
  (identical input → identical `JobSpec`/`jobId`, 5 repeated calls collapse
  to one id); `jobId` exactly `frontend-backend-` + `contentHash` of the
  identity; a changed `projectId`/`businessProfileRef`
  (name or version)/`sitePlanRef` (name or version) each changes `jobId`;
  swapping which ref is which changes `jobId`; the result carries no field
  beyond the fixed `JobSpec` surface.
- `frontend-backend-build-boundary.integration.test.ts` (20): legacy mode
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
  branch.
- `state-transitions.test.ts` / `replanning.test.ts` (pinned-shape updates,
  no new tests): `building` is now written from two mutually exclusive
  places (`orchestrator.ts`'s job-mode branch, `build.ts`'s legacy branch);
  the `producePlan` call-site literal updated for its new destructured
  return.

**Mutation testing — 10 mutations applied one at a time to the new
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

### Deliberately next, not now

- **Proposed, not implemented — pick one:** (A) durable run-level build
  binding/resume — record which Phase 5i `jobId` a run is waiting on, so a
  fresh `runProject` call can discover and resume it instead of only
  reusing it by coincidence of identical pinned inputs; or (B) activate
  `job_lifecycle` for one real production `runProject` caller in
  `run-service.ts`, keeping `legacy_direct` available as an explicit
  rollback. Not both at once — (A) is a durable-state/schema change to
  runs, (B) is a call-site/config change to who opts in; combining them
  would make either one hard to attribute if something regresses. Which is
  appropriate depends on inspecting `run-service.ts`'s current caller(s)
  first, not assumed here.
- **Later still** — mapping Luna repair work onto persisted jobs, what a
  replan does to jobs from the superseded plan (`superseded` does not exist
  yet), orphaned staging cleanup (deferred deliberately, not overlooked),
  and eventually a real process boundary (workers as separate processes,
  not in-process handlers).

None of these are implemented.

## Phases 6–17

Not started.
