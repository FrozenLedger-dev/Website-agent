/**
 * The production `JobHandler` for Terra's `frontend_backend` role.
 *
 * This adapts {@link prepareBuildFromPlan} — the generation half of the same
 * function the direct delivery loop calls in full — to `JobRunner`'s handler
 * contract. Nothing about how Terra builds a site changes here; only how one
 * execution of it is reached, and, since Phase 5f, that this handler never
 * publishes what it generates itself.
 *
 * Publication is `publishBuildDirectly`'s job, and this handler never calls
 * it. Instead it stages the generated {@link BuildCandidate} as an isolated,
 * unaccepted artifact, namespaced under this exact job and attempt
 * (`jobOutputNamespace`), and returns a reference to it as its
 * `JobHandlerResult`. It becomes reachable only if `JobRunner`'s own guarded
 * `running -> validating` transition — which this handler has no access to —
 * proves this execution still owns the job when it finishes. Until then it is
 * orphanable staging garbage: unaccepted, unreferenced by any canonical
 * artifact name, invisible to "latest" queries against the project, and never
 * materialised into the shared project workspace, which this handler never
 * even opens.
 *
 * `job-engine` stays generic on purpose (Phase 5c/5d/5f): it knows nothing
 * about Terra, workspaces, `ModelClient`, or what a "build candidate" is —
 * only that a `JobHandlerResult`'s outputs must be namespaced under the
 * execution that produced them. This module is where the website-specific
 * knowledge lives.
 *
 * Not implemented here: `runProject` still builds directly, through
 * `buildFromPlan`'s full prepare-then-publish, without going through the job
 * engine at all. Nothing enqueues a `frontend_backend` job in production yet.
 * A validating job's staged candidate is not accepted, promoted or deployed
 * by anything in this phase — that is the next slice's work.
 */
import type { ArtifactRef, FilesystemReadResult, ToolId, WorkerRole } from '@statxai/contracts';
import type { JobDocument } from '@statxai/state';
import { defaultTemplateRoot, type ArtifactRegistry } from '@statxai/workspace';
import type { ModelRuntime } from '@statxai/agents';
import { jobOutputNamespace, type JobHandler, type JobHandlerResult } from '@statxai/job-engine';
import { prepareBuildFromPlan, type BuildCandidate, type PrepareContext } from '../phases/build.js';
import type { Progress, RunFacts } from '../run-context.js';
import { effectiveTools, ToolGateway } from '../tool-gateway/gateway.js';
import { createScaffoldFilesystemAdapter } from '../tool-gateway/filesystem.js';

const ROLE: WorkerRole = 'frontend_backend';

/**
 * The tools this handler implements. A job's grant is intersected with this,
 * so a spec naming more cannot make the handler capable of more.
 */
export const FRONTEND_BACKEND_SUPPORTED_TOOLS: readonly ToolId[] = Object.freeze(['filesystem']);

/**
 * Defense in depth at the adapter boundary. `JobRunner`'s `claimableRoles`
 * (5d) already guarantees this handler is never claimed against any other
 * role — this is what fires if it is ever invoked directly, bypassing the
 * runner, with a job that is not its own.
 */
export class FrontendBackendRoleMismatch extends Error {
  constructor(actual: string) {
    super(`terra frontend_backend handler invoked with a job whose role is "${actual}", not "${ROLE}"`);
    this.name = 'FrontendBackendRoleMismatch';
  }
}

/** A required pinned input was absent from the job. */
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

/** The one staged output this handler ever produces, by label. */
export const FRONTEND_BACKEND_OUTPUT_LABEL = 'build-candidate';

/** The artifact name one execution's staged candidate is written under. */
export function frontendBackendCandidateName(jobId: string, attempt: number): string {
  return `${jobOutputNamespace(jobId, attempt)}${FRONTEND_BACKEND_OUTPUT_LABEL}`;
}

