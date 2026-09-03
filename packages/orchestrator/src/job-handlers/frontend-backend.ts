/**
 * The first production `JobHandler`: Terra's `frontend_backend` role.
 *
 * This adapts {@link buildFromPlan} — the same function the direct delivery
 * loop (`orchestrator.ts`) calls — to `JobRunner`'s handler contract. Nothing
 * about how Terra builds a site changes here; only how one execution of it is
 * reached: from a claimed, persisted job with pinned input `ArtifactRef`s,
 * instead of from `runProject`'s in-memory `RunContext`.
 *
 * `job-engine` stays generic on purpose (Phase 5c/5d): it knows nothing about
 * Terra, workspaces or `ModelClient`. This module is where that knowledge
 * lives — the layer that already owns build execution and its dependencies.
 *
 * Not implemented here: `runProject` still builds directly, without going
 * through the job engine at all. Nothing enqueues a `frontend_backend` job in
 * production yet; this handler only makes one *executable* once something
 * does.
 */
import type { ArtifactRef, WorkerRole } from '@statxai/contracts';
import type { BudgetLimits, JobDocument, StateStore } from '@statxai/state';
import { ProjectWorkspace, type ArtifactRegistry } from '@statxai/workspace';
import type { ModelClient } from '@statxai/agents';
import type { JobHandler } from '@statxai/job-engine';
import { buildFromPlan } from '../phases/build.js';
import type { FixedContext, Progress, RunDeps } from '../run-context.js';

const ROLE: WorkerRole = 'frontend_backend';

/**
 * Defense in depth at the adapter boundary (§24 of the brief this shipped
 * under). `JobRunner`'s `claimableRoles` (5d) already guarantees this handler
 * is never claimed against any other role — this is what fires if it is ever
 * invoked directly, bypassing the runner, with a job that is not its own.
 */
export class FrontendBackendRoleMismatch extends Error {
  constructor(actual: string) {
    super(`terra frontend_backend handler invoked with a job whose role is "${actual}", not "${ROLE}"`);
    this.name = 'FrontendBackendRoleMismatch';
  }
}

/** A required pinned input was absent from the job, or resolved to nothing usable. */
export class FrontendBackendInputInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontendBackendInputInvalid';
  }
}

/**
 * `JobSpec.inputs` keys this handler requires. Plain strings — `JobSpec`
 * stays a generic `Record<string, ArtifactRef>`; nothing here widens that
 * contract.
 */
export const FRONTEND_BACKEND_INPUT = {
  businessProfile: 'businessProfile',
  sitePlan: 'sitePlan',
} as const;

export interface FrontendBackendHandlerDeps {
  store: StateStore;
  registry: ArtifactRegistry;
  model: ModelClient;
  /** Where `ProjectWorkspace.open` materialises the project's Git checkout. */
  workspacesRoot: string;
  /** Defaults to a no-op: a job execution is not part of a `RunRecorder` run. */
  say?: Progress;
  /** Defaults to a no-op, for the same reason. */
  track?: RunDeps['track'];
}

function requiredRef(job: JobDocument, key: string): ArtifactRef {
  const ref = job.spec.inputs[key];
  if (!ref) {
    throw new FrontendBackendInputInvalid(
      `frontend_backend job "${job._id}" is missing required pinned input "${key}"`,
    );
  }
  return ref;
}

/**
 * Build the harness-owned dependencies `buildFromPlan` needs from the job's
 * own pinned refs, without ever falling back to "latest" for anything the
 * job specified. `registry.resolve` reads the exact `(name, version)` pinned
 * by the ref — never `sort: version desc` — so a version accepted after this
 * job was created cannot change what it builds from.
 */
async function resolveInputs(
  deps: FrontendBackendHandlerDeps,
  job: JobDocument,
): Promise<{ profile: unknown; plan: unknown; autonomyMode: string; budgetLimits: BudgetLimits }> {
  const profileRef = requiredRef(job, FRONTEND_BACKEND_INPUT.businessProfile);
  const planRef = requiredRef(job, FRONTEND_BACKEND_INPUT.sitePlan);

  // `registry.resolve(job.projectId, ref)` addresses the artifact document by
  // `artifactId(job.projectId, ref.name, ref.version)` — an artifact from a
  // different project is a different id, not a permission check that could be
  // bypassed. A job cannot reach outside its own project's artifacts.
  const [profile, plan, project, budget] = await Promise.all([
    deps.registry.resolve(job.projectId, profileRef),
    deps.registry.resolve(job.projectId, planRef),
    deps.store.projects.findOne({ _id: job.projectId }),
    deps.store.budgets.findOne({ _id: job.projectId }),
  ]);

  if (!project) {
    throw new FrontendBackendInputInvalid(`frontend_backend job "${job._id}": no project record for "${job.projectId}"`);
  }
  if (!budget) {
    throw new FrontendBackendInputInvalid(`frontend_backend job "${job._id}": no budget record for "${job.projectId}"`);
  }

  return { profile, plan, autonomyMode: project.autonomyMode, budgetLimits: budget.limits };
}

/**
 * The real production `frontend_backend` handler.
 *
 * `deps` are the harness-owned collaborators this handler always needs —
 * supplied once, at construction, the same way `identity` and
 * `claimableRoles` are fixed on the `JobRunner` that will run it. Per-job
 * data (which profile, which plan, which project) comes only from the
 * claimed `JobDocument`.
 */
export function createTerraFrontendBackendHandler(deps: FrontendBackendHandlerDeps): JobHandler {
  const say: Progress = deps.say ?? (() => {});
  const track: RunDeps['track'] = deps.track ?? (() => {});

  return async (job, ctx) => {
    if (job.role !== ROLE) {
      throw new FrontendBackendRoleMismatch(job.role);
    }

    // Fail before any model invocation on a malformed job — a missing input
    // must not fall back to "current profile" or "latest plan".
    const { profile, plan, autonomyMode, budgetLimits } = await resolveInputs(deps, job);

    ctx.signal.throwIfAborted();

    const workspace = await ProjectWorkspace.open(job.projectId, deps.workspacesRoot);

    const fixedContext: FixedContext = {
      deps: { store: deps.store, registry: deps.registry, workspace, model: deps.model, say, track },
      facts: {
        projectId: job.projectId,
        // `buildFromPlan` and everything it calls read `facts.profile` as a
        // `BusinessProfile` and its second argument as a `SitePlan` — that
        // contract is inherited unchanged, not re-declared here.
        profile: profile as FixedContext['facts']['profile'],
        autonomyMode,
        budgetLimits,
      },
    };

    ctx.signal.throwIfAborted();

    // The one call both this handler and the direct delivery loop share.
    // `signal` is what makes this safe to run under a lease that can be lost
    // mid-build: ModelClient cannot cancel an in-flight call, so a response
    // that arrives after authority is gone is still tracked for telemetry but
    // never reaches a durable write — see build.ts's own doc comment.
    await buildFromPlan(fixedContext, plan as Parameters<typeof buildFromPlan>[1], ctx.signal);

    ctx.signal.throwIfAborted();
  };
}
