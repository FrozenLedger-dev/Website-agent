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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VisualQualityReview, VisualRefinementSource, type ArtifactRef, type EditableSiteModel, type ToolId, type ToolResult, type WorkerRole } from '@statxai/contracts';
import type { JobDocument } from '@statxai/state';
import { contentHash, defaultTemplateRoot, type ArtifactRegistry, type BlobStore } from '@statxai/workspace';
import { refineSiteVisually, type ModelRuntime, type ToolAccess } from '@statxai/agents';
import { jobOutputNamespace, type JobHandler, type JobHandlerResult } from '@statxai/job-engine';
import { prepareBuildFromPlan, type BuildCandidate, type PrepareContext } from '../phases/build.js';
import type { Progress, RunFacts } from '../run-context.js';
import { effectiveTools, ToolGateway } from '../tool-gateway/gateway.js';
import { createScaffoldFilesystemAdapter } from '../tool-gateway/filesystem.js';
import { createTestRunnerAdapter } from '../tool-gateway/test-runner.js';
import { reproduceReviewFrames } from '../phases/visual-review.js';
import { resolveEditableSiteModel } from '../site-model/persist.js';

const ROLE: WorkerRole = 'frontend_backend';

/**
 * The tools this handler implements. A job's grant is intersected with this,
 * so a spec naming more cannot make the handler capable of more.
 */
export const FRONTEND_BACKEND_SUPPORTED_TOOLS: readonly ToolId[] = Object.freeze(['filesystem', 'test_runner']);

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
  /**
   * The exact editable site model version the build must carry the semantic
   * identity of. Absent on specs written before the model existed, which are
   * built and validated exactly as they always were.
   */
  editableSiteModel: 'editableSiteModel',
  /**
   * Present, all three together, only on a visual refinement: the exact
   * harness-read source snapshot of the build being refined, and the exact
   * review and screenshot set that authorised it. Their presence is what makes
   * a job a refinement; nothing else does.
   */
  visualRefinementSource: 'visualRefinementSource',
  visualQualityReview: 'visualQualityReview',
  screenshotSet: 'screenshotSet',
} as const;

/** Whether a job spec is a visual refinement — decided by its pinned inputs alone. */
export function isVisualRefinementSpec(spec: { readonly inputs: Readonly<Record<string, unknown>> }): boolean {
  return spec.inputs[FRONTEND_BACKEND_INPUT.visualRefinementSource] !== undefined;
}

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
   * The gateway every tool call from this handler crosses. Defaults to one per
   * job registering exactly the read-only scaffold filesystem and the advisory
   * test runner bound to that job's pinned profile and plan.
   */
  tools?: ToolGateway;
  /** Where advisory test builds create their disposable workspaces. */
  advisoryWorkspacesRoot?: string;
  /** Durable screenshot images, read by exact key. Required to execute a visual refinement. */
  blobs?: BlobStore;
}

/** Two refs name the same exact artifact: same name and version, and the same content hash wherever both record one. */
function sameExactRef(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.name === b.name && a.version === b.version && (a.contentHash === undefined || b.contentHash === undefined || a.contentHash === b.contentHash);
}

