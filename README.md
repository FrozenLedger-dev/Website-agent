# STATXAI — AI Business Website Generation Platform

Implementation of the approved architecture in `v1.2.pdf`: an autonomous website
delivery system built as a **deterministic project workflow powered by AI
workers**, not free-form agent-to-agent conversation.

Project state, artifacts, permissions, validation and autonomy policy live
outside the model and are owned by the platform.

## Quick start

```bash
pnpm install
pnpm db:up          # local Mongo, single-node replica set on :27018
pnpm db:check       # verifies connectivity AND transaction support
pnpm model:check    # verifies model access AND structured output
pnpm test

pnpm console        # control plane at http://localhost:3100
pnpm agent:run      # or run one project headless from examples/intake.json
```

`npm` is not available in this environment — use `pnpm` for everything.

## The console

`http://localhost:3100` is the control plane. It launches runs, follows them
live, and shows what the platform decided and why:

- **Launch** — paste a business profile, pick an autonomy mode, run.
- **Timeline** — every phase transition, persisted. A run takes minutes and
  survives the browser being closed; progress is read from the database, never
  from process stdout.
- **Budgets** — the six §7 counters with what remains of each.
- **Gates and review** — deterministic findings and reviewer findings side by
  side, each with the acceptance test that will prove the repair worked.
- **Artifacts** — every version, and which are accepted.
- **Preview** — the generated site, served from the project workspace.

## Running a delivery

```bash
# From the console (recommended) — survives the browser closing.
pnpm console

# Headless. A run takes minutes, so give it its own session: a backgrounded
# shell's process group can be reaped, and nohup only blocks SIGHUP, not a
# group-wide kill. A run killed that way leaves the project stranded in
# `building` with no error recorded, because the process never got to write one.
setsid nohup node --env-file=.env.local --import tsx scripts/run-agent.ts \
  < /dev/null > run.log 2>&1 &
```

`BUILD_STRATEGY` controls how Terra builds:

| Value | Behaviour |
|---|---|
| `auto` (default) | §3's one-shot first, decomposing only if the response truncates |
| `decompose` | Skip straight to anchor-then-parallel-pages |
| `one-shot` | Whole-site attempt only; a truncation fails the run |

The whole-site attempt is a single very long request and is the most fragile
call in the pipeline. `decompose` trades it for several short parallel ones.

## The delivery pipeline

```
intake ──validate──> Sol plan ──> Terra build ──> deterministic gates
                                                        │
                            ┌───────────────────────────┤ blocking?
                            ▼                           ▼ no
                     Luna repair  <──── Sol adjudicate ─── Terra review
                            │                           │
                            └──── budgets bound it ─────┴──> release
```

- **Sol** (orchestrator) plans, adjudicates, owns budgets and gives the final
  machine approval. It never edits a file.
- **Terra** (worker) builds the site, and separately reviews it. The reviewer is
  given only the specification and the artifact — never the builder's reasoning.
- **Luna** (repair) fixes one defect at a time, scoped to the files the defect
  lives in.

Tiers map to models through `MODEL_SOL` / `MODEL_TERRA` / `MODEL_LUNA`; all
default to `claude-opus-5`. §2's cost-control principle — smaller models for
bounded repairs — is a config change (`MODEL_LUNA=claude-haiku-4-5`), not a code
change.

## Data layer

MongoDB, single store, for both project state and artifact documents.

The deployment **must be a replica set or sharded cluster**. This is not a
preference: budget enforcement depends on multi-document transactions, which a
standalone `mongod` cannot run. `pnpm db:check` proves the capability rather
than assuming it, because the failure mode is otherwise silent.

The `docker-compose.yml` service runs `mongod` on port 27018 both inside and
outside the container, so the replica set's advertised member address is
simultaneously self-resolvable by the node and reachable from the host.

### The core invariant

Claiming a job, decrementing its budget, and transitioning its state commit
**or roll back together**. A crash between those writes must never leave a
budget spent on work that did not happen, nor work running against a budget that
was already exhausted.

```ts
await session.withTransaction(async () => {
  await jobs.updateOne({ _id, state: 'ready' }, { $set: { state: 'running' } }, { session });
  const r = await budgets.updateOne(
    { _id: projectId, $expr: { $lt: ['$repairsUsed', '$repairsMax'] } },
    { $inc: { repairsUsed: 1 } },
    { session },
  );
  if (r.matchedCount === 0) throw new BudgetExhausted();  // aborts; job returns to 'ready'
});
```

