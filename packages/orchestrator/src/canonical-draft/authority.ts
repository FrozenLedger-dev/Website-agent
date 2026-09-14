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
 *
 * An operation that builds from the draft (a semantic edit) takes more than a
 * claim: in the same transaction the draft's own lineage root takes the active
 * slot back, and the project leaves `draft`. That handed-off draft stays current
 * and claimed while its operation runs, and is superseded — never rewritten —
 * when that operation concludes the next draft.
 */
import type { ClientSession } from 'mongodb';
import type { CanonicalDraftClaimant, CanonicalDraftDocument, FrontendBackendBuildBindingDocument, ProjectState, StateStore } from '@statxai/state';
import { FRONTEND_BACKEND_INPUT } from '../job-handlers/frontend-backend.js';
import { SiteExportSnapshotInvalid, contentHash, readSiteExportSnapshot, type ArtifactRegistry, type ProjectWorkspace } from '@statxai/workspace';
import type { ArtifactRef } from '@statxai/contracts';
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
  | 'claimed_by_another'
  /** The draft is handed to its operation's build lineage; it is released by that operation concluding, not by hand. */
  | 'handed_off';

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

/** The current draft is handed to an operation that is still building from it — neither concluded nor corrupt. */
export class CanonicalDraftInOperation extends Error {
  constructor(
    readonly projectId: string,
    readonly draftId: string,
    readonly claimant: CanonicalDraftClaimant,
  ) {
    super(`project "${projectId}": canonical draft "${draftId}" is handed to ${claimant.kind} operation "${claimant.operationId}"`);
    this.name = 'CanonicalDraftInOperation';
  }
}

/** The draft predates export snapshots: it has no exact preview, and nothing may stand in for one. */
export class CanonicalDraftExportUnavailable extends Error {
  constructor(
    readonly projectId: string,
    readonly draftId: string,
  ) {
    super(`project "${projectId}": canonical draft "${draftId}" records no site export snapshot, so it has no exact preview`);
    this.name = 'CanonicalDraftExportUnavailable';
  }
}

