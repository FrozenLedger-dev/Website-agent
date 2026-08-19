# Website Agent — Detailed Model + Harness Upgrade Checklist

## Target Architecture

The implementation should enforce this rule everywhere:

> **Sol / Terra / Luna provide intelligence and structured decisions. The proprietary harness owns authority, state, permissions, budgets, execution, validation, and release.**

This follows the approved architecture's principle that project state, artifacts, permissions, validation, and autonomy policies stay outside the models.

Final target:

```text
                    PROPRIETARY HARNESS
┌───────────────────────────────────────────────────────┐
│                                                       │
│ Project State                                         │
│ Artifact Registry                                     │
│ Job Engine                                            │
│ Context Builder                                       │
│ Model Runtime                                         │
│ Tool Gateway                                          │
│ Policy Engine                                         │
│ Budget Manager                                        │
│ Validation Engine                                     │
│ Browser / Render Runtime                              │
│ Deployment Controller                                 │
│ Observability                                         │
│                                                       │
│       ┌─────────┐   ┌─────────┐   ┌─────────┐         │
│       │   SOL   │   │  TERRA  │   │  LUNA   │         │
│       │  model  │   │  model  │   │  model  │         │
│       └─────────┘   └─────────┘   └─────────┘         │
│                                                       │
└───────────────────────────────────────────────────────┘
```

---

# PHASE 0 — Freeze and Document the Current MVP

## Goal

Before refactoring anything, create a known-good behavioral baseline.

- [ ] Create a new development branch such as `architecture/model-harness-v2`.
- [ ] Run the current MVP against at least 3 representative business profiles.
- [ ] Save the generated source, build output, validation report, review result, and final project state for each run.
- [ ] Record the current one-shot success rate.
- [ ] Record how many Terra calls happen per project.
- [ ] Record how many Luna calls happen per project.
- [ ] Record whether replanning occurred.
- [ ] Record total generation time.
- [ ] Record total model cost/tokens if available.
- [ ] Save screenshots of the current generated websites for later comparison.
- [ ] Create `docs/runtime-responsibility-map.md`.
- [ ] Document every important decision currently inside `orchestrator.ts`.
- [ ] Classify each decision as `HARNESS`, `SOL`, `TERRA`, or `LUNA`.
- [ ] Mark any current mismatch between implementation and the approved architecture.

The approved document assigns planning/routing/acceptance responsibilities to Sol, execution to Terra, and narrow repair to Luna.

### Definition of done

You can answer:

```text
Who currently makes this decision?
Who should make this decision?
Who has authority to execute it?
```

for every major workflow transition.

---

# PHASE 1 — Create Proper Decision Contracts

Do this before modifying orchestration.

The architecture already requires structured jobs and structured artifacts instead of free-form conversations.

## Add Sol decision contracts

- [ ] Add `SolRouteDecision`.
- [ ] Add `SolAdjudicationDecision`.
- [ ] Add `SolReplanRequest`.
- [ ] Add `SolReplanResult`.
- [ ] Add `SolApprovalRecommendation`.
- [ ] Validate all outputs using Zod or your existing contract system.
- [ ] Reject malformed model output before it reaches project state.
- [ ] Store every accepted decision as a versioned artifact.

Suggested contract:

```ts
type SolRouteDecision =
  | {
      action: "one_shot";
      reason: string;
      confidence: number;
    }
  | {
      action: "decompose";
      reason: string;
      confidence: number;
      workstreams: WorkstreamSpec[];
    };
```

Adjudication:

```ts
type SolAdjudicationDecision =
  | {
      action: "repair";
      defectIds: string[];
      worker: "luna";
      reason: string;
    }
  | {
      action: "terra_specialist";
      objective: string;
      reason: string;
    }
  | {
      action: "visual_refine";
      objective: string;
      reason: string;
    }
  | {
      action: "replan";
      scope: "page" | "design" | "site";
      reason: string;
    }
  | {
      action: "recommend_approval";
      reason: string;
    }
  | {
      action: "block";
      reason: string;
    };
```

