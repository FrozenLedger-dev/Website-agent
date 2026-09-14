/**
 * Customer self-service initial draft generation.
 *
 *   createInitialDraftRequest — trusted, durable handoff only. Mints a project
 *   id, binds it to the requesting account, and records one durable request.
 *   Nothing is planned, built, validated or evaluated here; the request is
 *   returned promptly so an HTTP caller can answer with 202.
 *
 *   resumeInitialDraftGeneration — what the standalone worker calls, once per
 *   claimed lease. It drives the request to a canonical draft through the
 *   exact same `runProject` an operator run uses, with `completionTarget:
 *   'draft'` — never a parallel generation path.
 *
 * Replay is by identity, never by time: the same account, customer user and
 * exact intake always resolve the same request and the same project, and
 * `runProject` itself resumes from durable state — an active build binding, or
 * Phase 5q's post-promotion recovery — rather than restarting from scratch.
 * Nothing here re-implements that; it is called exactly as an operator run
 * calls it, with the one addition this module owns: reclaiming a
 * frontend_backend job lease left `running` by a worker that crashed mid-build,
 * which nothing else in the codebase does for this build boundary today.
 */
import type { BusinessProfile } from '@statxai/contracts';
import type { Provider } from '@statxai/agents';
import { JobEngine } from '@statxai/job-engine';
import type { InitialDraftFailureReason, InitialDraftRequestDocument, StateStore } from '@statxai/state';
import { contentHash } from '@statxai/workspace';
import { findActivePreparedBinding } from '../run-binding/frontend-backend.js';
import { slugify } from '../run-service.js';
import { resolveCanonicalDraftAuthority } from '../canonical-draft/authority.js';
import { runProject } from '../orchestrator.js';
import type { Progress } from '../run-context.js';
import { updateInitialDraftProgress } from './execution.js';

/** Durable initial-draft authority is missing or contradicts itself. Nothing is continued; an operator must look. */
export class InitialDraftAuthorityCorrupt extends Error {
  constructor(
    readonly projectId: string,
    detail: string,
  ) {
    super(`project "${projectId}": initial draft generation authority is corrupt — ${detail}`);
    this.name = 'InitialDraftAuthorityCorrupt';
  }
}

/** A create request was refused before anything durable was written. */
export class InitialDraftRequestRefused extends Error {
  constructor(readonly reason: 'too_many_active') {
    super(`initial draft request refused: ${reason}`);
    this.name = 'InitialDraftRequestRefused';
  }
}

/**
 * How many initial generations one account may have `queued` or `active` at
 * once. Small and explicit, not billing/quota infrastructure — see the module
 * doc on `createInitialDraftRequest` for the race this bound tolerates.
 */
export const MAX_ACTIVE_INITIAL_DRAFTS_PER_ACCOUNT = 2;

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

function mintProjectId(businessName: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `proj_${slugify(businessName)}_${suffix}`;
}

export interface InitialDraftRequestAccepted {
  readonly requestId: string;
  readonly projectId: string;
  readonly status: InitialDraftRequestDocument['status'];
}

/**
 * Create (or, for an exact replay, return) the one durable request for this
 * exact account, customer user and intake.
 *
 * `_id` is deterministic from those three — so a double-submitted or retried
 * identical request always resolves to the same request and the same project;
 * a *different* intake is simply a different, independent request, never a
 * conflict. The bound on concurrent active generations is checked before
 * insertion but is not itself transactional with it: two concurrent requests
 * for two different intents in the same account could both pass the count and
 * both insert, exceeding the bound by at most the number of racing requests.
 * Accepted deliberately — this is a small usability guard, not billing
 * enforcement, and the alternative is a multi-document transaction for a
 * property nothing downstream depends on being exact.
 */