/** The exact export snapshot a draft names — or a typed refusal for a draft that names none. Never a fallback. */
export function requireCanonicalDraftExportSnapshot(draft: CanonicalDraftDocument): ArtifactRef {
  if (!draft.siteExportSnapshot) throw new CanonicalDraftExportUnavailable(draft.projectId, draft._id);
  return draft.siteExportSnapshot;
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

/** Operations that build from a draft, and so take its lineage back while they run. */
const HANDOFF_KINDS: ReadonlySet<CanonicalDraftClaimant['kind']> = new Set<CanonicalDraftClaimant['kind']>(['semantic_edit']);
/** The project states an operation building from a draft moves through. */
const HANDOFF_STATES: ReadonlySet<ProjectState> = new Set<ProjectState>(['building', 'validating']);

/**
 * Re-prove a draft handed to its operation: claimed by an operation that builds,
 * its own root holding the active slot again, the project in that operation's
 * build states, the draft's build still promoted by exactly its promotion, and
 * the lineage ending either at that build or at its one successor. No release
 * owns anything. Returns the structural tip.
 */
async function proveHandedOffDraft(store: StateStore, draft: CanonicalDraftDocument, options: Session): Promise<FrontendBackendBuildBindingDocument> {
  const { projectId } = draft;
  const corrupt = (detail: string) => new CanonicalDraftAuthorityCorrupt(projectId, detail);

  if (draft._id !== canonicalDraftId(draft)) throw corrupt(`draft "${draft._id}" does not carry the identity of the build it names`);
  let claimant: CanonicalDraftClaimant;
  try {
    claimant = parseCanonicalDraftClaimant(draft.claim);
  } catch (error) {
    throw corrupt(`handed-off draft "${draft._id}" records no valid claimant (${(error as Error).message})`);
  }
  if (draft.status !== 'claimed' || !HANDOFF_KINDS.has(claimant.kind)) throw corrupt(`draft "${draft._id}" is not handed to a building operation`);

  const root = await store.frontendBackendBuildBindings.findOne({ projectId, activeLineage: true }, sessionOf(options));
  if (!root) throw corrupt(`draft "${draft._id}" is handed off but no lineage is active`);
  if (root._id !== draft.lineageRootBindingId || root.lineageRootBindingId !== root._id) {
    throw corrupt(`the active lineage "${root._id}" is not draft "${draft._id}"'s own lineage "${draft.lineageRootBindingId}"`);
  }
  const tip = await tipFrom(() => deriveActiveLineageTip(store, root, options), corrupt);

  const build = tip._id === draft.canonicalBindingId ? tip : await store.frontendBackendBuildBindings.findOne({ _id: draft.canonicalBindingId, projectId }, sessionOf(options));
  if (!build) throw corrupt(`draft build "${draft.canonicalBindingId}" is missing`);
  if (build.lineageRootBindingId !== draft.lineageRootBindingId) throw corrupt(`build "${build._id}" belongs to lineage "${build.lineageRootBindingId ?? '(none)'}"`);
  await provePromotion(store, build, draft, options, corrupt);
  if (tip._id !== build._id && tip.predecessorBindingId !== build._id) {
    throw corrupt(`lineage "${root._id}" ends at "${tip._id}", which is neither draft build "${build._id}" nor its one successor`);
  }

  const owner = await releaseOwner(store, projectId, root._id, options);
  if (owner) throw corrupt(`${owner} owns the project alongside draft "${draft._id}"`);
  return tip;
}

/** Who a project's current draft answers to, fully re-proven. */
export type CanonicalDraftAuthority =
  /** Concluded: the project is `draft` and no lineage is active. Available, or claimed by an operation that has not started building. */
  | { readonly state: 'concluded'; readonly draft: CanonicalDraftDocument }
  /** Handed to the claiming operation, whose build lineage is active; `tip` is that lineage's structural tip. */
  | { readonly state: 'handed_off'; readonly draft: CanonicalDraftDocument; readonly tip: FrontendBackendBuildBindingDocument };

/**
 * The project's current canonical draft and who it answers to — or `null` when
 * the project has no current draft.
 *
 * `draft` state means a concluded draft; a building state with a claimed current
 * draft means a handed-off one. Anything else — a draft in any other state, a
 * `draft` project with no record, more than one current record — fails closed.
 */
export async function resolveCanonicalDraftAuthority(store: StateStore, projectId: string, options: Session = {}): Promise<CanonicalDraftAuthority | null> {
  const corrupt = (detail: string) => new CanonicalDraftAuthorityCorrupt(projectId, detail);
  // Sequential: operations sharing one transaction session must not run concurrently.
  const project = await store.projects.findOne({ _id: projectId }, sessionOf(options));
  const drafts = await store.canonicalDrafts.find({ projectId, current: true }, sessionOf(options)).limit(2).toArray();
  if (drafts.length > 1) throw corrupt('more than one current draft');
  const draft = drafts[0];
  if (!draft) {
    if (project?.state === 'draft') throw corrupt('the project is a concluded draft with no current draft record');
    return null;
  }
  if (project?.state === 'draft') {
    await proveDraft(store, draft, options);
    return { state: 'concluded', draft };
  }
  if (project && HANDOFF_STATES.has(project.state) && draft.status === 'claimed') {
    const tip = await proveHandedOffDraft(store, draft, options);
    return { state: 'handed_off', draft, tip };
  }
  throw corrupt(`draft "${draft._id}" is current but the project is ${project ? `"${project.state}"` : 'missing'}`);
}

/**
 * The project's current concluded canonical draft, fully re-proven — or `null`
 * when the project has no current draft. A draft handed to a running operation
 * is not concluded, and is reported as exactly that.
 */
export async function loadCurrentCanonicalDraft(store: StateStore, projectId: string, options: Session = {}): Promise<CanonicalDraftDocument | null> {
  const authority = await resolveCanonicalDraftAuthority(store, projectId, options);
  if (authority?.state === 'handed_off') throw new CanonicalDraftInOperation(projectId, authority.draft._id, authority.draft.claim!);
  return authority?.draft ?? null;
}

// ---------------------------------------------------------------------------
// Conclusion
// ---------------------------------------------------------------------------

/** A run concludes from a state it owns; anything terminal, parked or releasing is not its to conclude. */
const CONCLUDABLE: ReadonlySet<ProjectState> = new Set<ProjectState>(['planning', 'building', 'validating']);

export interface ConcludeCanonicalDraftInput {
  readonly store: StateStore;
  readonly registry: ArtifactRegistry;
  /**
   * The exact `site-export-snapshot` the concluding evaluation captured of this
   * build. Supplied by the caller from that evaluation, never looked up here, and
   * proven to be of exactly this build and promotion before it is recorded.
   */
  readonly siteExportSnapshot: ArtifactRef;
  readonly workspace: Pick<ProjectWorkspace, 'findCommitsByMarker'>;
  readonly projectId: string;
  /** The exact canonical build the concluding run holds, by id — re-read here. */
  readonly canonicalBindingId: string;
  /** The promotion the run holds for it. */
  readonly promotion: { readonly promotionId: string | null; readonly promotionCommitSha: string | null };
  /**
   * When the concluding lineage is an operation building from a handed-off
   * draft: that exact draft and its exact claimant. The new draft replaces it
   * as current in the same transaction; its build must be the one successor of
   * the superseded draft's build.
   */
  readonly supersede?: { readonly draftId: string; readonly claimant: CanonicalDraftClaimant };
  /**
   * The concluding operation's own completion, written inside the same
   * transaction — and called again, with `replayed`, when an exact replay finds
   * the draft already concluded. Must itself be exact and idempotent.
   */
  readonly completeInTransaction?: (session: ClientSession, draft: CanonicalDraftDocument, replayed: boolean) => Promise<void>;
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

  // The exact export snapshot, re-proven from its own stored bytes and manifest.
  let snapshot;
  try {
    snapshot = await readSiteExportSnapshot(input.registry, projectId, input.siteExportSnapshot);
  } catch (error) {
    if (error instanceof SiteExportSnapshotInvalid) throw refuse(error.message);
    throw error;
  }
  const snapshotRef: ArtifactRef = { name: input.siteExportSnapshot.name, version: input.siteExportSnapshot.version, contentHash: input.siteExportSnapshot.contentHash! };
  const sameSnapshotRef = (a: ArtifactRef | undefined) => a !== undefined && a.name === snapshotRef.name && a.version === snapshotRef.version && a.contentHash === snapshotRef.contentHash;

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
      if (!sameSnapshotRef(current.siteExportSnapshot)) {
        throw refuse(`draft "${draftId}" was concluded with a different site export snapshot`);
      }
      if (input.supersede) {
        const previous = await store.canonicalDrafts.findOne({ _id: input.supersede.draftId, projectId }, { session });
        if (!previous || previous.supersededByDraftId !== draftId || !sameClaimant(previous.claim, input.supersede.claimant)) {
          throw refuse(`draft "${draftId}" was not concluded by superseding "${input.supersede.draftId}"`);
        }
      }
      await input.completeInTransaction?.(session, current, true);
      return { draft: current, replayed: true };
    }
    if (!CONCLUDABLE.has(project.state)) throw refuse(`the project is "${project.state}"`);

    const root = await store.frontendBackendBuildBindings.findOne({ projectId, activeLineage: true }, { session });
    if (!root) throw refuse('no active build lineage owns the project');
    if (root._id !== binding.lineageRootBindingId) throw refuse(`build "${canonicalBindingId}" belongs to lineage "${binding.lineageRootBindingId}", not the active lineage "${root._id}"`);
    const tip = await tipFrom(() => deriveActiveLineageTip(store, root, { session }), refuse);
    if (tip._id !== canonicalBindingId) throw refuse(`the active lineage has advanced to "${tip._id}"; "${canonicalBindingId}" is not its tip`);
    await provePromotion(store, tip, { promotionId, promotionCommitSha }, { session }, refuse);

    // The snapshot is of exactly this build: its plan, its model, its build authority and promotion.
    const { subject } = snapshot;
    const pinnedModel = tip.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel] ?? null;
    const sameExact = (a: ArtifactRef | null, b: ArtifactRef | null) =>
      a === null || b === null ? a === b : a.name === b.name && a.version === b.version && a.contentHash === b.contentHash;
    if (
      subject.authority.mode !== 'job_lifecycle' ||
      subject.authority.buildBindingId !== canonicalBindingId ||
      subject.authority.promotionId !== promotionId ||
      subject.authority.promotionCommitSha !== promotionCommitSha
    ) {
      throw refuse(`site export snapshot ${snapshotRef.name}@${snapshotRef.version} was not exported by build "${canonicalBindingId}" at promotion "${promotionId}"`);
    }
    if (subject.sitePlan.name !== tip.sitePlan.name || subject.sitePlan.version !== tip.sitePlan.version) {
      throw refuse(`site export snapshot ${snapshotRef.name}@${snapshotRef.version} is of a different site plan than build "${canonicalBindingId}"`);
    }
    if (!sameExact(subject.editableSiteModel, pinnedModel)) {
      throw refuse(`site export snapshot ${snapshotRef.name}@${snapshotRef.version} carries a different editable site model than build "${canonicalBindingId}" pins`);
    }

    const owner = await releaseOwner(store, projectId, root._id, { session });
    if (owner) throw refuse(`${owner} already owns continuation`);
    if (await store.canonicalDrafts.findOne({ _id: draftId }, { session })) throw refuse(`draft "${draftId}" already exists while a lineage is active`);
    const existing = await store.canonicalDrafts.findOne({ projectId, current: true }, { session });
    const now = new Date();

    if (input.supersede) {
      // Only the exact handed-off draft, by its exact claimant, one generation back.
      const claimant = parseCanonicalDraftClaimant(input.supersede.claimant);
      const authority = await resolveCanonicalDraftAuthority(store, projectId, { session });
      if (
        !existing ||
        authority?.state !== 'handed_off' ||
        authority.draft._id !== existing._id ||
        existing._id !== input.supersede.draftId ||
        !sameClaimant(existing.claim, claimant) ||
        existing.lineageRootBindingId !== root._id ||
        tip.predecessorBindingId !== existing.canonicalBindingId
      ) {
        throw refuse(`build "${canonicalBindingId}" does not conclude the draft "${input.supersede.draftId}" handed to ${claimant.kind} operation "${claimant.operationId}"`);
      }
      const superseded = await store.canonicalDrafts.updateOne(
        { _id: existing._id, projectId, current: true, status: 'claimed', 'claim.kind': claimant.kind, 'claim.operationId': claimant.operationId },
        { $unset: { current: '' }, $set: { supersededByDraftId: draftId, updatedAt: now } },
        { session },
      );
      if (superseded.matchedCount !== 1) throw refuse(`draft "${existing._id}" changed during conclusion`);
    } else if (existing) {
      throw refuse(`draft "${existing._id}" already exists while a lineage is active`);
    }

    const draft: CanonicalDraftDocument = { _id: draftId, ...identity, promotionCommitSha, siteExportSnapshot: snapshotRef, status: 'available', current: true, createdAt: now, updatedAt: now };
    await store.canonicalDrafts.insertOne(draft, { session });

    const moved = await store.projects.updateOne({ _id: projectId, state: project.state }, { $set: { state: 'draft', updatedAt: now } }, { session });
    if (moved.matchedCount !== 1) throw refuse('the project state moved during conclusion');
    const released = await store.frontendBackendBuildBindings.updateOne(
      { _id: root._id, projectId, activeLineage: true },
      { $unset: { activeLineage: '' }, $set: { updatedAt: now } },
      { session },
    );
    if (released.matchedCount !== 1) throw refuse(`lineage "${root._id}" released its active slot during conclusion`);

    await input.completeInTransaction?.(session, draft, false);
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