### Critical rule

- [ ] **Do not allow Sol to modify budgets.**
- [ ] **Do not allow Sol to grant itself permissions.**
- [ ] **Do not allow Sol to deploy.**
- [ ] **Do not allow Sol to bypass deterministic gates.**
- [ ] **Do not put credentials or secrets in Sol inputs.**

Sol may choose an action.

The harness determines whether that action is legal.

---

# PHASE 2 — Implement the Missing Sol Model Skills

Your current Sol implementation is primarily planning. Expand it so the actual Sol model performs the semantic orchestration responsibilities described in the approved architecture.

Recommended structure:

```text
packages/agents/src/skills/

sol-plan.ts
sol-route.ts
sol-adjudicate.ts
sol-replan.ts
sol-approve.ts

terra-build.ts
terra-review.ts
terra-refine.ts

luna-repair.ts
```

## `sol-route.ts`

- [ ] Use the Sol model tier.
- [ ] Input the accepted `business-profile`.
- [ ] Input the accepted `SitePlan`.
- [ ] Input project complexity information.
- [ ] Input project execution policy.
- [ ] Ask Sol to choose `one_shot` or `decompose`.
- [ ] Require structured output.
- [ ] Require a short reason.
- [ ] Require confidence.
- [ ] Do not let environment variables silently substitute for Sol's decision except as explicit developer overrides.

Target:

```text
Sol Plan
   ↓
Sol Route
   ↓
Harness policy validation
   ↓
one-shot OR decomposition
```

This implements the document's requirement that Sol choose one-shot vs decomposition.

---

## `sol-adjudicate.ts`

This is one of the most important additions.

Input:

```text
accepted plan
current website revision
deterministic gate report
Terra review
open defects
previous repairs
failed repair attempts
remaining budgets
autonomy policy
available legal actions
```

- [ ] Let Sol reason about the failures.
- [ ] Let Sol choose repair vs Terra escalation vs replan vs approval recommendation.
- [ ] Send remaining budgets as information only.
- [ ] Send the list of currently legal actions.
- [ ] Validate the returned action.
- [ ] Do not execute anything until the harness authorizes it.

Flow:

```text
Validation results
       ↓
Terra Review
       ↓
Sol Adjudication
       ↓
Harness Policy Engine
       ↓
execute authorized action
```

---

## `sol-replan.ts`

Do **not** simply call `sol-plan.ts` again with the original business profile.

A real replan needs failure context.

Input:

```ts
{
  businessProfile,
  previousPlan,
  acceptedArtifacts,
  deterministicFailures,
  terraFindings,
  attemptedRepairs,
  unresolvedDefects,
  reasonForReplan,
  remainingBudgets
}
```

- [ ] Ask Sol to explain what was wrong with the previous strategy.
- [ ] Require Sol to identify what is changing.
- [ ] Require Sol to preserve accepted facts.
- [ ] Require Sol to avoid unnecessary modifications.
- [ ] Version the previous plan.
- [ ] Store the revised plan as a new artifact.
- [ ] Record why the plan changed.

The PDF explicitly allows escalation from narrow repair to specialist work and eventually specification/architecture revision.

---

## `sol-approve.ts`

Sol should produce an **approval recommendation**, not directly authorize deployment.

Input:

```text
accepted plan
final gate report
final Terra review
remaining non-blocking issues
release policy
autonomy mode
```

Output:

```ts
{
  recommendation:
    | "accept"
    | "reject"
    | "human_review";

  reason: string;

  acknowledgedIssues: string[];
}
```

Then:

```text
Sol recommendation
       ↓
Harness policy check
       ↓
Actual machine authorization
```

- [ ] Rename concepts so `Sol recommendation` and `Harness authorization` are separate.
- [ ] Never let a Sol model response directly call production deployment.

---

# PHASE 3 — Build an Explicit Harness Policy Engine

Move authorization rules out of scattered `if` statements.

Suggested module:

```text
packages/policy-engine/
```

