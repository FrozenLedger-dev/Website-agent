/**
 * Canonical draft authority: a concluded, unreleased canonical build, owned by
 * the project rather than by a run.
 *
 * A project has at most one authority over what happens next:
 *
 *   an active build lineage   — an unfinished run owns its exact tip;
 *   a current canonical draft — a concluded run left this exact tip, unreleased;
 *   a release publication     — a release owns publishing an exact build.
 *
 * Concluding a draft moves ownership from the first to the second in one
 * transaction: the lineage's `activeLineage` slot is released, the project
 * becomes `draft`, and the draft names the exact root, tip and promotion — so
 * there is never a moment with both owners, or with neither.
 *
 * A draft is never inferred from time, "the newest build" or a missing run. Its
 * tip is re-proven structurally from the exact root it records, every time it
 * is read, and anything that does not hold fails closed.
 *
 * Claiming a draft reserves it for exactly one operation, by compare-and-set.
 * A claim does nothing else — no build, no publication, no lineage — and never
 * expires: only its own claimant releases it.
 */
import type { ClientSession } from 'mongodb';
import type { CanonicalDraftClaimant, CanonicalDraftDocument, FrontendBackendBuildBindingDocument, ProjectState, StateStore } from '@statxai/state';
import { contentHash, type ProjectWorkspace } from '@statxai/workspace';
import { promotionMarker } from '../job-promotion/frontend-backend.js';
import {
  FrontendBackendBuildBindingCorrupt,
  FrontendBackendBuildLineageCorrupt,
  deriveActiveLineageTip,
  deriveLineageTipFromRoot,
} from '../run-binding/frontend-backend.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The run's build cannot be concluded as the project's draft. Nothing was written. */
export class CanonicalDraftConclusionRefused extends Error {
  constructor(
    readonly projectId: string,
    detail: string,
  ) {
    super(`project "${projectId}": canonical draft conclusion refused — ${detail}`);
    this.name = 'CanonicalDraftConclusionRefused';
  }
}

/** Durable draft authority is missing, contradicts itself, or no longer proves its build. */
export class CanonicalDraftAuthorityCorrupt extends Error {
  constructor(
    readonly projectId: string,
    detail: string,
  ) {
    super(`project "${projectId}": canonical draft authority is corrupt — ${detail}`);
    this.name = 'CanonicalDraftAuthorityCorrupt';
  }
}

export type CanonicalDraftClaimConflictReason =
  /** The project has no current draft. */
  | 'no_current_draft'
  /** The current draft is not the one the claimant expected. */
  | 'stale_draft'
  /** The current draft owns a different build than the claimant expected. */
  | 'stale_tip'
  /** Another operation holds the draft. */
  | 'claimed_by_another';

/** A claim, or its release, was refused because the draft is not in the exact expected state. */
export class CanonicalDraftClaimConflict extends Error {
  constructor(
    readonly projectId: string,
    readonly reason: CanonicalDraftClaimConflictReason,
    detail: string,
  ) {
    super(`project "${projectId}": canonical draft claim refused (${reason}) — ${detail}`);
    this.name = 'CanonicalDraftClaimConflict';
  }
}

/** A claimant that is not a well-formed, non-secret operation identity. */
export class CanonicalDraftClaimantInvalid extends Error {
  constructor(detail: string) {
    super(`canonical draft claimant refused — ${detail}`);
    this.name = 'CanonicalDraftClaimantInvalid';
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface CanonicalDraftIdentity {
  readonly projectId: string;
  readonly lineageRootBindingId: string;
  readonly canonicalBindingId: string;
  readonly promotionId: string;
}

/** Deterministic from exact build authority alone: no clock, no randomness, no sequence. */
export function canonicalDraftId(identity: CanonicalDraftIdentity): string {
  return `canonical-draft-${contentHash({
    projectId: identity.projectId,
    lineageRootBindingId: identity.lineageRootBindingId,
    canonicalBindingId: identity.canonicalBindingId,
    promotionId: identity.promotionId,
  })}`;
}

const CLAIM_KINDS: ReadonlySet<string> = new Set<CanonicalDraftClaimant['kind']>(['semantic_edit', 'release']);
/** An operation's own deterministic id: bounded, printable, and nothing else. */
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

/** The claimant exactly as stored: a known kind and a bounded operation id, and no other field. */
export function parseCanonicalDraftClaimant(value: unknown): CanonicalDraftClaimant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CanonicalDraftClaimantInvalid('a claimant is an object');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('operationId')) {
    throw new CanonicalDraftClaimantInvalid(`a claimant carries exactly kind and operationId, not ${keys.join(', ') || '(nothing)'}`);
  }
  const { kind, operationId } = value as Record<string, unknown>;
  if (typeof kind !== 'string' || !CLAIM_KINDS.has(kind)) throw new CanonicalDraftClaimantInvalid(`unknown claim kind ${String(kind)}`);
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) throw new CanonicalDraftClaimantInvalid('operationId is not a bounded operation identifier');
  return { kind: kind as CanonicalDraftClaimant['kind'], operationId };
}

