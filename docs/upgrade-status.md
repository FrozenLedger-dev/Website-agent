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
| Typecheck, lint and unit tests | `pnpm test:unit` — 435 | nothing |
| Mongo integration tests | `pnpm test:integration` — 61 | the compose replica set |

Together they cover the whole inventory exactly once: 435 + 61 = 496, which is
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
- `runProject` still declares the run's mutable state as locals with a
  `snapshot()` view rather than owning a `RunProgress` object outright. That
  conversion touches ~180 references and is worth doing on its own.
- **`snapshot()` is shallow.** `openDefects`, `repairHistory`, `gatesCertified`
  and the telemetry objects are shared references, so the documented "a phase
  gets a copy" is a convention rather than something the type enforces. No
  extracted phase mutates them today. When 4b introduces a real `RunProgress`,
  make the phase inputs `readonly` or clone the mutable collections deliberately.
- **Artifact lineage is ordered by `createdAt` alone**, at millisecond
  resolution, relying on the awaits between writes to separate them. Stable in
  practice and not worth a schema change during an extraction — but if CI ever
  shows a sporadic lineage-order failure, that is the cause, and the fix is a
  monotonic sequence on the artifact rather than a looser assertion.

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

Two behaviours are pinned as they are, not endorsed:

- The exhaustion guard reads the **cumulative** `repairsApplied`, so a cycle
  that repairs nothing continues if an earlier cycle repaired something. Left
  exactly as it was; 4b is extraction, not policy cleanup.
- The cycle commit is attempted unconditionally, including when nothing was
  written. The workspace decides whether there is anything to record.

No new artifact, no `repair-decision`, no new project state. `adjudication-
decision` is still written before repair runs; the phase executes an already
persisted decision.

## Remaining Phase 4 work

- Global `RunProgress` ownership: the run still keeps mutable state as locals
  behind a shallow `snapshot()`. ~180 references; its own commit.
- Intake and project setup extraction (~45 lines).
- Artifact lineage ordered on millisecond `createdAt`.
- `REPAIR_COMPANIONS` → the later permission/tool-gateway phase.

## Phases 5–17

Not started.