or equivalent.

## Core functions

- [ ] Implement `getLegalActions(projectState)`.
- [ ] Implement `authorizeDecision(decision, projectState)`.
- [ ] Implement `canSpendBudget(type)`.
- [ ] Implement `consumeBudget(type)`.
- [ ] Implement `canUseTool(role, tool)`.
- [ ] Implement `canModifyPath(role, path)`.
- [ ] Implement `canRelease(projectState)`.
- [ ] Implement `requiresHumanApproval(action, policy)`.
- [ ] Implement `validateAutonomyPolicy()`.

Example:

```ts
const authorization =
  policyEngine.authorizeDecision(
    solDecision,
    projectState
  );

if (!authorization.allowed) {
  // Decision is not executed.
}
```

## Release policy

At minimum:

- [ ] No unresolved P0 issue.
- [ ] No unresolved P1 issue.
- [ ] Build succeeds.
- [ ] Required deterministic gates pass.
- [ ] Required browser tests pass.
- [ ] Required integration checks pass.
- [ ] Execution budget is valid.
- [ ] Autonomy mode permits automatic release.
- [ ] Sol acceptance recommendation exists.
- [ ] Harness independently authorizes release.

This preserves the bounded-approval architecture described in the document.

---

# PHASE 4 — Refactor `orchestrator.ts`

Do not allow `runProject()` to become the location where every system behavior lives.

Target:

```ts
async function runProject(projectId: string) {
  await jobEngine.run(projectId);
}
```

The orchestrator should coordinate.

It should not contain hundreds of lines of implementation-specific repair, approval, and routing logic.

## Convert the workflow into stages

```text
discover
   ↓
plan
   ↓
route
   ↓
build
   ↓
validate
   ↓
review
   ↓
adjudicate
   ↓
repair / replan / refine
   ↓
approve
   ↓
release
```

This matches the approved end-to-end lifecycle.

- [ ] Extract planning execution.
- [ ] Extract routing execution.
- [ ] Extract build execution.
- [ ] Extract validation execution.
- [ ] Extract review execution.
- [ ] Extract adjudication execution.
- [ ] Extract repair execution.
- [ ] Extract replan execution.
- [ ] Extract approval execution.
- [ ] Extract deployment execution.
- [ ] Keep `runProject()` as the outer lifecycle controller.

---

# PHASE 5 — Make the Job Engine the Real Runtime

Your architecture document specifies structured jobs, versioned artifacts, dependency-aware execution, and explicit states.

Use the existing `job-engine` package rather than allowing it to remain architectural scaffolding.

## Job schema

```ts
type Job = {
  id: string;
  projectId: string;

  kind:
    | "sol.plan"
    | "sol.route"
    | "sol.adjudicate"
    | "sol.replan"
    | "sol.approve"
    | "terra.build"
    | "terra.review"
    | "terra.refine"
    | "luna.repair"
    | "gate.build"
    | "gate.browser"
    | "deploy.preview"
    | "deploy.production";

  status: JobStatus;

  dependencies: string[];

  inputArtifacts: ArtifactRef[];

  allowedTools: ToolName[];

  attempt: number;
  maxAttempts: number;
};
```

Suggested lifecycle from the approved architecture:

```text
Draft
  ↓
Ready
  ↓
Running
  ↓
Validating
  ↓
Accepted
```

Failure paths:

```text
Failed
Repair Requested
Blocked
```



## Implementation tasks

- [ ] Persist every job.
- [ ] Persist job dependencies.
- [ ] Persist job attempts.
- [ ] Persist job output artifact references.
- [ ] Support idempotent job execution.
- [ ] Support retry.
- [ ] Support blocked dependencies.
- [ ] Support cancellation.
- [ ] Support terminal project state.
- [ ] Do not use conversational history as project state.
- [ ] Resume interrupted projects from persisted state.

---

# PHASE 6 — Centralize Model Invocation

Create one model runtime used by every skill.

Example:

