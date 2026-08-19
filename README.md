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

`pnpm test` runs everything, including three suites that connect to the local
Mongo replica set to prove transaction semantics. `pnpm test:unit` runs only
what needs no infrastructure, which is what CI runs.

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
- **Usage and cost** — tokens in and out per tier, model time, and where the
  wall-clock actually went. Cost appears once rates are configured:

  ```bash
  PRICE_SOL_INPUT=…   PRICE_SOL_OUTPUT=…     # USD per 1M tokens
  PRICE_TERRA_INPUT=… PRICE_TERRA_OUTPUT=…
  PRICE_LUNA_INPUT=…  PRICE_LUNA_OUTPUT=…
  ```

  There are no default rates. Tiers map to models through configuration, so the
  platform cannot know what one costs, and a guessed rate would put a confident
  wrong number on an invoice-shaped screen. A tier with no rate is reported as
  `unpriced` rather than counted as free, so a partial configuration cannot
  quietly understate a total.

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

**Sol chooses how Terra builds.** After the plan is accepted it makes a routing
decision — one-shot or decompose — from the shape of that specific plan: routes,
sections across all of them, and how much copy each needs. The harness then
authorises it. A decomposition naming routes the sitemap does not contain, or
any strategy the plan cannot support, falls back to one-shot and records why;
routing is a preference between two working paths, so a refusal never fails a
delivery. The decision is stored as a versioned `route-decision` artifact
alongside Sol's own reason and confidence, including when it was refused.

`BUILD_STRATEGY` remains as an explicit developer override:

| Value | Behaviour |
|---|---|
| unset (default) | Sol decides |
| `one-shot` | Force the whole-site attempt; a truncation fails the run |
| `decompose` | Force anchor-then-parallel-pages |

An unrecognised value is ignored rather than guessed at, and an override that
disagrees with Sol is recorded on the artifact as an override rather than
silently standing in for the model's decision.

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

**Models provide intelligence; the harness provides authority.** Sol reasons and
recommends; it never edits a file, spends a budget, grants a permission or
releases anything.

- **Sol** (orchestrator) plans, chooses the execution strategy, and adjudicates
  failed evaluations. Each of those is a proposal the harness validates against
  a contract, checks for legality, records as an artifact, and only then
  executes.
- **Terra** (worker) builds the site, and separately reviews it. The reviewer is
  given only the specification and the artifact — never the builder's reasoning.
- **Luna** (repair) fixes one defect at a time, scoped to the files the defect
  lives in.

Tiers map to models through `MODEL_SOL` / `MODEL_TERRA` / `MODEL_LUNA`,
defaulting to `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna` respectively.
§2's cost-control principle — smaller models for bounded repairs — is a config
change (`MODEL_LUNA=gpt-5.4-mini`), not a code change.

Every vendor-specific constraint lives in `packages/agents/src/providers/` and
nowhere else: the strict schema dialect, the reasoning-effort ladder, the
64-character schema-name cap, and the request timeout. §1 requires the platform
not depend on a single vendor, so adding one means implementing one interface.

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

1. **Defect fingerprint** = `(category, first file named in location)`. Free
   text is deliberately excluded: a reviewer paraphrasing the same defect
   between cycles would otherwise mint a fresh fingerprint and silently reset
   the repair budget. `location` counts as free text — the reviewer writes
   `index.html#hero` one cycle and `index.html#hero, contact.html` the next for
   the same defect — so it is reduced to the file it names first.
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

**One fixture proves nothing.** Every run for weeks used the same intake — a
joinery company in Harrogate — and the pipeline looked finished: released,
deployed, scored 96. Running five other industries through it, one of the five
produced a correct site. Four defects surfaced immediately, none of them visible
on the tuned fixture:

- The builder replaced `app/globals.css` instead of appending to it, dropping
  `@import "tailwindcss"`, in **four of five** deliveries. The export still
  contained a stylesheet — a few kilobytes of custom properties and not one
  utility — so the markup's `lg:flex-row` resolved to nothing and the site
  rendered as unstyled text. Three were released at 98–99 and deployed to
  production. The prompt already said "append, never replace"; one of the
  destroyed files opened with a comment claiming it had appended. The head of
  that stylesheet is now platform-owned and re-asserted before every build,
  like `components/ui/**`.
- `business-facts` matched the business name against raw markup, so
  `Okonkwo &amp; Fry Solicitors` never matched `Okonkwo & Fry Solicitors`. Five
  P1s a cycle exhausted the repair budget, forced two re-plans, and blocked a
  site that named the firm in its header on every page. It rules out every
  business with an ampersand in its name.
- The reviewer was handed the framework's own 404 pages, which the gates had
  been taught to skip and it had not. It rejected three cycles running over
  Next's built-in error page while every gate was clean.
- No gate asked whether the delivered CSS defined the classes the pages use.
  `spec-coverage` asked only whether a stylesheet existed.

`examples/` now holds eight fixtures, each aimed at a different mechanism rather
than a different industry, and `examples/README.md` says what each is for.

**A gate that reads the wrong artifact is worse than no gate.** Moving the
generated stack to Next.js silently repointed several checks at things the model
does not write. One run produced 64 blocking findings on a site that was
essentially fine: 54 were the framework's own JavaScript chunks reported as
missing assets, 7 were React's inlined flight payload — full of `"$1"` markers —
read as unsupported prices, and 2 were Next's own 404 page failing a landmark
check. The budget was exhausted and the run re-planned. The remaining finding was
real: the layout had dropped `import './globals.css'`, so the export contained no
stylesheet at all. Every one of those five cases is now a test built from an
actual export rather than hand-written markup.

