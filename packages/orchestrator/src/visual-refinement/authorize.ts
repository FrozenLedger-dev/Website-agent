/**
 * Authorising one Terra visual refinement of one exact canonical build.
 *
 * Everything here happens before any model is invoked, and in this order:
 *
 *   1. prove the build is the exact tip of the project's one active lineage,
 *      promoted by exactly the promotion the run holds — its committed receipt,
 *      and the one canonical commit carrying that promotion's marker;
 *   2. replay: if this build was already authorised for refinement, return that
 *      intent exactly — no new decision, no new source, no new spend;
 *   3. prove the review is of that build's exact screenshots, and decide with
 *      the one versioned policy;
 *   4. prove the source: the commit the screenshots rendered is canonical HEAD
 *      now and descends from the build's own promotion, and read the
 *      model-owned source at exactly that commit from Git's object store;
 *   5. in one transaction, write the source snapshot, spend one durable
 *      `visualRefinements` slot, and record the intent with the deterministic
 *      job and successor binding that answer it.
 *
 * A crash anywhere before step 5 commits leaves nothing behind; a crash after
 * it leaves an intent every retry reuses. No slot is spent twice for one build,
 * and none is ever refunded: a refinement that later fails has still been had.
 */
import {
  VISUAL_REFINEMENT_SOURCE_LIMITS,
  VISUAL_REFINEMENT_SOURCE_SCHEMA_VERSION,
  VisualQualityReview,
  VisualRefinementSource,
  type ArtifactRef,
} from '@statxai/contracts';
import { BudgetExhausted, spend, type FrontendBackendBuildBindingDocument, type StateStore, type VisualRefinementIntentDocument } from '@statxai/state';
import { SourceSnapshotTooLarge, contentHash, type ArtifactRegistry, type ProjectWorkspace } from '@statxai/workspace';
import {
  computeBindingId,
  computeJobSpecHash,
  deriveActiveLineageTip,
  findActiveLineageRoot,
  readBuildLineage,
} from '../run-binding/frontend-backend.js';
import { findReleasePublicationForLineage } from '../release-publication/publication.js';
import { promotionMarker } from '../job-promotion/frontend-backend.js';
import { createFrontendBackendVisualRefinementJobSpec } from '../job-specs/frontend-backend.js';
import { FRONTEND_BACKEND_INPUT } from '../job-handlers/frontend-backend.js';
import type { VisualQualityReviewOutcome } from '../phases/visual-review.js';
import { VISUAL_REFINEMENT_POLICY, decideVisualRefinement, type VisualRefinementDecision } from './policy.js';

export const VISUAL_REFINEMENT_SOURCE_ARTIFACT = 'visual-refinement-source';

/** The authority a refinement would act on cannot be proven exactly. Nothing is authorised, spent or written. */
export class VisualRefinementAuthorityInvalid extends Error {
  constructor(
    readonly projectId: string,
    detail: string,
  ) {
    super(`project "${projectId}": visual refinement refused — ${detail}`);
    this.name = 'VisualRefinementAuthorityInvalid';
  }
}

export interface AuthorizeVisualRefinementInput {
  readonly store: StateStore;
  readonly registry: ArtifactRegistry;
  readonly workspace: ProjectWorkspace;
  readonly projectId: string;
  /** The exact canonical build the run holds, by id — re-read here, never trusted from memory. */
  readonly canonicalBindingId: string;
  /** The promotion the run holds for it. */
  readonly canonicalPromotion: { readonly promotionId: string | null; readonly promotionCommitSha: string | null };
  /** The exact screenshot set and review this evaluation wrote for that build. */
  readonly screenshotSet: ArtifactRef;
  readonly review: VisualQualityReviewOutcome;
}

export type VisualRefinementAuthorization =
  | { readonly kind: 'authorized'; readonly intent: VisualRefinementIntentDocument; readonly replayed: boolean }
  | { readonly kind: 'ineligible'; readonly decision: Extract<VisualRefinementDecision, { refine: false }> };

/** The deterministic intent identity: one per exact predecessor build. */
export function visualRefinementIntentId(projectId: string, predecessorBindingId: string): string {
  return `visual-refinement-${contentHash({ projectId, predecessorBindingId })}`;
}

