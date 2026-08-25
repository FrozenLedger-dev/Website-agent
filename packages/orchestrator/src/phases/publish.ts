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
 */
import { BudgetExhausted, spend } from '@statxai/state';
import { deploySite, deploymentConfigured, type DeployResult } from '@statxai/workspace';
import type { DeploymentManifest } from '@statxai/contracts';
import type { ReleaseAuthorization } from '@statxai/policy-engine';
import type { RunContext } from '../run-context.js';

export interface PublishResult {
  manifest: DeploymentManifest;
  /** The commit the manifest itself was written in. */
  finalCommit: string | null;
}

export async function publishRelease(
  ctx: RunContext,
  authorization: ReleaseAuthorization,
): Promise<PublishResult> {
  const { deps, facts, progress } = ctx;

  await deps.store.projects.updateOne(
    { _id: facts.projectId },
    { $set: { state: 'releasing', updatedAt: new Date() } },
  );

  const releaseCommit = (await deps.workspace.commit('Harness: release-authorized revision')) ?? (await deps.workspace.currentCommit());

  /**
   * Deploy only after machine approval (§9: "publish from a machine-accepted
   * source revision"). What ships is the export produced by the build the gates
   * and the reviewer both passed — no rebuild happens here, so what was
   * approved is byte-for-byte what goes live.
   */
  let deployment: DeployResult | null = null;

  if (deploymentConfigured()) {
  // The previous release is the rollback target, read before this one
  // supersedes it.
  const previous = await deps.store.artifacts.findOne(
    { projectId: facts.projectId, name: 'deployment-manifest' },
    { sort: { version: -1 } },
  );
  const previousDeploymentId =
    (previous?.data as { deploymentId?: string | null } | undefined)?.deploymentId ?? null;

  // Publishing is retried, but under the `failedDeployments` budget — a host
  // that is down stays down, and an unbounded retry would burn the run on an
  // outage it cannot fix. Two failures and Sol stops trying.
  while (deployment === null) {
    deps.say({ phase: 'publish', detail: 'Deploying the accepted export' });
    try {
      deployment = await deploySite(deps.workspace.siteRoot, facts.projectId, { previousDeploymentId });
      deps.say({
        phase: 'publish',
        detail: `Live at ${deployment.url} (${deployment.fileCount} files, ${(deployment.durationMs / 1000).toFixed(1)}s)`,
        level: 'ok',
      });
    } catch (error) {
      // A failed deploy is a release failure, not a silent one: the site was
      // approved but is not live, and the manifest must not claim otherwise.
      deps.say({
        phase: 'publish',
        detail: `Deployment failed: ${error instanceof Error ? error.message : String(error)}`,
        level: 'fail',
      });
      try {
        await spend(deps.store, facts.projectId, 'failedDeployments');
      } catch (budgetError) {
        if (!(budgetError instanceof BudgetExhausted)) throw budgetError;
        deps.say({
          phase: 'publish',
          detail: 'Deployment budget exhausted — the approved site stays on local preview',
          level: 'fail',
        });
        break;
      }
    }
  }
  } else {
  deps.say({ phase: 'publish', detail: 'No deployment configured — released to local preview only', level: 'warn' });
  }

  const manifest: DeploymentManifest = {
  projectId: facts.projectId,
  commit: releaseCommit ?? 'uncommitted',
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
  const finalCommit = (await deps.workspace.commit('Harness: release manifest')) ?? releaseCommit;

  await deps.store.projects.updateOne(
    { _id: facts.projectId },
    { $set: { state: 'released', updatedAt: new Date() } },
  );
  deps.say({ phase: 'publish', detail: `Released at ${finalCommit?.slice(0, 8) ?? 'HEAD'}`, level: 'ok' });

  return { manifest, finalCommit };
}
