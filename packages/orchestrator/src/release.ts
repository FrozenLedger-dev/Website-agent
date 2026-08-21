/**
 * The approval and authorisation artifacts.
 *
 * The decisions are `@statxai/policy-engine`'s; these are the shapes they are
 * persisted in, which is a harness concern. They stay separate on purpose, so
 * the trail can show a recommendation and an authorisation that disagree.
 */
import type { ReleaseAction, ReleaseEvidence } from '@statxai/policy-engine';

/** What gets stored as the versioned `approval-recommendation` artifact. */
export interface ApprovalRecord {
  reviewCycle: number;
  sitePlanVersion: number | null;
  testReportVersion: number | null;
  visualReviewVersion: number | null;
  recommendation: 'accept' | 'reject' | 'human_review' | null;
  reason: string | null;
  acknowledgedIssues: string[];
  /** Acknowledged ids that match nothing currently open. */
  unverifiableIssues: string[];
  model: string | null;
  modelFailure: string | null;
  decidedAt: Date;
}

/** What gets stored as the versioned `release-authorization` artifact. */
export interface AuthorizationRecord {
  reviewCycle: number;
  /** The recommendation this considered, by artifact version. */
  recommendationVersion: number | null;
  recommendation: 'accept' | 'reject' | 'human_review' | null;
  evidence: ReleaseEvidence;
  authorized: boolean;
  action: ReleaseAction;
  reason: string;
  policyVersion: string;
  /** Always the harness. A model never appears here. */
  authorizedBy: 'harness-policy';
  authorizedAt: Date;
}
