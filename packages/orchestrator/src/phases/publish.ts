/**
 * Publishing an authorised release.
 *
 * Reached only through a harness authorisation, which the caller checks: every
 * route that skipped approval — a terminal escalation, an exhausted budget, a
 * refused revision — stops before this runs.
 *
 * What ships is the export produced by the build the gates and the reviewer
 * both passed. No rebuild happens here, so what was approved is byte-for-byte
 * what goes live (§9: "publish from a machine-accepted source revision").
 *
 * Phase 5p adds durable publication authority around the one external side
 * effect: a release publication receipt exists before Vercel is called, and an
 * attempt whose outcome is not durably known stops automation dead until an
 * operator reconciles it. See `../release-publication/publication.ts` for why
 * that cannot be automatic.
 */
import { deploySite, deploymentConfigured, getDeploymentById, type DeployResult } from '@statxai/workspace';
import type { ArtifactRef, DeploymentManifest } from '@statxai/contracts';
import type { ReleaseAuthorization } from '@statxai/policy-engine';
import type { ReleasePublicationDocument } from '@statxai/state';
import type { RunContext } from '../run-context.js';
import { releaseActiveLineage } from '../run-binding/frontend-backend.js';
import {
  RELEASE_COMMIT_METADATA_KEY,
  RELEASE_METADATA_KEY,
  ReleasePublicationReconciliationRequired,
  beginPublicationAttempt,
  computeReleaseId,
  ensureReleasePublicationPrepared,
  establishReleaseCommit,
  recordPublicationSuccess,
  resolveDeploymentTarget,
  type ReleaseDeploymentReader,
} from '../release-publication/publication.js';

export interface PublishResult {
  manifest: DeploymentManifest;
  /** The commit the manifest itself was written in. */
  finalCommit: string | null;
}

/** What publication needs from the deployment provider. Injectable for tests. */
export interface ReleaseDeploymentGateway extends ReleaseDeploymentReader {
  deploy(input: {
    siteRoot: string;
    projectId: string;
    previousDeploymentId: string | null;
    meta: Record<string, string>;
  }): Promise<DeployResult>;
}

/** The real provider. The only place production reaches Vercel to publish. */
export const vercelReleaseGateway: ReleaseDeploymentGateway = {
  async deploy(input) {
    return await deploySite(input.siteRoot, input.projectId, {
      previousDeploymentId: input.previousDeploymentId,
      meta: input.meta,
    });
  },
  async getDeploymentById(deploymentId) {
    return await getDeploymentById(deploymentId);
  },
};

export interface PublishOptions {
  /**
   * The exact `release-authorization` artifact this release publishes —
   * threaded from `seekRelease` rather than re-resolved as "latest", because
   * it is the release's identity, not a lookup.
   */
  releaseAuthorizationRef: ArtifactRef;
  gateway?: ReleaseDeploymentGateway;
}