```ts
invokeModel({
  tier: "sol",
  skill: "sol.adjudicate",
  projectId,
  jobId,
  inputArtifacts,
  schema,
  allowedTools,
  reasoningEffort
});
```

## Record every invocation

- [ ] Requested model tier.
- [ ] Actual model name.
- [ ] Skill name/version.
- [ ] Job ID.
- [ ] Project ID.
- [ ] Artifact references used as context.
- [ ] Tool permissions.
- [ ] Token usage.
- [ ] Execution duration.
- [ ] Model output artifact.
- [ ] Parse/validation failures.
- [ ] Retry number.

Do **not** scatter raw OpenAI API calls across the application.

---

# PHASE 7 — Build the Tool Gateway

The approved design already gives different roles different tool permissions and says tool calls should pass through a policy gateway.

Implement this as a first-class harness subsystem.

Start with:

```text
list_files
read_file
search_files
read_artifact
run_build
run_tests
start_preview
browser_open
take_screenshot
inspect_dom
inspect_accessibility_tree
```

Later add:

```text
write_file
patch_file
asset_search
asset_generate
git_diff
git_commit
deploy_preview
```

## Every tool call must include

```ts
{
  projectId,
  jobId,
  role,
  requestedTool,
  arguments
}
```

The gateway checks:

```text
Does this role have permission?
Is this project allowed?
Is the path allowed?
Does the operation require approval?
Is the tool budget exhausted?
```

### Filesystem safety

- [ ] Define role-specific writable paths.
- [ ] Prevent `../` traversal.
- [ ] Prevent writes outside project workspace.
- [ ] Prevent changes to harness source.
- [ ] Prevent changes to secrets.
- [ ] Audit every write.
- [ ] Store a before/after diff.

Your current Luna allow-list behavior is a good pattern to generalize.

---

# PHASE 8 — Introduce the Real Model ↔ Tool Loop

Do this after the tool gateway exists.

Current:

```text
Terra
 ↓
one giant response
 ↓
Harness writes files
```

Target:

```text
Terra
 ↓
read_file
 ↓
Harness
 ↓
observation
 ↓
Terra
 ↓
write_file
 ↓
Harness
 ↓
run_build
 ↓
build error
 ↓
Terra
 ↓
fix
```

## Safety limits

- [ ] Maximum tool steps per job.
- [ ] Maximum model calls per job.
- [ ] Maximum build executions.
- [ ] Maximum filesystem writes.
- [ ] Maximum browser interactions.
- [ ] Maximum token budget.
- [ ] Maximum elapsed runtime.

Never permit an uncontrolled infinite agent loop.

---

# PHASE 9 — Add Browser and Rendering Infrastructure

The architecture explicitly requires browser QA and browser-based autonomous validation.

Use Playwright or the equivalent browser runtime.

## For each important page, capture

- [ ] Desktop viewport.
- [ ] Tablet viewport.
- [ ] Mobile viewport.
- [ ] Full-page screenshot.
- [ ] Above-the-fold screenshot.
- [ ] DOM summary.
- [ ] Accessibility tree.
- [ ] Console errors.
- [ ] Failed network requests.
- [ ] Layout overflow information.

Recommended initial breakpoints:

```text
1440 × 1000
768 × 1024
390 × 844
```

Store:

```text
validation/
  renders/
    homepage/
      desktop-full.png
      desktop-fold.png
      tablet.png
      mobile.png

  render-report.json
```

---

# PHASE 10 — Make Terra Review Actually Visual

Current source-code-only review should become multimodal.

Terra reviewer input:

```text
Business Profile
+
Site Plan
+
Design Contract
+
Page Specification
+
Deterministic QA
+
Rendered Screenshots
+
DOM Summary
```

The PDF already requires independent subjective review rather than trusting the builder's claim of completion.

## Expand `visual-review.json`

```ts
{
  overall: 88,

  dimensions: {
    composition: 84,
    typography: 89,
    spacingRhythm: 90,
    hierarchy: 91,
    brandDistinctiveness: 78,
    imageQuality: 86,
    conversionClarity: 92,
    mobileQuality: 83
  },

  issues: [...]
}
```