function sameRef(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.name === b.name && a.version === b.version && (a.contentHash === undefined || b.contentHash === undefined || a.contentHash === b.contentHash);
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Which visual refinement this would be: one more than the visual refinements
 * already in the build's own chain, counted by walking exact predecessor ids
 * back to the root. Never a counter that could have moved since, and the same
 * answer for the same build every time.
 */
async function refinementCycleOf(store: StateStore, build: FrontendBackendBuildBindingDocument): Promise<number> {
  let cycle = 1;
  let current: FrontendBackendBuildBindingDocument | null = build;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current._id)) throw new VisualRefinementAuthorityInvalid(build.projectId, `lineage of "${build._id}" cycles`);
    seen.add(current._id);
    const position = readBuildLineage(current);
    if (position.kind === 'initial') break;
    if (position.provenance.kind === 'visual_refinement') cycle += 1;
    current = await store.frontendBackendBuildBindings.findOne({ _id: position.predecessorBindingId, projectId: build.projectId });
    if (!current) throw new VisualRefinementAuthorityInvalid(build.projectId, `predecessor "${position.predecessorBindingId}" is missing`);
  }
  return cycle;
}

export async function authorizeVisualRefinement(input: AuthorizeVisualRefinementInput): Promise<VisualRefinementAuthorization> {
  const { store, registry, workspace, projectId } = input;
  const refuse = (detail: string) => new VisualRefinementAuthorityInvalid(projectId, detail);

  // 1. The exact, promoted tip of the one active lineage.
  const build = await store.frontendBackendBuildBindings.findOne({ _id: input.canonicalBindingId, projectId });
  if (!build) throw refuse(`canonical build "${input.canonicalBindingId}" is missing`);
  if (build.status !== 'promoted' || !build.promotionId || !build.promotionCommitSha) throw refuse(`canonical build "${build._id}" is not promoted`);
  if (build.promotionId !== input.canonicalPromotion.promotionId || build.promotionCommitSha !== input.canonicalPromotion.promotionCommitSha) {
    throw refuse(`canonical build "${build._id}" was promoted by a different promotion than the run holds`);
  }
  const receipt = await store.promotions.findOne({ _id: build.promotionId });
  if (!receipt || receipt.projectId !== projectId || receipt.jobId !== build.jobId || receipt.status !== 'committed' || receipt.commitSha !== build.promotionCommitSha) {
    throw refuse(`promotion receipt "${build.promotionId}" does not prove build "${build._id}"`);
  }
  const marked = await workspace.findCommitsByMarker(promotionMarker(build.promotionId));
  if (marked.length !== 1 || marked[0] !== build.promotionCommitSha) {
    throw refuse(`canonical history does not carry exactly one commit for promotion "${build.promotionId}"`);
  }
  const root = await findActiveLineageRoot(store, projectId);
  if (!root) throw refuse('no active build lineage owns the project');
  const tip = await deriveActiveLineageTip(store, root);
  if (tip._id !== build._id) throw refuse(`canonical build "${build._id}" is not the active lineage tip "${tip._id}"`);

  // Fences hold for a replay too: nothing is built behind a person or a release.
  const [projectDoc, budgetDoc, publication] = await Promise.all([
    store.projects.findOne({ _id: projectId }),
    store.budgets.findOne({ _id: projectId }),
    findReleasePublicationForLineage(store, projectId, root._id),
  ]);
  if (!projectDoc) throw refuse('the project document is missing');
  if (!budgetDoc) throw refuse('the budget document is missing');
  const fenced = (reason: 'awaiting_human_review' | 'release_publication_exists', detail: string): VisualRefinementAuthorization => ({
    kind: 'ineligible',
    decision: { refine: false, policyVersion: VISUAL_REFINEMENT_POLICY.version, reason, detail },
  });
  if (projectDoc.state === 'awaiting_human_review') return fenced('awaiting_human_review', 'the project is awaiting human review');
  if (publication) return fenced('release_publication_exists', `release publication "${publication._id}" (${publication.status}) already owns this lineage`);

  // 2. Replay: an authorised refinement of this build is reused exactly.
  const intentId = visualRefinementIntentId(projectId, build._id);
  const existing = await store.visualRefinementIntents.findOne({ _id: intentId });
  if (existing) {
    if (existing.projectId !== projectId || existing.predecessorBindingId !== build._id || existing.lineageRootBindingId !== root._id) {
      throw refuse(`refinement intent "${intentId}" does not describe build "${build._id}"`);
    }
    return { kind: 'authorized', intent: existing, replayed: true };
  }

  // 3. The review is of this build's exact screenshots, then the policy decides.
  const { review } = input.review;
  const subject = review.subject;
  if (!sameRef(review.screenshotSet, input.screenshotSet)) throw refuse('the visual review judged a different screenshot set');
  if (subject.projectId !== projectId || !sameRef(subject.sitePlan, build.sitePlan)) throw refuse('the visual review is of a different project or plan');
  if (
    subject.authority.mode !== 'job_lifecycle' ||
    subject.authority.buildBindingId !== build._id ||
    subject.authority.promotionId !== build.promotionId ||
    subject.authority.promotionCommitSha !== build.promotionCommitSha
  ) {
    throw refuse(`the visual review's screenshots were not rendered from build "${build._id}"`);
  }

  const position = readBuildLineage(build);
  const triggeringReview =
    position.kind === 'successor' && position.provenance.kind === 'visual_refinement'
      ? VisualQualityReview.parse(await registry.resolve(projectId, position.provenance.visualQualityReview))
      : null;
  const decision = decideVisualRefinement({
    review,
    triggeringReview,
    projectState: projectDoc.state,
    releasePublicationExists: publication !== null,
    budget: { used: budgetDoc.used.visualRefinements, limit: budgetDoc.limits.visualRefinements },
  });
  if (!decision.refine) return { kind: 'ineligible', decision };

  // 4. The exact source: rendered, canonical now, and descended from this build's promotion.
  const sourceCommit = subject.sourceCommit;
  if (!sourceCommit) throw refuse('the screenshots name no source commit');
  const head = await workspace.currentCommit();
  if (head !== sourceCommit) throw refuse(`canonical HEAD ${head ?? '(none)'} is not the rendered source commit ${sourceCommit}`);
  if (!(await workspace.isAncestorCommit(build.promotionCommitSha, sourceCommit))) {
    throw refuse(`source commit ${sourceCommit} does not descend from promotion ${build.promotionCommitSha}`);
  }
  let files: { path: string; contents: string }[];
  try {
    files = await workspace.readModelSourceAtCommit(sourceCommit, VISUAL_REFINEMENT_SOURCE_LIMITS);
  } catch (error) {
    if (!(error instanceof SourceSnapshotTooLarge)) throw error;
    return {
      kind: 'ineligible',
      decision: { refine: false, policyVersion: VISUAL_REFINEMENT_POLICY.version, reason: 'source_too_large', detail: error.message },
    };
  }
  if (files.length === 0) throw refuse(`no model source is tracked at ${sourceCommit}`);

  const refinementCycle = await refinementCycleOf(store, build);
  const source = VisualRefinementSource.parse({
    schemaVersion: VISUAL_REFINEMENT_SOURCE_SCHEMA_VERSION,
    projectId,
    predecessorBindingId: build._id,
    promotionId: build.promotionId,
    promotionCommitSha: build.promotionCommitSha,
    sourceCommit,
    refinementCycle,
    visualQualityReview: input.review.ref,
    screenshotSet: input.screenshotSet,
    files,
    filesDigest: contentHash(files),
  });

  // 5. One transaction: the snapshot, the spend, the intent — or none of them.
  let won = false;
  try {
    const intent = await store.withTransaction(async (session) => {
      won = false;
      const raced = await store.visualRefinementIntents.findOne({ _id: intentId }, { session });
      if (raced) return raced;
      await spend(store, projectId, 'visualRefinements', session);
      const budgetAfter = await store.budgets.findOne({ _id: projectId }, { session });
      const sourceRef = await registry.put(projectId, VISUAL_REFINEMENT_SOURCE_ARTIFACT, source, session);
      const jobSpec = createFrontendBackendVisualRefinementJobSpec({
        projectId,
        businessProfileRef: build.businessProfile,
        sitePlanRef: build.sitePlan,
        visualRefinementSourceRef: sourceRef,
        visualQualityReviewRef: input.review.ref,
        screenshotSetRef: input.screenshotSet,
        // The same exact model the refined build carries: refinement changes presentation, never semantic identity.
        ...(build.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel] ? { editableSiteModelRef: build.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel] } : {}),
      });
      const doc: VisualRefinementIntentDocument = {
        _id: intentId,
        projectId,
        lineageRootBindingId: root._id,
        predecessorBindingId: build._id,
        visualQualityReview: input.review.ref,
        screenshotSet: input.screenshotSet,
        refinementCycle,
        policyVersion: decision.policyVersion,
        sourceCommit,
        source: sourceRef,
        jobId: jobSpec.jobId,
        jobSpec,
        successorBindingId: computeBindingId({ projectId, runIntentHash: build.runIntentHash, jobSpecHash: computeJobSpecHash(jobSpec) }),
        budgetSlot: budgetAfter?.used.visualRefinements ?? 0,
        authorizedAt: new Date(),
      };
      await store.visualRefinementIntents.insertOne(doc, { session });
      won = true;
      return doc;
    });
    return { kind: 'authorized', intent, replayed: !won };
  } catch (error) {
    if (error instanceof BudgetExhausted) {
      return {
        kind: 'ineligible',
        decision: { refine: false, policyVersion: decision.policyVersion, reason: 'budget_exhausted', detail: 'the durable visual refinement budget refused the spend' },
      };
    }
    if (!isDuplicateKeyError(error)) throw error;
    // A concurrent authorisation of the same build won; its intent is the one.
    const winner = await store.visualRefinementIntents.findOne({ _id: intentId });
    if (!winner) throw error;
    return { kind: 'authorized', intent: winner, replayed: true };
  }
}