export async function publishRelease(
  ctx: RunContext,
  authorization: ReleaseAuthorization,
  options: PublishOptions,
): Promise<PublishResult> {
  const { deps, facts } = ctx;
  const gateway = options.gateway ?? vercelReleaseGateway;

  await deps.store.projects.updateOne(
    { _id: facts.projectId },
    { $set: { state: 'releasing', updatedAt: new Date() } },
  );

  /**
   * No deployment configured: nothing leaves this machine, so there is no
   * external effect to fence and this path is exactly what it always was.
   * Phase 5p's authority is deliberately scoped to publications that can
   * actually create a production deployment — a receipt around a local
   * preview would be ceremony, and would need reconciling for no reason.
   */
  if (!deploymentConfigured()) {
    const releaseCommit =
      (await deps.workspace.commit('Harness: release-authorized revision')) ??
      (await deps.workspace.currentCommit());
    deps.say({ phase: 'publish', detail: 'No deployment configured — released to local preview only', level: 'warn' });
    return await writeManifest(ctx, authorization, { releaseCommit, deployment: null });
  }

  // Canonical HEAD *before* this release's own publication commit. Recorded in
  // the receipt as drift authority; deliberately not part of the release
  // identity, which has to stay stable across the commit that follows.
  const baseCommit = await deps.workspace.currentCommit();
  const deploymentTarget = resolveDeploymentTarget(facts.projectId);
  const releaseId = computeReleaseId({
    projectId: facts.projectId,
    releaseAuthorization: options.releaseAuthorizationRef,
  });

  /**
   * A release whose deployment is already durably known replays without
   * touching Vercel or Git publication at all — whatever crashed afterwards
   * (the manifest, the project state) is simply redone from the receipt.
   */
  const known = await deps.store.releasePublications.findOne({ _id: releaseId });
  if (known?.status === 'committed') {
    deps.say({
      phase: 'publish',
      detail: `Release already published as ${known.deploymentId ?? 'an adopted deployment'} — reusing it`,
      level: 'ok',
    });
    return await writeManifest(ctx, authorization, {
      releaseCommit: known.releaseCommitSha,
      deployment: {
        ...deploymentFromReceipt(known),
        rollbackRef: await previousDeployment(ctx, known.deploymentId),
      },
    });
  }

  // Creates the authority, or re-proves an existing one still describes this
  // exact release and destination. Target drift fails closed here, before any
  // external call can redirect a publication somewhere else.
  const receipt = await ensureReleasePublicationPrepared(deps.store, {
    releaseId,
    projectId: facts.projectId,
    releaseAuthorization: options.releaseAuthorizationRef,
    baseCommit,
    deploymentTarget,
  });

  if (receipt.status === 'publishing') {
    // An earlier attempt may have created a production deployment. Nothing
    // here can prove otherwise, so automation stops.
    throw new ReleasePublicationReconciliationRequired(
      receipt._id,
      receipt.projectId,
      receipt.attempt,
      'a previous attempt was sent to the provider and never resolved',
    );
  }

  // Replay-safe canonical publication commit: its own marker is how a retry
  // recognises the commit it already made instead of making a second one.
  const releaseCommit = await establishReleaseCommit(deps.workspace, receipt);

  // The rollback target, read before this release supersedes it — and never
  // this release's own deployment, which a replay would otherwise adopt as
  // its own predecessor.
  const previousDeploymentId = await previousDeployment(ctx, receipt.deploymentId);

  /**
   * Durable *before* the provider call, and this ordering is the whole phase:
   * a process that dies one instruction after this leaves `publishing` behind,
   * and every later invocation refuses to deploy again.
   */
  const publishing = await beginPublicationAttempt(deps.store, receipt, { releaseCommitSha: releaseCommit });

  deps.say({ phase: 'publish', detail: `Deploying the accepted export (attempt ${publishing.attempt})` });

  let deployment: DeployResult;
  try {
    deployment = await gateway.deploy({
      siteRoot: deps.workspace.siteRoot,
      projectId: facts.projectId,
      previousDeploymentId,
      meta: {
        [RELEASE_METADATA_KEY]: releaseId,
        ...(releaseCommit ? { [RELEASE_COMMIT_METADATA_KEY]: releaseCommit } : {}),
      },
    });
  } catch (error) {
    /**
     * The request failed — which is not the same as "no deployment was
     * created". It may have reached Vercel and been accepted before the
     * connection broke. The receipt stays `publishing` and a human decides.
     *
     * This is where Phase 5p deliberately departs from the old behaviour: the
     * previous code retried under the `failedDeployments` budget and, once
     * that was spent, wrote a manifest claiming local preview — a claim it
     * could not actually support after an ambiguous attempt.
     */
    throw new ReleasePublicationReconciliationRequired(
      receipt._id,
      receipt.projectId,
      publishing.attempt,
      `the deployment request failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  // If the provider echoed metadata back and it disagrees, this response is
  // not evidence about our release, so the attempt stays unresolved. A
  // response carrying no metadata at all is not a disagreement.
  const echoed = deployment.meta?.[RELEASE_METADATA_KEY];
  if (echoed !== undefined && echoed !== releaseId) {
    throw new ReleasePublicationReconciliationRequired(
      receipt._id,
      receipt.projectId,
      publishing.attempt,
      'the provider returned a deployment carrying a different release marker',
    );
  }

  const committed = await recordPublicationSuccess(deps.store, {
    releaseId,
    attempt: publishing.attempt,
    deploymentId: deployment.deploymentId,
    deploymentUrl: deployment.url,
  });

  deps.say({
    phase: 'publish',
    detail: `Live at ${deployment.url} (${deployment.fileCount} files, ${(deployment.durationMs / 1000).toFixed(1)}s)`,
    level: 'ok',
  });

  return await writeManifest(ctx, authorization, {
    releaseCommit: committed.releaseCommitSha,
    deployment: { ...deploymentFromReceipt(committed), rollbackRef: deployment.rollbackRef },
  });
}

/** What the manifest records about where the site went live. */
interface PublishedDeployment {
  url: string;
  deploymentId: string;
  rollbackRef: string | null;
}

function deploymentFromReceipt(receipt: ReleasePublicationDocument): PublishedDeployment {
  return {
    url: receipt.deploymentUrl ?? '',
    deploymentId: receipt.deploymentId ?? '',
    rollbackRef: null,
  };
}

/**
 * The deployment this release replaces, for the manifest's rollback target.
 *
 * Skips any manifest recording the deployment this release itself produced, so
 * a replay after the manifest was already written does not make a release its
 * own rollback target.
 */
async function previousDeployment(ctx: RunContext, ownDeploymentId: string | null): Promise<string | null> {
  const manifests = await ctx.deps.store.artifacts
    .find({ projectId: ctx.facts.projectId, name: 'deployment-manifest' })
    .sort({ version: -1 })
    .limit(5)
    .toArray();

  for (const manifest of manifests) {
    const deploymentId = (manifest.data as { deploymentId?: string | null } | undefined)?.deploymentId ?? null;
    if (deploymentId !== null && deploymentId !== ownDeploymentId) return deploymentId;
  }
  return null;
}

/**
 * The manifest, and the release's durable conclusion.
 *
 * One writer for both paths — configured publication and local preview — so a
 * replayed release and a fresh one describe themselves identically.
 */
async function writeManifest(
  ctx: RunContext,
  authorization: ReleaseAuthorization,
  published: { releaseCommit: string | null; deployment: PublishedDeployment | null },
): Promise<PublishResult> {
  const { deps, facts, progress } = ctx;
  const { deployment } = published;

  const manifest: DeploymentManifest = {
    projectId: facts.projectId,
    commit: published.releaseCommit ?? 'uncommitted',
    environment: deployment ? 'production' : 'preview',
    autonomyMode: facts.autonomyMode,
    /**
     * Who judged, and who authorised — separately, and neither standing in for
     * the other. The single `approvedBy: 'sol:machine-approval'` this replaces
     * named a model for a decision the harness made alone.
     *
     * The recommendation is the one Sol actually gave, read from the persisted
     * record rather than inferred from the authorisation. Deriving it from
     * `action === 'release'` happens to agree today, because a manifest exists
     * only after an authorised release — but it would report the harness's
     * conclusion under Sol's name the moment those two could differ, which is
     * the exact confusion this field was split to end.
     */
    recommendation: {
      by: 'sol' as const,
      model: progress.approvalModel,
      artifactVersion: progress.approvalArtifactVersion,
      decision: progress.approvalDecision,
    },
    authorization: {
      by: 'harness-policy' as const,
      policyVersion: authorization.policyVersion,
      action: authorization.action,
      reason: authorization.reason,
    },
    qualityScore: progress.qualityScore,
    // The gates that actually certified this revision, not a fresh run against
    // a tree that may have moved on. Re-running them here would also mean
    // reporting a different result from the one the release was granted on.
    checks: [...progress.gatesCertified],
    url: deployment?.url ?? null,
    deploymentId: deployment?.deploymentId ?? null,
    rollbackRef: deployment?.rollbackRef ?? null,
    releasedAt: new Date(),
  };

  await deps.registry.put(facts.projectId, 'deployment-manifest', manifest);
  await deps.workspace.materialiseArtifact('deployment/deployment-manifest.json', manifest);
  const finalCommit = (await deps.workspace.commit('Harness: release manifest')) ?? published.releaseCommit;

  // The one genuinely successful terminal state. The lineage that built this
  // release releases the project in the same transaction that records it, so a
  // crash can never leave the project released while an unfinished lineage
  // still claims to own it.
  await deps.store.withTransaction(async (session) => {
    await deps.store.projects.updateOne(
      { _id: facts.projectId },
      { $set: { state: 'released', updatedAt: new Date() } },
      { session },
    );
    await releaseActiveLineage(deps.store, facts.projectId, { session });
  });
  deps.say({ phase: 'publish', detail: `Released at ${finalCommit?.slice(0, 8) ?? 'HEAD'}`, level: 'ok' });

  return { manifest, finalCommit };
}