async function currentForClaim(store: StateStore, input: Omit<ClaimCanonicalDraftInput, 'claimant'>, session: ClientSession): Promise<CanonicalDraftAuthority> {
  const { projectId } = input;
  const authority = await resolveCanonicalDraftAuthority(store, projectId, { session });
  if (!authority) throw new CanonicalDraftClaimConflict(projectId, 'no_current_draft', 'the project has no current canonical draft');
  const { draft } = authority;
  if (draft._id !== input.expectedDraftId) throw new CanonicalDraftClaimConflict(projectId, 'stale_draft', `the current draft is "${draft._id}", not "${input.expectedDraftId}"`);
  if (draft.canonicalBindingId !== input.expectedCanonicalBindingId) {
    throw new CanonicalDraftClaimConflict(projectId, 'stale_tip', `draft "${draft._id}" owns build "${draft.canonicalBindingId}", not "${input.expectedCanonicalBindingId}"`);
  }
  return authority;
}

/** The claim itself, inside the caller's transaction: exact draft, exact build, available — or this very claimant already. */
async function claimInSession(store: StateStore, input: ClaimCanonicalDraftInput, claimant: CanonicalDraftClaimant, session: ClientSession): Promise<CanonicalDraftClaim & { readonly authority: CanonicalDraftAuthority }> {
  const { projectId } = input;
  const authority = await currentForClaim(store, input, session);
  const { draft } = authority;
  if (draft.status === 'claimed') {
    if (sameClaimant(draft.claim, claimant)) return { draft, replayed: true, authority };
    throw new CanonicalDraftClaimConflict(projectId, 'claimed_by_another', `draft "${draft._id}" is held by another ${draft.claim?.kind ?? ''} operation`.trim());
  }

  const now = new Date();
  const result = await store.canonicalDrafts.updateOne(
    { _id: draft._id, projectId, current: true, status: 'available', canonicalBindingId: input.expectedCanonicalBindingId },
    { $set: { status: 'claimed', claim: { kind: claimant.kind, operationId: claimant.operationId }, updatedAt: now } },
    { session },
  );
  if (result.matchedCount !== 1) throw new CanonicalDraftClaimConflict(projectId, 'claimed_by_another', `draft "${draft._id}" was claimed concurrently`);
  return { draft: { ...draft, status: 'claimed', claim: claimant, updatedAt: now }, replayed: false, authority };
}