Note the `$expr`. Comparing two fields of the same document requires it. The
intuitive `{ repairsUsed: { $lt: '$repairsMax' } }` compares a number against the
literal string `"$repairsMax"`, and MongoDB does not compare across BSON types,
so the filter matches nothing — whether the budget is exhausted or not. Every
repair attempt would be refused as though the budget had started empty.

Verified rather than assumed; the behaviour is pinned by the guard tests in
`packages/state/test/budgets.test.ts`.

## Architecture decisions

Decisions taken where `v1.2.pdf` is silent, each marked in the code:

1. **Defect fingerprint** = `(category, location)`. Free text is deliberately
   excluded: a reviewer paraphrasing the same defect between cycles would
   otherwise mint a fresh fingerprint and silently reset the repair budget.
2. **Repair job granularity** = one job per defect fingerprint, so the 8-job
   release-cycle budget is a meaningful counter.
3. **Artifact source of truth** = MongoDB. The per-project Git repository holds
   generated website source plus a *materialisation* of the canonical artifacts,
   so Appendix A's on-disk layout is what a worker sees without becoming a
   second master copy.
4. **Luna repairs, Terra reviews.** §2 and §3 are ambiguous about which tier
   holds the review seat; a cheap model should not hold a judgment seat.
5. **`intake_insufficient` is a distinct terminal state.** Thin intake forces
   the builder to invent facts, which the content gate then rejects forever, so
   it is caught before any tokens are spent.

## What the build taught us

**The whole-site one-shot does not fit in one response.** A five-page site
exceeded a 64K output ceiling and truncated. §3's own answer applies — *one-shot
first, decompose only when needed* — so a truncated build is now treated as the
validation failure that triggers decomposition: Terra builds a design anchor
(stylesheet plus first page), then the remaining pages in parallel against it.
This is the "one-shot maximises blast radius" tension in the architecture review,
observed rather than predicted.

**Structured output rejects most JSON Schema constraints.** `minItems > 1`,
`minLength`, `maxLength`, numeric bounds and `multipleOf` are all rejected with a
400. Zod emits every one of them from ordinary `.min()` calls, so schemas are
sanitised on the way out (`toModelSchema`) while the full Zod schema still
validates the response. The model is constrained on shape; the platform enforces
everything else.

## Layout

```
packages/
  contracts/    canonical schemas — Zod source, JSON Schema derived
  state/        collections, indexes, transactions, budgets, run records
  job-engine/   state machine, atomic claim, retry, dependency graph
  workspace/    artifact registry + per-project Git workspace
  agents/       model adapter and the Sol/Terra/Luna skill contracts
  gates/        deterministic quality gates
  orchestrator/ the delivery loop
apps/
  console/      Next.js control plane
scripts/
  db-check.ts     connectivity + transaction capability probe
  model-check.ts  model access + structured output probe
  run-agent.ts    headless single-project run
  gate-check.ts   re-run the gate suite against an already-built project
  preview.ts      standalone static preview server
```

## Deterministic gates

Eleven gates run before any model reviews anything, because they are cheaper,
exhaustive, and never sycophantic:

`structure` · `headings` · `links` · `placeholders` · `secrets` ·
`accessibility` · `business-facts` · `spec-coverage` · `responsive` ·
`typography` · `forms`

Anything a gate can own should not be left to the reviewer. On a real run the
reviewer reported two unloaded webfonts; `pnpm gate:check` on the same site
found three. The reviewer is selective by nature, a gate is exhaustive by
construction.

Passing these gates means specific automated checks passed. It is not an
accessibility or compliance claim — automated tooling catches a minority of
WCAG issues.

## Repairs

A repair is scoped to the files the defect actually touches: the file named in
the finding's `location`, plus any other file its `reason` names. Scoping to
`location` alone once repaired one page of a three-page defect and released with
the claim still live on the other two.

Each file in scope gets its own repair call. One call returning several complete
pages exceeds the output ceiling and truncates, failing the repair wholesale;
per-file calls stay small and match §3's "smallest reasonable scope". The budget
is charged once per defect regardless of how many files it spans.

A failed repair is recorded and leaves the defect open rather than ending the
run — Sol then escalates through the normal budget path.
