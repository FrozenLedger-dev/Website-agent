/**
 * Sol judges the release; the harness decides it.
 *
 * Two artifacts, in that order, because the trail has to be able to show a
 * recommendation and an authorisation that disagree. Deployment is reachable
 * only through the authorisation this returns.
 *
 * The provenance comes back as a value rather than being assigned into the
 * run: a phase reports what it found, and the caller decides what to remember.
 */
import {
  RELEASE_POLICY_VERSION,
  authorizeRelease,
  verifyAcknowledged,
  type AcknowledgementCheck,
  type ReleaseAuthorization,
  type ReleaseEvidence,
} from '@statxai/policy-engine';
import { recommendApproval } from '@statxai/agents';
import { deploymentConfigured } from '@statxai/workspace';
import type { SolApprovalRecommendation } from '@statxai/contracts';
import type { ApprovalRecord, AuthorizationRecord } from '../release.js';
import type { Defect } from '../defects.js';
import type { RunContext } from '../run-context.js';

export interface ReleaseEvidenceInput {
  gateRun: {
    passed: boolean;
    findings: { severity: string; gate: string; location: string; message: string }[];
    gatesRun: string[];
  };
  buildOk: boolean;
  buildSummary: string;
  reviewSummary: string | null;
  openNonBlocking: readonly Defect[];
}

/** Who recommended, and on which artifact version. Recorded on the manifest. */
export interface ApprovalProvenance {
  approvalArtifactVersion: number | null;
  approvalModel: string | null;
  approvalDecision: 'accept' | 'reject' | 'human_review' | null;
}

export interface ReleaseOutcome {
  decision: ReleaseAuthorization;
  provenance: ApprovalProvenance;
}

export async function seekRelease(
  ctx: RunContext,
  context: ReleaseEvidenceInput,
): Promise<ReleaseOutcome> {
  const { deps, facts, progress } = ctx;

  const planDoc = await deps.store.artifacts.findOne({ projectId: facts.projectId, name: 'site-plan' }, { sort: { version: -1 } });
  const reportDoc = await deps.store.artifacts.findOne({ projectId: facts.projectId, name: 'test-report' }, { sort: { version: -1 } });
  const reviewDoc = await deps.store.artifacts.findOne({ projectId: facts.projectId, name: 'visual-review' }, { sort: { version: -1 } });

  const evidence: ReleaseEvidence = {
    blockingDefects: 0,
    buildSucceeded: context.buildOk,
    gatesPassed: context.gateRun.passed,
    autonomyMode: facts.autonomyMode,
    deploymentConfigured: deploymentConfigured(),
  };

  const record: ApprovalRecord = {
    reviewCycle: progress.reviewCycle,
    sitePlanVersion: planDoc?.version ?? null,
    testReportVersion: reportDoc?.version ?? null,
    visualReviewVersion: reviewDoc?.version ?? null,
    recommendation: null,
    reason: null,
    acknowledgedIssues: [],
    unverifiableIssues: [],
    model: null,
    modelFailure: null,
    decidedAt: new Date(),
  };

  let recommendation: SolApprovalRecommendation | null = null;
  let checked: AcknowledgementCheck | undefined;

  try {
    const recommended = await recommendApproval(deps.model, {
      reviewCycle: progress.reviewCycle,
      plan: progress.plan,
      profile: facts.profile,
      qualityScore: progress.qualityScore,
      blockingCount: 0,
      gatesRun: context.gateRun.gatesRun,
      gateFindings: context.gateRun.findings.map(
        (f) => `${f.severity} ${f.gate} ${f.location} — ${f.message}`,
      ),
      buildSummary: context.buildSummary,
      reviewSummary: context.reviewSummary,
      openNonBlocking: context.openNonBlocking.map((d) => ({
        id: d.id,
        severity: d.severity,
        category: d.category,
        location: d.location,
        reason: d.reason,
      })),
      repairHistory: progress.repairHistory.map((r) => ({ defectId: r.defectId, outcome: r.outcome })),
      replanCount: progress.replansUsed,
      autonomyMode: facts.autonomyMode,
      releasePolicy: {
        'blocking defects permitted': '0, not waivable',
        'gates must pass': 'yes',
        'autonomy mode': facts.autonomyMode,
        'deployment configured': String(deploymentConfigured()),
        'authorised by': RELEASE_POLICY_VERSION,
      },
    });
    deps.track('sol', recommended);

    recommendation = recommended.value;
    checked = verifyAcknowledged(recommended.value.acknowledgedIssues, context.openNonBlocking);

    record.model = recommended.model;
    record.recommendation = recommended.value.recommendation;
    record.reason = recommended.value.reason;
    record.acknowledgedIssues = checked.known;
    record.unverifiableIssues = checked.unknown;

    deps.say({
      phase: 'approve',
      detail: `Sol recommends ${recommended.value.recommendation}: ${recommended.value.reason}`,
      level: recommended.value.recommendation === 'accept' ? 'ok' : 'warn',
    });

    if (checked.unknown.length > 0) {
      // Recorded rather than treated as considered: an id nothing matches may
      // be a stale reference or an invention, and either way it is not
      // evidence that an issue was seen and judged acceptable.
      deps.say({
        phase: 'approve',
        detail: `Acknowledged issues that match nothing open: ${checked.unknown.join(', ')}`,
        level: 'warn',
      });
    }
  } catch (error) {
    // A missing recommendation is not an approval, and the harness does not
    // write one on Sol's behalf.
    record.modelFailure = error instanceof Error ? error.message : String(error);
    deps.say({
      phase: 'approve',
      detail: `Sol could not be consulted on release: ${record.modelFailure}`,
      level: 'fail',
    });
  }

  const approvalRef = await deps.registry.put(facts.projectId, 'approval-recommendation', record);
  await deps.registry.accept(facts.projectId, approvalRef);
  await deps.workspace.materialiseArtifact(
    `decisions/approval-${String(progress.reviewCycle).padStart(2, '0')}.json`,
    record,
  );

  const approvalDoc = await deps.store.artifacts.findOne(
    { projectId: facts.projectId, name: 'approval-recommendation' },
    { sort: { version: -1 } },
  );

  // The harness decides, having read the recommendation as one input among
  // the deterministic facts it checked for itself.
  const decision = authorizeRelease({ recommendation, evidence, acknowledgement: checked });

  const authorizationRecord: AuthorizationRecord = {
    reviewCycle: progress.reviewCycle,
    recommendationVersion: approvalDoc?.version ?? null,
    recommendation: record.recommendation,
    evidence,
    authorized: decision.authorized,
    action: decision.action,
    reason: decision.reason,
    policyVersion: decision.policyVersion,
    authorizedBy: 'harness-policy',
    authorizedAt: new Date(),
  };
  const authRef = await deps.registry.put(facts.projectId, 'release-authorization', authorizationRecord);
  await deps.registry.accept(facts.projectId, authRef);
  await deps.workspace.materialiseArtifact(
    `decisions/release-authorization-${String(progress.reviewCycle).padStart(2, '0')}.json`,
    authorizationRecord,
  );

  return {
    decision,
    provenance: {
      approvalArtifactVersion: approvalDoc?.version ?? null,
      approvalModel: record.model,
      approvalDecision: record.recommendation,
    },
  };
}