const sameClaimant = (a: CanonicalDraftClaimant | undefined, b: CanonicalDraftClaimant) => a !== undefined && a.kind === b.kind && a.operationId === b.operationId;

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

type Session = { readonly session?: ClientSession };

function sessionOf(options: Session): { session?: ClientSession } {
  return options.session ? { session: options.session } : {};
}

/** A lineage walk failure, reported as the authority failure the caller is proving. */
async function tipFrom(
  walk: () => Promise<FrontendBackendBuildBindingDocument>,
  fail: (detail: string) => Error,
): Promise<FrontendBackendBuildBindingDocument> {
  try {
    return await walk();
  } catch (error) {
    if (error instanceof FrontendBackendBuildLineageCorrupt || error instanceof FrontendBackendBuildBindingCorrupt) throw fail(error.message);
    throw error;
  }
}

/** The tip's own promotion, from its committed receipt. Git is proven separately. */
async function provePromotion(
  store: StateStore,
  tip: FrontendBackendBuildBindingDocument,
  expected: { readonly promotionId: string; readonly promotionCommitSha: string },
  options: Session,
  fail: (detail: string) => Error,
): Promise<void> {
  if (tip.status !== 'promoted') throw fail(`build "${tip._id}" is "${tip.status}", not promoted`);
  if (tip.promotionId !== expected.promotionId || tip.promotionCommitSha !== expected.promotionCommitSha) {
    throw fail(`build "${tip._id}" was promoted by ${tip.promotionId ?? '(none)'} at ${tip.promotionCommitSha ?? '(none)'}, not ${expected.promotionId} at ${expected.promotionCommitSha}`);
  }
  const receipt = await store.promotions.findOne({ _id: expected.promotionId }, sessionOf(options));
  if (!receipt || receipt.projectId !== tip.projectId || receipt.jobId !== tip.jobId || receipt.status !== 'committed' || receipt.commitSha !== expected.promotionCommitSha) {
    throw fail(`promotion receipt "${expected.promotionId}" does not prove build "${tip._id}"`);
  }
}

/** Neither an unfinished release of the project, nor any release of this lineage, may own continuation alongside a draft. */
async function releaseOwner(store: StateStore, projectId: string, lineageRootBindingId: string, options: Session): Promise<string | null> {
  const publication = await store.releasePublications.findOne(
    { projectId, $or: [{ active: true }, { 'buildAuthority.lineageRootBindingId': lineageRootBindingId }] },
    sessionOf(options),
  );
  return publication ? `release publication "${publication._id}" (${publication.status})` : null;
}

/** The promotion's one marker commit in canonical history. */
export async function assertCanonicalDraftPromotionMarker(workspace: Pick<ProjectWorkspace, 'findCommitsByMarker'>, draft: CanonicalDraftDocument): Promise<void> {
  const marked = await workspace.findCommitsByMarker(promotionMarker(draft.promotionId));
  if (marked.length !== 1 || marked[0] !== draft.promotionCommitSha) {
    throw new CanonicalDraftAuthorityCorrupt(draft.projectId, `canonical history does not carry exactly one commit for promotion "${draft.promotionId}" at ${draft.promotionCommitSha}`);
  }
}

/**
 * Re-prove every link of one draft document from durable state: its identity,
 * that no lineage is active, that its root walks structurally to exactly its
 * build, that the build is promoted by exactly its promotion, and that no
 * release owns the project or the lineage.
 */
