# Runtime responsibility map

Phase 0 audit. **No code was changed to produce this.**

The rule being audited against:

> Sol / Terra / Luna provide intelligence and structured decisions. The harness
> owns authority, state, permissions, budgets, execution, validation and release.

## Summary

The harness half of the architecture is largely real. Budgets commit
transactionally with the work they authorise, artifacts are versioned in
MongoDB, deterministic gates run before any model reviews anything, model
invocation goes through one client, and write scope is enforced in code rather
than asked for in a prompt.

The model half is not. **Sol is a planner and nothing else.** Every decision the
architecture assigns to Sol — which execution strategy to use, what to do about
a failed review, what a replan should change, whether to recommend release — is
currently taken by deterministic harness logic or, in one case, an environment
variable. One of those harness decisions is then recorded in the deployment
manifest as `approvedBy: "sol:machine-approval"`, which is not true: no Sol
model is consulted at that point in the run.

So the gap is not that the harness is too weak. It is that the harness is doing
the model's thinking for it, and the audit trail says otherwise.

## Responsibility table

| # | Decision / action | Where it lives now | Decided by now | Intended owner | Matches? | Change | Priority |
|---|---|---|---|---|---|---|---|
| 1 | One-shot vs decompose | `orchestrator.ts:223` | `process.env.BUILD_STRATEGY`, with `decompose` forced by throwing a fake truncation error | **SOL** decides, harness authorises | **No** | `sol-route`; env var demoted to explicit developer override | P0 |
| 2 | What to do about a failed review | `orchestrator.ts` repair loop | Harness: always Luna, one defect at a time | **SOL** adjudicates | **No** | `sol-adjudicate` with legal-action list | P0 |
| 3 | Terra specialist escalation | — | Does not exist | **SOL** chooses, TERRA executes | **No** | Adjudication action + `terra-refine` | P1 |
| 4 | Replan | `orchestrator.ts:480` | Harness calls `producePlan()` again with the **original profile** and no failure context | **SOL** replans knowing why | **No** | `sol-replan` taking failures, attempted repairs, unresolved defects | P0 |
| 5 | Terminal escalation | `decideTerminal()` + `legalTerminalOutcomes()` | Harness, deterministic | Harness **authorises**, SOL recommends | Partly | Keep as the authorisation half; add Sol's recommendation | P1 |
| 6 | Final approval | `orchestrator.ts:444` | Harness: `blocking(defects).length === 0` | SOL **recommends**, harness **authorises** | **No** | `sol-approve`; split the two concepts | P0 |
| 7 | Approval metadata | `orchestrator.ts:701` | Literal `approvedBy: 'sol:machine-approval'` | Both roles recorded separately | **No** — misleading | `recommendedBy` + `authorizedBy` | P1 |
| 8 | Release gating | `isReleaseBlocked()`, gates | Harness | Harness | **Yes** | — | — |
| 9 | Budgets | `packages/state/budgets.ts` | Harness, transactional, `$expr` guarded | Harness | **Yes** | — | — |
| 10 | Artifact persistence | `ArtifactRegistry` + Mongo | Harness, versioned | Harness | **Yes** | — | — |
| 11 | Model invocation | `ModelClient` + `providers/openai.ts` | One client, all vendor detail isolated | Harness | **Yes** | Add per-invocation audit records | P2 |
| 12 | Write permissions | `isModelWritable`, `assertModelWritable` | Harness, enforced in code | Harness, via a gateway | Partly | Generalise into a tool gateway | P1 |
| 13 | Tool access | — | No tools exist; models return whole files | Harness gateway | **No** | Phase 7 | P2 |
| 14 | Job scheduling | `packages/job-engine` | **Built, tested, zero consumers** | Harness | **No** | Phase 5 — 4 runs are currently stranded in `running` | P0 |
| 15 | Visual review | `terra-review.ts` | Terra reads exported HTML | Terra reads **rendered** pages | **No** | Phases 9–10 | P1 |
| 16 | Deployment | `deploy.ts`, called after approval | Harness | Harness | **Yes** | Record policy version + rollback | P2 |

## Answering Phase 0's three questions

For the four decisions that matter most:

**One-shot vs decompose** — currently an environment variable; should be Sol;
the harness has authority to execute either.

**Repair vs escalate vs replan** — currently a fixed harness path that always
picks Luna; should be Sol choosing from a harness-supplied list of legal
actions; the harness executes only what it authorises.

**Replan content** — currently a fresh plan from the original profile, which
cannot learn from the failure that triggered it; should be Sol given the
failures, the attempted repairs and the unresolved defects.

**Release** — currently one harness boolean labelled as a Sol approval; should
be a Sol recommendation and a separate, independent harness authorisation.

## What is deliberately not broken

Worth stating so the refactor does not "fix" them:

- Budget enforcement is transactional and guarded with `$expr`. The naive filter
  matches nothing in either direction and silently refuses every spend.
- Gates run before the reviewer, and a gate crash is reported as a blocking P0
  rather than taking the delivery down.
- Defect fingerprints reduce a location to the file it names first, so a
  reviewer's paraphrasing cannot mint a fresh budget.
- The stylesheet prelude is re-asserted before every build because the builder
  destroys it in roughly four deliveries in five.

## Priorities

1. **P0 — Sprint 1**: decision contracts, `sol-route`, `sol-adjudicate`,
   `sol-replan`, `sol-approve`, policy engine, recommendation/authorisation split.
2. **P0 — Sprint 2**: activate the job engine. Four runs are stranded in
   `running` right now, aged 30–53 hours, because nothing reclaims a dead worker.
3. **P1**: tool gateway generalising the existing write-scope guard; browser
   runtime; visual review.
4. **P2**: invocation audit records, asset pipeline, benchmark.
