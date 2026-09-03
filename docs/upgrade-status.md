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

### Deliberately next, not now

- **Phase 5g** — validate, accept, and promote one `frontend_backend` job's
  output: consume the `executionOutputs` refs attached to a validating job,
  run the existing deterministic gates against the staged candidate, accept
  the job only when they pass, and materialise/promote the accepted
  candidate into the canonical workspace only after acceptance — still
  without Luna or broad replan semantics.
- **Later still** — mapping Luna repair work onto persisted jobs, what a
  replan does to jobs from the superseded plan (`superseded` does not exist
  yet), orphaned staging cleanup (deferred deliberately, not overlooked), and
  eventually a real process boundary (workers as separate processes, not
  in-process handlers).

None of these are implemented.

## Phases 6–17

Not started.