async function proveDraft(store: StateStore, draft: CanonicalDraftDocument, options: Session): Promise<void> {
  const { projectId } = draft;
  const corrupt = (detail: string) => new CanonicalDraftAuthorityCorrupt(projectId, detail);

  if (draft._id !== canonicalDraftId(draft)) throw corrupt(`draft "${draft._id}" does not carry the identity of the build it names`);
  if (draft.status === 'available' && draft.claim !== undefined) throw corrupt(`available draft "${draft._id}" records a claim`);
  if (draft.status === 'claimed') {
    try {
      parseCanonicalDraftClaimant(draft.claim);
    } catch (error) {
      throw corrupt(`claimed draft "${draft._id}" records no valid claimant (${(error as Error).message})`);
    }
  }
  if (draft.status !== 'available' && draft.status !== 'claimed') throw corrupt(`draft "${draft._id}" has unknown status "${String(draft.status)}"`);

  const active = await store.frontendBackendBuildBindings.findOne({ projectId, activeLineage: true }, sessionOf(options));
  if (active) throw corrupt(`build lineage "${active._id}" is still active while draft "${draft._id}" owns the project`);

  const root = await store.frontendBackendBuildBindings.findOne({ _id: draft.lineageRootBindingId, projectId }, sessionOf(options));
  if (!root) throw corrupt(`lineage root "${draft.lineageRootBindingId}" is missing`);
  if (root.lineageRootBindingId !== root._id) throw corrupt(`"${root._id}" is not the root of its own lineage`);
  const tip = await tipFrom(() => deriveLineageTipFromRoot(store, root, options), corrupt);
  if (tip._id !== draft.canonicalBindingId) throw corrupt(`lineage "${root._id}" ends at "${tip._id}", not at draft build "${draft.canonicalBindingId}"`);
  if (tip.lineageRootBindingId !== draft.lineageRootBindingId) throw corrupt(`build "${tip._id}" belongs to lineage "${tip.lineageRootBindingId ?? '(none)'}"`);
  await provePromotion(store, tip, draft, options, corrupt);

  const owner = await releaseOwner(store, projectId, root._id, options);
  if (owner) throw corrupt(`${owner} owns the project alongside draft "${draft._id}"`);
}

/**
 * The project's current canonical draft, fully re-proven — or `null` when the
 * project is not a concluded draft and has no current draft record.
 *
 * `draft` state and a current draft record are one fact: either without the
 * other, or more than one current record, fails closed.
 */
export async function loadCurrentCanonicalDraft(store: StateStore, projectId: string, options: Session = {}): Promise<CanonicalDraftDocument | null> {
  const corrupt = (detail: string) => new CanonicalDraftAuthorityCorrupt(projectId, detail);
  // Sequential: operations sharing one transaction session must not run concurrently.
  const project = await store.projects.findOne({ _id: projectId }, sessionOf(options));
  const drafts = await store.canonicalDrafts.find({ projectId, current: true }, sessionOf(options)).limit(2).toArray();
  if (drafts.length > 1) throw corrupt('more than one current draft');
  const draft = drafts[0];
  if (project?.state !== 'draft') {
    if (draft) throw corrupt(`draft "${draft._id}" is current but the project is ${project ? `"${project.state}"` : 'missing'}`);
    return null;
  }
  if (!draft) throw corrupt('the project is a concluded draft with no current draft record');
  await proveDraft(store, draft, options);
  return draft;
}

// ---------------------------------------------------------------------------
// Conclusion
// ---------------------------------------------------------------------------

/** A run concludes from a state it owns; anything terminal, parked or releasing is not its to conclude. */
const CONCLUDABLE: ReadonlySet<ProjectState> = new Set<ProjectState>(['planning', 'building', 'validating']);

export interface ConcludeCanonicalDraftInput {
  readonly store: StateStore;
  readonly workspace: Pick<ProjectWorkspace, 'findCommitsByMarker'>;
  readonly projectId: string;
  /** The exact canonical build the concluding run holds, by id — re-read here. */
  readonly canonicalBindingId: string;
  /** The promotion the run holds for it. */
  readonly promotion: { readonly promotionId: string | null; readonly promotionCommitSha: string | null };
}

export interface CanonicalDraftConclusion {
  readonly draft: CanonicalDraftDocument;
  /** `true` when this exact draft was already concluded and is returned unchanged. */
  readonly replayed: boolean;
}