- [ ] Review desktop and mobile separately.
- [ ] Identify page and section.
- [ ] Explain why the design is weak.
- [ ] Specify the desired visual result.
- [ ] Recommend `terra_refine` rather than Luna for subjective redesign.

---

# PHASE 11 — Create `terra-refine.ts`

Do not use Luna for significant design changes.

Luna is intentionally scoped to narrow, testable repairs in the approved design.

Create:

```text
terra-refine.ts
```

Input:

```text
current website
screenshots
visual review
design contract
page spec
specific visual defects
```

- [ ] Allow Terra to inspect the actual site.
- [ ] Ask Terra to fix only identified visual weaknesses.
- [ ] Preserve business facts.
- [ ] Preserve working integrations.
- [ ] Preserve accepted pages unless modification is necessary.
- [ ] Rebuild.
- [ ] Re-render.
- [ ] Re-review.

Use a separate visual iteration budget:

```text
visualRefinements = 2
```

---

# PHASE 12 — Upgrade the Design Artifacts

After the architecture is correct, improve actual site quality.

Add:

```text
design-contract.json
asset-plan.json
asset-manifest.json
```

Expand:

```text
brand-system.json
page-spec/*.json
```

## `design-contract.json`

Include:

- [ ] Creative direction.
- [ ] Brand personality.
- [ ] Typography hierarchy.
- [ ] Grid system.
- [ ] Content widths.
- [ ] Section spacing.
- [ ] Surface language.
- [ ] Border language.
- [ ] Radius system.
- [ ] Shadow system.
- [ ] Image treatment.
- [ ] Motion philosophy.
- [ ] CTA hierarchy.
- [ ] Design anti-patterns.

## Page composition

Each page section should specify:

```text
purpose
layout type
visual priority
background treatment
media placement
content density
CTA hierarchy
mobile composition
```

Do not merely specify:

```text
hero
services
testimonials
CTA
```

Specify the composition.

---

# PHASE 13 — Add an Asset Pipeline

- [ ] Accept client-provided assets.
- [ ] Normalize and resize client images.
- [ ] Maintain an asset manifest.
- [ ] Create image requirements before the build.
- [ ] Support approved generated imagery.
- [ ] Support approved external/stock assets if product policy allows.
- [ ] Keep downloaded/generated assets local to the project.
- [ ] Pass Terra stable `/public/...` paths.
- [ ] Record asset provenance.

Example:

```json
{
  "hero": {
    "path": "/media/hero.webp",
    "purpose": "establish trust",
    "placement": "right side of split hero",
    "aspectRatio": "4:5"
  }
}
```

---

# PHASE 14 — Fix Approval and Deployment Metadata

Remove misleading fields such as:

```text
approvedBy: "sol:machine-approval"
```

unless an actual Sol model decision exists.

Use:

```json
{
  "recommendedBy": {
    "role": "sol",
    "decisionArtifact": "artifact://..."
  },

  "authorizedBy": {
    "type": "harness-policy",
    "policyVersion": "v2"
  }
}
```

- [ ] Record the exact source revision.
- [ ] Record all gate results.
- [ ] Record Sol's recommendation.
- [ ] Record remaining known issues.
- [ ] Record autonomy mode.
- [ ] Record policy version.
- [ ] Record rollback revision.
- [ ] Record deployment result.

This keeps model judgment and harness authority auditable.

---

# PHASE 15 — Add Comprehensive Tests

## Unit tests

- [ ] Invalid Sol decision rejected.
- [ ] Unknown Sol action rejected.
- [ ] Sol cannot increase a budget.
- [ ] Sol cannot use unauthorized tools.
- [ ] Luna cannot modify files outside its repair scope.
- [ ] Terra cannot modify harness files.
- [ ] Failed deterministic gate blocks release.
- [ ] P0 blocks release.
- [ ] P1 blocks release.
- [ ] Budget exhaustion produces terminal behavior.
- [ ] Production deployment requires policy authorization.