/** The production gateway for one claimed job: exactly the two tools this handler supports. */
export function createFrontendBackendToolGateway(options: { profile: unknown; plan: unknown; advisoryWorkspacesRoot: string; siteModel?: EditableSiteModel | null }): ToolGateway {
  return new ToolGateway({
    adapters: [
      createScaffoldFilesystemAdapter({ root: defaultTemplateRoot() }),
      createTestRunnerAdapter({
        profile: options.profile as RunFacts['profile'],
        plan: options.plan as Parameters<typeof prepareBuildFromPlan>[1],
        workspacesRoot: options.advisoryWorkspacesRoot,
        siteModel: options.siteModel ?? null,
      }),
    ],
  });
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
  const advisoryWorkspacesRoot = deps.advisoryWorkspacesRoot ?? join(tmpdir(), 'statxai-advisory');

  /**
   * A visual refinement's generation half: the exact pinned source, review and
   * screenshots — each resolved by exact ref and proven to name the others — and
   * one bounded `terra-refine` proposal. Like a build, it writes nothing.
   */
  async function prepareVisualRefinement(
    job: JobDocument,
    profile: RunFacts['profile'],
    plan: Parameters<typeof prepareBuildFromPlan>[1],
    tools: ToolAccess,
    signal: AbortSignal,
    siteModel: EditableSiteModel | null,
  ): Promise<BuildCandidate> {
    if (!deps.blobs) throw new FrontendBackendInputInvalid(`frontend_backend job "${job._id}" is a visual refinement, but this handler has no screenshot store`);
    const sourceRef = requiredRef(job, FRONTEND_BACKEND_INPUT.visualRefinementSource);
    const reviewRef = requiredRef(job, FRONTEND_BACKEND_INPUT.visualQualityReview);
    const setRef = requiredRef(job, FRONTEND_BACKEND_INPUT.screenshotSet);

    const [rawSource, rawReview] = await Promise.all([
      deps.registry.resolve(job.projectId, sourceRef),
      deps.registry.resolve(job.projectId, reviewRef),
    ]);
    const source = VisualRefinementSource.parse(rawSource);
    const review = VisualQualityReview.parse(rawReview);

    const refuse = (detail: string) => new FrontendBackendInputInvalid(`visual refinement job "${job._id}": ${detail}`);
    if (sourceRef.contentHash !== undefined && contentHash(rawSource) !== sourceRef.contentHash) throw refuse('the source snapshot does not match its pinned content hash');
    if (source.projectId !== job.projectId) throw refuse('the source snapshot belongs to another project');
    if (contentHash(source.files) !== source.filesDigest) throw refuse('the source snapshot files do not match their digest');
    if (!sameExactRef(source.visualQualityReview, reviewRef) || !sameExactRef(source.screenshotSet, setRef)) {
      throw refuse('the source snapshot names a different review or screenshot set than the job pins');
    }
    if (!sameExactRef(review.screenshotSet, setRef)) throw refuse('the review judged a different screenshot set than the job pins');
    if (review.status !== 'reviewed' || !review.assessment) throw refuse(`the review is ${review.status}, not a usable assessment`);

    signal.throwIfAborted();
    // Exactly the images the reviewer judged, recut from the durable screenshots and matched frame by frame.
    const frames = await reproduceReviewFrames({ registry: deps.registry, blobs: deps.blobs }, job.projectId, review);
    signal.throwIfAborted();

    say({ phase: 'build', detail: `Terra is refining build ${source.predecessorBindingId} (visual refinement ${source.refinementCycle})` });
    const refined = await refineSiteVisually(
      deps.model,
      {
        profile,
        plan,
        refinementCycle: source.refinementCycle,
        predecessor: { bindingId: source.predecessorBindingId, sourceCommit: source.sourceCommit },
        source: source.files,
        review: { ref: reviewRef, screenshotSet: setRef, assessment: review.assessment },
        frames,
        ...(siteModel ? { siteModel } : {}),
      },
      { signal, tools },
    );
    // No route decision: a refinement is not routed, and says so rather than inventing one.
    return { routeDecisions: [], files: refined.value.files };
  }

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

    // The exact editable site model the job pins, if it pins one — the identity every page it builds must carry.
    const modelRef = job.spec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel];
    const siteModel = modelRef ? await resolveEditableSiteModel(deps.registry, job.projectId, modelRef) : null;
    if (siteModel && (siteModel.sitePlan.name !== planRef.name || siteModel.sitePlan.version !== planRef.version)) {
      throw new FrontendBackendInputInvalid(`frontend_backend job "${job._id}" pins an editable site model for a different site plan`);
    }

    ctx.signal.throwIfAborted();

    const gateway = deps.tools ?? createFrontendBackendToolGateway({ profile, plan, advisoryWorkspacesRoot, siteModel });

    // Bound to this claimed job. Permission is re-checked by the gateway on
    // every call, against this job's own spec — never against anything the
    // model says. The same grant for a build and a refinement; only the skill
    // named in the evidence differs.
    const toolAccess = (skill: 'terra-build' | 'terra-refine'): ToolAccess => ({
      grantedTools: effectiveTools(job.spec.allowedTools, FRONTEND_BACKEND_SUPPORTED_TOOLS),
      execute: (request, signal) =>
        gateway.execute<ToolResult>({
          tool: request.tool,
          input: request.input,
          context: {
            projectId: job.projectId,
            jobId: job._id,
            skill,
            role: job.role,
            allowedTools: job.spec.allowedTools,
            supportedTools: FRONTEND_BACKEND_SUPPORTED_TOOLS,
          },
          ...(signal !== undefined ? { signal } : {}),
        }),
    });

    // No workspace, artifact acceptance, or store mutation happens here or
    // inside prepareBuildFromPlan — generation only calls the model. The
    // canonical project workspace is never opened by this handler at all,
    // so there is nothing here that could materialise into it before this
    // execution's authority is proven.
    let candidate: BuildCandidate;
    if (isVisualRefinementSpec(job.spec)) {
      candidate = await prepareVisualRefinement(job, profile as RunFacts['profile'], plan as Parameters<typeof prepareBuildFromPlan>[1], toolAccess('terra-refine'), ctx.signal, siteModel);
    } else {
      const prepareContext: PrepareContext = {
        deps: { model: deps.model, say, tools: toolAccess('terra-build') },
        facts: { profile: profile as RunFacts['profile'], ...(siteModel ? { siteModel } : {}) },
      };
      candidate = await prepareBuildFromPlan(prepareContext, plan as Parameters<typeof prepareBuildFromPlan>[1], ctx.signal);
    }

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