/**
 * Conclude the run's exact canonical build as the project's unreleased draft.
 *
 * Inside one transaction: the project, its one active lineage, that lineage's
 * structural tip, the tip's promotion and receipt, and the absence of any
 * release owner are proven; then the draft is inserted, the project becomes
 * `draft` and the lineage's active slot is released. The promotion's marker
 * commit is immutable history and is proven just before.
 *
 * Replaying exactly the same conclusion returns the existing draft; anything
 * else fails closed without writing.
 */
export async function concludeCanonicalDraft(input: ConcludeCanonicalDraftInput): Promise<CanonicalDraftConclusion> {
  const { store, projectId, canonicalBindingId } = input;
  const refuse = (detail: string) => new CanonicalDraftConclusionRefused(projectId, detail);
  const { promotionId, promotionCommitSha } = input.promotion;
  if (!promotionId || !promotionCommitSha) throw refuse(`the run holds no promotion for build "${canonicalBindingId}"`);

  const marked = await input.workspace.findCommitsByMarker(promotionMarker(promotionId));
  if (marked.length !== 1 || marked[0] !== promotionCommitSha) {
    throw refuse(`canonical history does not carry exactly one commit for promotion "${promotionId}" at ${promotionCommitSha}`);
  }

  return store.withTransaction(async (session) => {
    const project = await store.projects.findOne({ _id: projectId }, { session });
    if (!project) throw refuse('the project document is missing');
    const binding = await store.frontendBackendBuildBindings.findOne({ _id: canonicalBindingId, projectId }, { session });
    if (!binding) throw refuse(`build "${canonicalBindingId}" is not this project's`);
    if (!binding.lineageRootBindingId) throw refuse(`build "${canonicalBindingId}" predates lineage identity`);
    const identity = { projectId, lineageRootBindingId: binding.lineageRootBindingId, canonicalBindingId, promotionId };
    const draftId = canonicalDraftId(identity);

    // Replay: exactly this draft, already concluded and still proven.
    if (project.state === 'draft') {
      const current = await loadCurrentCanonicalDraft(store, projectId, { session });
      if (!current || current._id !== draftId || current.promotionCommitSha !== promotionCommitSha) {
        throw refuse(`the project is already the concluded draft "${current?._id ?? '(none)'}", not a draft of build "${canonicalBindingId}"`);
      }
      return { draft: current, replayed: true };
    }
    if (!CONCLUDABLE.has(project.state)) throw refuse(`the project is "${project.state}"`);

    const root = await store.frontendBackendBuildBindings.findOne({ projectId, activeLineage: true }, { session });
    if (!root) throw refuse('no active build lineage owns the project');
    if (root._id !== binding.lineageRootBindingId) throw refuse(`build "${canonicalBindingId}" belongs to lineage "${binding.lineageRootBindingId}", not the active lineage "${root._id}"`);
    const tip = await tipFrom(() => deriveActiveLineageTip(store, root, { session }), refuse);
    if (tip._id !== canonicalBindingId) throw refuse(`the active lineage has advanced to "${tip._id}"; "${canonicalBindingId}" is not its tip`);
    await provePromotion(store, tip, { promotionId, promotionCommitSha }, { session }, refuse);

    const owner = await releaseOwner(store, projectId, root._id, { session });
    if (owner) throw refuse(`${owner} already owns continuation`);
    const existing = await store.canonicalDrafts.findOne({ $or: [{ projectId, current: true }, { _id: draftId }] }, { session });
    if (existing) throw refuse(`draft "${existing._id}" already exists while a lineage is active`);

    const now = new Date();
    const draft: CanonicalDraftDocument = { _id: draftId, ...identity, promotionCommitSha, status: 'available', current: true, createdAt: now, updatedAt: now };
    await store.canonicalDrafts.insertOne(draft, { session });

    const moved = await store.projects.updateOne({ _id: projectId, state: project.state }, { $set: { state: 'draft', updatedAt: now } }, { session });
    if (moved.matchedCount !== 1) throw refuse('the project state moved during conclusion');
    const released = await store.frontendBackendBuildBindings.updateOne(
      { _id: root._id, projectId, activeLineage: true },
      { $unset: { activeLineage: '' }, $set: { updatedAt: now } },
      { session },
    );
    if (released.matchedCount !== 1) throw refuse(`lineage "${root._id}" released its active slot during conclusion`);

    return { draft, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export interface ClaimCanonicalDraftInput {
  readonly store: StateStore;
  readonly projectId: string;
  /** The exact draft the claimant decided to act on. */
  readonly expectedDraftId: string;
  /** The exact build the claimant expects that draft to own. */
  readonly expectedCanonicalBindingId: string;
  readonly claimant: CanonicalDraftClaimant;
}

export interface CanonicalDraftClaim {
  readonly draft: CanonicalDraftDocument;
  /** `true` when this exact claimant already held the draft. */
  readonly replayed: boolean;
}

async function currentForClaim(store: StateStore, input: Omit<ClaimCanonicalDraftInput, 'claimant'>, session: ClientSession): Promise<CanonicalDraftDocument> {
  const { projectId } = input;
  const draft = await loadCurrentCanonicalDraft(store, projectId, { session });
  if (!draft) throw new CanonicalDraftClaimConflict(projectId, 'no_current_draft', 'the project has no current canonical draft');
  if (draft._id !== input.expectedDraftId) throw new CanonicalDraftClaimConflict(projectId, 'stale_draft', `the current draft is "${draft._id}", not "${input.expectedDraftId}"`);
  if (draft.canonicalBindingId !== input.expectedCanonicalBindingId) {
    throw new CanonicalDraftClaimConflict(projectId, 'stale_tip', `draft "${draft._id}" owns build "${draft.canonicalBindingId}", not "${input.expectedCanonicalBindingId}"`);
  }
  return draft;
}

/**
 * Reserve the exact current draft for one operation — only if it is still that
 * draft, still owns that build, and is available. The same claimant replaying
 * gets its claim back; any other claimant is refused. Nothing else happens.
 */
export async function claimCanonicalDraft(input: ClaimCanonicalDraftInput): Promise<CanonicalDraftClaim> {
  const { store, projectId } = input;
  const claimant = parseCanonicalDraftClaimant(input.claimant);

  return store.withTransaction(async (session) => {
    const draft = await currentForClaim(store, input, session);
    if (draft.status === 'claimed') {
      if (sameClaimant(draft.claim, claimant)) return { draft, replayed: true };
      throw new CanonicalDraftClaimConflict(projectId, 'claimed_by_another', `draft "${draft._id}" is held by another ${draft.claim?.kind ?? ''} operation`.trim());
    }

    const now = new Date();
    const result = await store.canonicalDrafts.updateOne(
      { _id: draft._id, projectId, current: true, status: 'available', canonicalBindingId: input.expectedCanonicalBindingId },
      { $set: { status: 'claimed', claim: { kind: claimant.kind, operationId: claimant.operationId }, updatedAt: now } },
      { session },
    );
    if (result.matchedCount !== 1) throw new CanonicalDraftClaimConflict(projectId, 'claimed_by_another', `draft "${draft._id}" was claimed concurrently`);
    return { draft: { ...draft, status: 'claimed', claim: claimant, updatedAt: now }, replayed: false };
  });
}

/**
 * Hand the draft back, by the operation that holds it — never by time, and
 * never by anyone else. Releasing an already-available draft changes nothing.
 */
export async function releaseCanonicalDraftClaim(input: ClaimCanonicalDraftInput): Promise<CanonicalDraftClaim> {
  const { store, projectId } = input;
  const claimant = parseCanonicalDraftClaimant(input.claimant);

  return store.withTransaction(async (session) => {
    const draft = await currentForClaim(store, input, session);
    if (draft.status === 'available') return { draft, replayed: true };
    if (!sameClaimant(draft.claim, claimant)) {
      throw new CanonicalDraftClaimConflict(projectId, 'claimed_by_another', `draft "${draft._id}" is held by another operation`);
    }

    const now = new Date();
    const result = await store.canonicalDrafts.updateOne(
      { _id: draft._id, projectId, current: true, status: 'claimed', 'claim.kind': claimant.kind, 'claim.operationId': claimant.operationId },
      { $set: { status: 'available', updatedAt: now }, $unset: { claim: '' } },
      { session },
    );
    if (result.matchedCount !== 1) throw new CanonicalDraftClaimConflict(projectId, 'claimed_by_another', `draft "${draft._id}" changed hands concurrently`);
    const released: CanonicalDraftDocument = { ...draft, status: 'available', updatedAt: now };
    delete released.claim;
    return { draft: released, replayed: false };
  });
}