/**
 * Reserve the exact current draft for one operation — only if it is still that
 * draft, still owns that build, and is available. The same claimant replaying
 * gets its claim back; any other claimant is refused. Nothing else happens.
 */
export async function claimCanonicalDraft(input: ClaimCanonicalDraftInput): Promise<CanonicalDraftClaim> {
  const claimant = parseCanonicalDraftClaimant(input.claimant);
  return input.store.withTransaction(async (session) => {
    const { draft, replayed } = await claimInSession(input.store, input, claimant, session);
    return { draft, replayed };
  });
}

/**
 * Claim the exact current draft for an operation that builds from it, and hand
 * that operation the draft's own lineage — inside the caller's transaction, so
 * whatever the operation records alongside (its intent, its inputs) is one
 * atomic fact with the claim.
 *
 * Writes, each conditional and counted: the claim; the draft's own root taking
 * the active-lineage slot back (never a new root, and never while another
 * lineage holds it); the project leaving `draft` for `building`. There is never
 * a moment with the draft claimed and nothing owning continuation, or with a
 * run able to discover over it. The same claimant replaying after the handoff
 * gets it back unchanged.
 */
export async function handOffCanonicalDraft(input: ClaimCanonicalDraftInput, session: ClientSession): Promise<CanonicalDraftClaim> {
  const { store, projectId } = input;
  const claimant = parseCanonicalDraftClaimant(input.claimant);
  if (!HANDOFF_KINDS.has(claimant.kind)) throw new CanonicalDraftClaimantInvalid(`a ${claimant.kind} operation does not build from a draft`);

  const { draft, replayed, authority } = await claimInSession(store, input, claimant, session);
  if (authority.state === 'handed_off') return { draft, replayed: true };

  const now = new Date();
  const reactivated = await store.frontendBackendBuildBindings.updateOne(
    { _id: draft.lineageRootBindingId, projectId, lineageRootBindingId: draft.lineageRootBindingId, activeLineage: { $exists: false } },
    { $set: { activeLineage: true, updatedAt: now } },
    { session },
  );
  if (reactivated.matchedCount !== 1) throw new CanonicalDraftClaimConflict(projectId, 'handed_off', `lineage "${draft.lineageRootBindingId}" could not take the active slot back`);
  const moved = await store.projects.updateOne({ _id: projectId, state: 'draft' }, { $set: { state: 'building', updatedAt: now } }, { session });
  if (moved.matchedCount !== 1) throw new CanonicalDraftClaimConflict(projectId, 'handed_off', 'the project left draft during the handoff');
  return { draft, replayed };
}

/**
 * Hand the draft back, by the operation that holds it — never by time, and
 * never by anyone else. Releasing an already-available draft changes nothing.
 */
export async function releaseCanonicalDraftClaim(input: ClaimCanonicalDraftInput): Promise<CanonicalDraftClaim> {
  const { store, projectId } = input;
  const claimant = parseCanonicalDraftClaimant(input.claimant);

  return store.withTransaction(async (session) => {
    const authority = await currentForClaim(store, input, session);
    const { draft } = authority;
    if (authority.state === 'handed_off') {
      throw new CanonicalDraftClaimConflict(projectId, 'handed_off', `draft "${draft._id}" is handed to its operation's build lineage and is released only by that operation concluding`);
    }
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