## Integration tests

- [ ] Successful one-shot project.
- [ ] One-shot failure → Luna repair → success.
- [ ] One-shot failure → Terra specialist.
- [ ] One-shot failure → Sol replan.
- [ ] Visual failure → Terra refinement.
- [ ] Repeated repair failure → budget exhaustion.
- [ ] Build failure.
- [ ] Invalid model JSON.
- [ ] Model timeout.
- [ ] Browser timeout.
- [ ] Tool failure.
- [ ] Deployment failure.
- [ ] Project resumed after process restart.

## Adversarial tests

Give models intentionally problematic inputs.

- [ ] Model requests unauthorized file.
- [ ] Model requests unauthorized deployment.
- [ ] Model tries to ignore a failed gate.
- [ ] Model invents business facts.
- [ ] Model requests excess repair attempts.
- [ ] Malformed tool arguments.
- [ ] Path traversal attempt.
- [ ] Secret-looking content written into generated code.

---

# PHASE 16 — Add Observability

For each project, make it possible to reconstruct:

```text
what happened
which model decided it
why it decided it
which artifacts it saw
which tools it requested
what the harness allowed
what changed
which validation failed
what was repaired
why the project was approved
```

- [ ] Project trace ID.
- [ ] Job trace ID.
- [ ] Model invocation trace.
- [ ] Tool invocation trace.
- [ ] Artifact lineage.
- [ ] Budget events.
- [ ] Policy decisions.
- [ ] Validation results.
- [ ] Deployment events.
- [ ] Cost metrics.
- [ ] Latency metrics.

The architecture already calls for tracing every job, artifact, tool call, validation result, approval, and deployment.

---

# PHASE 17 — Build the Quality Benchmark

Do this before spending weeks tweaking prompts.

Create approximately 30–50 standard business briefs first.

Later expand toward 100+.

Industries:

```text
restaurant
dentist
law firm
HVAC
construction
agency
consultancy
SaaS
real estate
hotel
salon
health clinic
financial services
automotive
home services
```

For every benchmark run record:

- [ ] First-pass build success.
- [ ] Final build success.
- [ ] Deterministic failures.
- [ ] Initial visual score.
- [ ] Final visual score.
- [ ] Sol replan count.
- [ ] Terra refinement count.
- [ ] Luna repair count.
- [ ] Tool-call count.
- [ ] Total model calls.
- [ ] Tokens.
- [ ] Cost.
- [ ] Runtime.
- [ ] Budget exhaustion.
- [ ] Human preference result.

The approved roadmap already recommends piloting real sites and measuring one-shot success, rejection count, repair count, budget exhaustion, and release quality.

---

# Recommended Implementation Order

Do **not** tackle everything simultaneously.

## Sprint 1 — Correct the architecture

- [ ] Add decision contracts.
- [ ] Implement `sol-route`.
- [ ] Implement `sol-adjudicate`.
- [ ] Implement real `sol-replan`.
- [ ] Implement `sol-approve`.
- [ ] Add harness policy engine.
- [ ] Separate Sol recommendation from harness authorization.
- [ ] Add tests.

## Sprint 2 — Make the harness real

- [ ] Refactor `orchestrator.ts`.
- [ ] Activate the job engine.
- [ ] Centralize model runtime.
- [ ] Implement tool gateway.
- [ ] Add audit trail.
- [ ] Add job/artifact lineage.

## Sprint 3 — Give the models an environment

- [ ] Read/list/search filesystem tools.
- [ ] Build/test tools.
- [ ] Browser/preview runtime.
- [ ] Screenshot tool.
- [ ] DOM inspection.
- [ ] Controlled write/patch tools.
- [ ] Agent tool loop.

## Sprint 4 — Fix visual quality

- [ ] Screenshot-based Terra review.
- [ ] `terra-refine`.
- [ ] Visual quality dimensions.
- [ ] Separate visual-refinement budget.
- [ ] Design contract.
- [ ] Better page composition schemas.
- [ ] Asset pipeline.