**Repairs were being handed the build output.** A gate cites `services.html`; the
file a repair must change is `app/services/page.tsx`. Worse, when the build
failed there was no export at all, so a P0 build defect resolved to zero files —
three repair cycles ran without the model ever being shown a line of code, and
the run blocked with the budget spent on nothing. Repairs now read source, and
exported paths are translated back through the sitemap.

**The unit of repair has to be the unit of budget.** Repairs were scoped per
finding while the budget was charged per fingerprint, and the two only diverge
when one category hits one file more than once — which typography does routinely.
Three "font specified but never loaded" findings all live at `app/globals.css`,
so they shared one fingerprint and a budget of two: the first consumed it and the
other two were skipped as exhausted on the cycle that raised them. Defects
sharing a fingerprint are now merged before anything acts on them, which is also
cheaper — one call fixing three declarations in one file beats three calls
rewriting it in sequence.

**A gate that throws must not end the delivery.** An unescaped font family from
Tailwind's preflight — `"Noto Color Emoji")`, with the closing paren of the
var() fallback list still attached — threw `Invalid regular expression` out of
`runGates`. It could only happen on a site that had *correctly* shipped a
stylesheet. Each gate is now isolated, and a crash is reported as a blocking P0
naming the gate: the check did not run, so the release cannot be certified, but
one broken gate does not destroy work already paid for.

**A gate that throws takes the delivery with it.** Tailwind's preflight names
`"Noto Color Emoji"` inside a `var()` fallback list; split on commas, the closing
paren rides along, and interpolating that into a `RegExp` throws `Unmatched ')'`
out of `runGates`. It could only happen on a site that had *correctly* shipped a
stylesheet. Family names are escaped now, and each gate runs isolated — a crash
becomes a blocking finding that names the gate, because a check that did not run
must not be mistaken for one that passed.

**The unit of repair has to be the unit of budget.** Repair budgets are charged
per defect fingerprint — `(category, location)` — but repairs were issued per
finding. Three "font specified but never loaded" findings all live at
`app/globals.css`, so they shared one fingerprint and one budget of two: the
first consumed it and the other two were skipped as exhausted on the very cycle
they were raised. Findings sharing a fingerprint are now merged into one defect,
which is also cheaper — one call fixing three declarations in one file beats
three calls rewriting the same file in sequence.

**Idiom mismatches cost a whole run.** The scaffold is the Base UI flavour of
shadcn, which spells "render my child element" as `render`; every published
shadcn example — and therefore everything a model has read — spells it `asChild`.
The result was a P0 no amount of repair budget could fix, discovered only after a
plan and a build had been paid for. `pnpm scaffold:check` now builds a probe page
using every primitive, so the mismatch surfaces in twelve seconds instead of a
run.

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
  scaffold-check.ts  build a probe page using every primitive the builder may use
  preview.ts      standalone static preview server
```

## Deterministic gates

§7's first gate is the build itself: `next build` must produce a static export,
and a project that does not compile never reaches a reviewer. Thirteen content
gates then run against that export — against the HTML a visitor actually
receives, not the TSX source, because a page can look right in source and export
as an empty shell:

`claims` · `stylesheet` · `structure` · `headings` · `links` · `placeholders` ·
`secrets` · `accessibility` · `business-facts` · `spec-coverage` ·
`responsive` · `typography` · `forms`

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

## The generated site

Terra writes a **Next.js App Router** project — TypeScript, Tailwind CSS v4 and
shadcn/ui — statically exported (`output: 'export'`), so every route prerenders
to HTML at build time.

The scaffold in `templates/site/` is platform-owned and ships with a lockfile.
Terra may write only `app/**` and `components/site/**`:

- `components/ui/**` is excluded because those are the shadcn primitives every
  page composes; a builder that "fixes" one breaks the whole site.
- `package.json` and the config files are excluded because installing
  model-authored dependencies would execute model-authored postinstall scripts.

`pnpm scaffold:check` builds a probe page that uses every primitive the builder
is told exists, written the way a model writes it. The scaffold is the Base UI
flavour of shadcn, but every published shadcn example uses Radix spellings — so
`Button` and `Badge` accept `asChild` as well as Base UI's `render`. A mismatch
there is invisible until a run has already paid for a plan and a build, and then
arrives as a P0 the repair budget grinds itself down against.

`pnpm install --frozen-lockfile` is the point of shipping the lockfile: the
dependency graph is the one that was proven to build. Without it, `^` ranges
resolve forward and a project fails on a transitive change that has nothing to
do with the site.

Builds run with `NODE_ENV=production` explicitly. Inheriting the platform's
`development` puts a development React inside a production prerender, which
fails with a null `useContext` in a page that names neither the cause nor the
file.

## Publishing

Set `VERCEL_TOKEN` (and `VERCEL_TEAM_ID` for a team account) to publish. Without
it a run still completes and releases to local preview — deployment is optional,
not a hard dependency.

Deployment happens **after** machine approval, and ships the export produced by
the build the gates and the reviewer both passed. Nothing is rebuilt at release
time, so what was approved is byte-for-byte what goes live (§9: "publish from a
machine-accepted source revision, not from mutable agent workspace state").

Two details that are not optional:

- `vercel.json` sets `cleanUrls`. The export writes `/services` to
  `services.html`; without it the host serves that path only at
  `/services.html`, so every link in the site 404s while the homepage looks fine.
- New projects are created with Vercel Authentication on, which serves a login
  page instead of the site. It is cleared after the first deployment creates the
  project — a published business website behind SSO is not published.

Each release records its URL, its deployment id, and the id of the deployment it
superseded in `deployment-manifest.json`. That last field is the rollback
target. A failed deployment spends the `failedDeployments` budget and is
retried; when the budget is gone the run reports the failure and the approved
site stays on local preview rather than claiming a release that did not happen.