export interface FrontendBackendHandlerDeps {
  registry: ArtifactRegistry;
  /** The model runtime — which also reports each call's usage to whoever constructed it. */
  model: ModelRuntime;
  /** Defaults to a no-op: a job execution is not part of a `RunRecorder` run. */
  say?: Progress;
  /**
   * The gateway every tool call from this handler crosses. Defaults to one
   * registering only the read-only scaffold filesystem.
   */
  tools?: ToolGateway;
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
 * The real production `frontend_backend` handler.
 *
 * `deps` are the harness-owned collaborators this handler always needs —
 * supplied once, at construction, the same way `identity` and
 * `claimableRoles` are fixed on the `JobRunner` that will run it. Per-job
 * data (which profile, which plan, which project, which attempt) comes only
 * from the claimed `JobDocument`.
 */
export function createTerraFrontendBackendHandler(deps: FrontendBackendHandlerDeps): JobHandler {
  const say: Progress = deps.say ?? (() => {});
  const gateway =
    deps.tools ?? new ToolGateway({ adapters: [createScaffoldFilesystemAdapter({ root: defaultTemplateRoot() })] });

  return async (job, ctx): Promise<JobHandlerResult> => {
    if (job.role !== ROLE) {
      throw new FrontendBackendRoleMismatch(job.role);
    }

    const profileRef = requiredRef(job, FRONTEND_BACKEND_INPUT.businessProfile);
    const planRef = requiredRef(job, FRONTEND_BACKEND_INPUT.sitePlan);

    ctx.signal.throwIfAborted();

    // Pinned means pinned: `resolve` reads the exact (name, version) the job
    // was given — never `sort: version desc` — so a version accepted after
    // this job was created cannot change what it builds from. The artifact
    // document's own id embeds `job.projectId`, so a ref cannot address
    // another project's artifact regardless of what a job claims.
    const [profile, plan] = await Promise.all([
      deps.registry.resolve(job.projectId, profileRef),
      deps.registry.resolve(job.projectId, planRef),
    ]);

    ctx.signal.throwIfAborted();

    // No workspace, artifact acceptance, or store mutation happens here or
    // inside prepareBuildFromPlan — generation only calls the model. The
    // canonical project workspace is never opened by this handler at all,
    // so there is nothing here that could materialise into it before this
    // execution's authority is proven.
    const prepareContext: PrepareContext = {
      deps: {
        model: deps.model,
        say,
        // Bound to this claimed job. Permission is re-checked by the gateway on
        // every call, against this job's own spec — never against anything the
        // model says.
        tools: {
          grantedTools: effectiveTools(job.spec.allowedTools, FRONTEND_BACKEND_SUPPORTED_TOOLS),
          execute: (request, signal) =>
            gateway.execute<FilesystemReadResult>({
              tool: request.tool,
              input: request.input,
              context: {
                projectId: job.projectId,
                jobId: job._id,
                skill: 'terra-build',
                role: job.role,
                allowedTools: job.spec.allowedTools,
                supportedTools: FRONTEND_BACKEND_SUPPORTED_TOOLS,
              },
              ...(signal !== undefined ? { signal } : {}),
            }),
        },
      },
      facts: { profile: profile as RunFacts['profile'] },
    };
    const candidate: BuildCandidate = await prepareBuildFromPlan(
      prepareContext,
      plan as Parameters<typeof prepareBuildFromPlan>[1],
      ctx.signal,
    );

    // The signal cancels the model call at the provider, but authority can
    // still be lost the instant after it resolves; the result is checked again
    // here, before it is even staged.
    ctx.signal.throwIfAborted();

    // Staged, not published. The name is namespaced under this exact job and
    // attempt — job ids are unique across the whole jobs collection, so no
    // other job or other attempt of this job can ever collide with it — and
    // JobRunner independently enforces that same namespace before it will
    // ever attach this ref to the job. Never accepted: acceptance is
    // validation/promotion authority this phase does not touch.
    const outputName = frontendBackendCandidateName(job._id, job.attempt);
    const ref = await deps.registry.put(job.projectId, outputName, candidate);

    ctx.signal.throwIfAborted();

    return { outputs: [ref] };
  };
}