## Sprint 5 — Production hardening

- [ ] Benchmark.
- [ ] Fault injection.
- [ ] Security tests.
- [ ] Cost tracking.
- [ ] Observability.
- [ ] Deployment policy.
- [ ] Rollback.
- [ ] Pilot projects.

---

# Rules to Give Claude Before Every Task

Use these instructions at the beginning of each Claude coding session:

```text
You are modifying the Website-agent repository.

Architecture rule:

Sol, Terra and Luna are OpenAI model tiers.
The proprietary TypeScript harness is authoritative.

Models may:
- reason
- plan
- recommend
- generate
- review
- propose changes

The harness must own:
- project state
- artifact persistence
- permissions
- tool execution
- budgets
- policy
- validation
- authorization
- deployment
- audit logs

Do not move authoritative state into model conversation history.

Do not let a model:
- change its own budget
- expand its permissions
- bypass deterministic gates
- access secrets
- deploy directly
- write outside an allowed workspace

Every model output that affects workflow must use a typed structured contract.

Preserve existing behavior unless this task explicitly changes it.

Before editing:
1. inspect the relevant files,
2. explain the current behavior,
3. identify the smallest architectural change,
4. list files that need modification.

Then implement the change.

After implementation:
1. run tests,
2. run type-check/build,
3. summarize files changed,
4. explain architecture impact,
5. report anything still incomplete.

Do not perform unrelated refactors.
Do not add a large agent framework unless required.
Do not leave placeholder TODO implementations.
```

---

# First Claude Task

Give Claude this task first:

```text
Audit the current Website-agent repository specifically for the
Sol/Terra/Luna + proprietary harness architecture.

Do not modify code yet.

Inspect:
- packages/orchestrator
- packages/agents
- packages/contracts
- packages/job-engine
- packages/gates
- packages/model-client
- project state/artifact code

Create a responsibility table containing:

1. decision/action
2. current implementation location
3. current decision maker
4. intended owner:
   - SOL model
   - TERRA model
   - LUNA model
   - HARNESS
5. whether the current implementation matches the intended architecture
6. recommended change
7. priority

Pay particular attention to:
- one-shot vs decomposition
- repair routing
- re-planning
- retry budgets
- terminal escalation
- final machine approval
- tool permissions
- deployment authorization
- artifact persistence
- model invocation
- job scheduling

Important architectural rule:

Models provide intelligence.
The harness provides authority.

Do not make any code changes.
Return the audit first.
```

Review that output yourself.

Then give Claude **one implementation task at a time**.

Do not say:

```text
Implement the entire new architecture.
```

That is likely to produce a large, difficult-to-review refactor.

Use:

```text
Task 1: contracts
Task 2: sol-route
Task 3: sol-adjudicate
Task 4: sol-replan
Task 5: policy engine
Task 6: orchestrator integration
Task 7: job engine
...
```

One architectural capability per PR is the safer path.

---

# Final Definition of Done

You can consider the Model + Harness architecture properly implemented when this sequence is real:

```text
Client Intake
     ↓
HARNESS creates project
     ↓
SOL plans
     ↓
HARNESS validates plan
     ↓
SOL chooses execution strategy
     ↓
HARNESS authorizes strategy
     ↓
TERRA executes
     ↓
HARNESS runs deterministic validation
     ↓
TERRA independently reviews rendered site
     ↓
SOL adjudicates evidence
     ↓
HARNESS validates Sol decision
     ↓
LUNA repairs
       OR
TERRA refines
       OR
SOL replans
     ↓
HARNESS re-validates
     ↓
SOL recommends acceptance
     ↓
HARNESS checks policy
     ↓
HARNESS authorizes release
     ↓
Deployment
     ↓
Smoke tests
     ↓
Monitoring
```

At that point, Sol/Terra/Luna are genuinely functioning as the OpenAI intelligence layer, while your proprietary harness remains the secure and deterministic operating system around them.