export async function createInitialDraftRequest(
  store: StateStore,
  input: {
    readonly accountId: string;
    readonly customerUserId: string;
    readonly intake: BusinessProfile;
    readonly boundBy: string;
  },
  now: Date = new Date(),
): Promise<InitialDraftRequestAccepted> {
  const intakeDigest = contentHash(input.intake);
  const requestId = `ir_${contentHash({ accountId: input.accountId, customerUserId: input.customerUserId, intakeDigest })}`;

  const existing = await store.initialDraftRequests.findOne({ _id: requestId });
  if (existing) return { requestId: existing._id, projectId: existing.projectId, status: existing.status };

  const activeCount = await store.initialDraftRequests.countDocuments({ accountId: input.accountId, status: { $in: ['queued', 'active'] } });
  if (activeCount >= MAX_ACTIVE_INITIAL_DRAFTS_PER_ACCOUNT) throw new InitialDraftRequestRefused('too_many_active');

  const projectId = mintProjectId(input.intake.businessName);
  const document: InitialDraftRequestDocument = {
    _id: requestId,
    accountId: input.accountId,
    projectId,
    requestedBy: { customerUserId: input.customerUserId },
    intake: input.intake,
    intakeDigest,
    status: 'queued',
    progress: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  try {
    await store.initialDraftRequests.insertOne(document);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const raced = await store.initialDraftRequests.findOne({ _id: requestId });
    if (raced) return { requestId: raced._id, projectId: raced.projectId, status: raced.status };
    throw error;
  }

  // Insert-only, exactly like `bindProjectToCustomerAccount`: `projectId` is
  // freshly minted, so this always succeeds for the request's actual winner.
  // A losing racer's candidate `projectId` (discarded above, above the catch)
  // never reaches here and is never bound to anything.
  await store.projectAccountBindings.insertOne({ _id: projectId, accountId: input.accountId, boundBy: input.boundBy, boundAt: now });

  // A minimal placeholder project document, so the customer's own tenancy
  // check (`authorizeCustomerProjectView`, which reads both the binding above
  // and this document) succeeds immediately — before a worker has claimed this
  // request, discovery has never run. `discoverProject` deletes and recreates
  // this exact document when generation actually starts, precisely as it
  // already does for an operator-launched run; tenancy is untouched by that,
  // because it lives in the binding above, not here.
  await store.projects.insertOne({ _id: projectId, state: 'intake', autonomyMode: 'full_autonomous', reviewCycle: 0, createdAt: now, updatedAt: now });

  return { requestId, projectId, status: 'queued' };
}

const RETRYABLE_JOB_LIFECYCLE_OUTCOMES = new Set(['in_progress', 'retry_ready', 'not_claimable']);

export type InitialDraftGenerationOutcome = { readonly status: 'completed'; readonly resultDraftId: string } | { readonly status: 'in_progress' } | { readonly status: 'failed'; readonly reason: InitialDraftFailureReason };

/**
 * Continue exactly one leased initial draft request. Called by the standalone
 * worker only, holding a live execution lease — never from an HTTP request.
 */
export async function resumeInitialDraftGeneration(
  deps: { readonly store: StateStore; readonly workspacesRoot: string; readonly validationWorkspacesRoot: string; readonly modelProvider?: Provider },
  lease: { readonly requestId: string; readonly projectId: string; readonly token: string },
): Promise<InitialDraftGenerationOutcome> {
  const { store } = deps;
  const request = await store.initialDraftRequests.findOne({ _id: lease.requestId });
  if (!request) throw new InitialDraftAuthorityCorrupt(lease.projectId, `no such initial draft request "${lease.requestId}"`);

  // A canonical draft may already be concluded — a crash between `runProject`
  // returning `outcome: 'draft'` and this module recording completion. Checked
  // first, and unconditionally: `runProject` itself refuses to run again over a
  // concluded draft (`assertNoCanonicalDraftOwnsRun`), so this is the only way
  // that crash window resolves rather than wedging the request forever.
  const authority = await resolveCanonicalDraftAuthority(store, lease.projectId);
  if (authority?.state === 'concluded') return { status: 'completed', resultDraftId: authority.draft._id };

  // The `frontend_backend` job_lifecycle build boundary reports `in_progress`
  // and does nothing whenever its job is `running` — including a job whose
  // lease a crashed worker never released. Nothing else in this codebase
  // reclaims that lease for this build boundary (only the semantic-edit worker
  // reclaims its own jobs today), so a worker that does not do this here would
  // resume forever without making progress. Reclaimed only once the lease has
  // truly expired — a live worker's job is never touched.
  const binding = await findActivePreparedBinding(store, lease.projectId);
  if (binding) {
    const now = new Date();
    const job = await store.jobs.findOne({ _id: binding.jobId, projectId: lease.projectId });
    if (job?.state === 'running' && job.lease && job.lease.expiresAt.getTime() <= now.getTime()) {
      const engine = new JobEngine(store);
      await engine.reclaimExpiredJobLease(job._id, `initial-draft-worker:${lease.token}`, now);
    }
  }

  const onProgress: Progress = (event) => {
    const hint = mapProgressHint(event.phase);
    if (hint) void updateInitialDraftProgress(store, lease, hint);
  };

  const result = await runProject({
    projectId: lease.projectId,
    intake: request.intake,
    store,
    workspacesRoot: deps.workspacesRoot,
    validationWorkspacesRoot: deps.validationWorkspacesRoot,
    frontendBackendExecutionMode: 'job_lifecycle',
    completionTarget: 'draft',
    onProgress,
    ...(deps.modelProvider !== undefined ? { modelProvider: deps.modelProvider } : {}),
  });

  if (result.outcome === 'draft') {
    if (!result.draft) throw new InitialDraftAuthorityCorrupt(lease.projectId, 'runProject reported outcome "draft" with no draft authority');
    return { status: 'completed', resultDraftId: result.draft.canonicalDraftId };
  }
  if (result.outcome === 'intake_insufficient') return { status: 'failed', reason: 'invalid_request' };
  if (result.outcome === 'blocked') {
    const jlo = result.jobLifecycleOutcome;
    if (jlo !== undefined && RETRYABLE_JOB_LIFECYCLE_OUTCOMES.has(jlo)) return { status: 'in_progress' };
    return { status: 'failed', reason: 'generation_failed' };
  }
  // `released`: not a real reachable outcome for a fresh project whose only
  // run ever asked for `completionTarget: 'draft'` — corruption, not a case to guess about.
  throw new InitialDraftAuthorityCorrupt(lease.projectId, `runProject returned unexpected outcome "${result.outcome}" for a draft-targeted initial generation`);
}

function mapProgressHint(phase: string): 'planning' | 'building' | 'validating' | 'finishing' | null {
  switch (phase) {
    case 'discover':
    case 'plan':
    case 'replan':
      return 'planning';
    case 'build':
      return 'building';
    case 'evaluate':
    case 'adjudicate':
    case 'repair':
      return 'validating';
    case 'escalate':
    case 'approve':
    case 'publish':
      return 'finishing';
    default:
      return null;
  }
}
