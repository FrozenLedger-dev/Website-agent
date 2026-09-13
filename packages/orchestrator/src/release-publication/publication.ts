/**
 * Durable, operator-reconciled release publication authority (Phase 5p).
 *
 * ## Why this exists
 *
 * `publishRelease` creates a production Vercel deployment. That is the one
 * irreversible side effect in the whole platform that leaves this machine, and
 * until now it had no durable authority at all: a crash between
 * `createDeployment` returning and the manifest being written left a live
 * production deployment recorded nowhere, and the next invocation would deploy
 * again.
 *
 * ## Why it is not fully automatic
 *
 * Phase 5h solves the identical problem for canonical Git promotion by writing
 * a receipt first and recognising its own marker afterwards. That works because
 * Git history can be *read back* to prove what happened. Vercel cannot:
 * `@vercel/sdk@1.28.17` exposes no idempotency key for deployment creation
 * (the string `idempoten` does not occur anywhere in the package), no
 * client-supplied deployment identity, and `GET /v7/deployments` has no
 * metadata filter — so "find the deployment for this release" is a scan whose
 * empty result proves nothing, least of all after a crash mid-request.
 *
 * So this module does not pretend. It guarantees something narrower and true:
 *
 *   once an external deployment attempt becomes ambiguous, automation stops,
 *   and only a trusted operator can decide what happens next.
 *
 * The receipt is written *before* the provider call, so a process that dies
 * one instruction later still leaves durable evidence that an attempt may have
 * reached Vercel. `publishing` is that evidence. It never expires, never
 * reverts, and is never retried automatically — `scripts/reconcile-release.ts`
 * is the only way out, by adopting one exact deployment the operator found, or
 * by authorising exactly one more attempt.
 *
 * Mongo and Vercel do not share a transaction, and nothing here implies they
 * do.
 */
import type { ArtifactRef } from '@statxai/contracts';
import type { ProjectWorkspace } from '@statxai/workspace';
import { contentHash, toProjectName } from '@statxai/workspace';
import type {
  ReleaseBuildAuthority,
  ReleaseDeploymentTarget,
  ReleasePublicationAttempt,
  ReleasePublicationDocument,
  StateStore,
} from '@statxai/state';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The one an ambiguous release produces, and the reason this phase exists.
 *
 * Thrown when publication reaches a receipt whose external outcome is not
 * durably known — either the attempt this invocation just made threw or came
 * back unverifiable, or an earlier invocation left `publishing` behind. Either
 * way this process refuses to call `createDeployment` again.
 */
export class ReleasePublicationReconciliationRequired extends Error {
  constructor(
    readonly releaseId: string,
    readonly projectId: string,
    readonly attempt: number,
    detail: string,
  ) {
    super(
      `Release ${releaseId} (project ${projectId}) has an unresolved deployment attempt ${attempt}: ${detail}. ` +
        `A production deployment may already exist. Reconcile it with "pnpm release:reconcile" — adopt the exact ` +
        `deployment, or authorise exactly one more attempt.`,
    );
    this.name = 'ReleasePublicationReconciliationRequired';
  }
}

/** A different unfinished release already owns publication authority here. */
export class ReleasePublicationConflict extends Error {
  constructor(readonly projectId: string, readonly holdingReleaseId: string, readonly requestedReleaseId: string) {
    super(
      `Project ${projectId} already has an unfinished release publication (${holdingReleaseId}); ` +
        `${requestedReleaseId} cannot publish alongside it`,
    );
    this.name = 'ReleasePublicationConflict';
  }
}

/**
 * This exact build lineage already owns a different release publication.
 *
 * Distinct from {@link ReleasePublicationConflict}, and not interchangeable
 * with it. That one is temporary — another release is *unfinished* and holds
 * the project's slot until it resolves. This one is permanent: a lineage
 * publishes once, and a committed receipt still counts, so waiting will never
 * clear it.
 */
export class ReleasePublicationLineageConflict extends Error {
  constructor(
    readonly projectId: string,
    readonly lineageRootBindingId: string,
    readonly existingReleaseId: string,
    readonly requestedReleaseId: string,
  ) {
    super(
      `Build lineage ${lineageRootBindingId} (project ${projectId}) already has release publication ` +
        `${existingReleaseId}; ${requestedReleaseId} would be a second release for the same lineage`,
    );
    this.name = 'ReleasePublicationLineageConflict';
  }
}

/**
 * A lineage-linked receipt does not describe the exact canonical build a
 * caller derived independently — same root, but a different binding or
 * promotion. Never accepted on the root alone.
 */
export class ReleasePublicationCanonicalBuildMismatch extends Error {
  constructor(readonly releaseId: string, detail: string) {
    super(`Release ${releaseId} does not publish the expected canonical build: ${detail}`);
    this.name = 'ReleasePublicationCanonicalBuildMismatch';
  }
}

/** The stored receipt disagrees with the authority this caller presented. */
export class ReleasePublicationBindingConflict extends Error {
  constructor(readonly releaseId: string, detail: string) {
    super(`Release ${releaseId} is already bound to different authority: ${detail}`);
    this.name = 'ReleasePublicationBindingConflict';
  }
}

/** Publishing would go somewhere other than where this release was prepared. */
export class ReleasePublicationTargetConflict extends Error {
  constructor(readonly releaseId: string, readonly expected: ReleaseDeploymentTarget, readonly actual: ReleaseDeploymentTarget) {
    super(
      `Release ${releaseId} was prepared for ${describeTarget(expected)} but this process is configured for ` +
        `${describeTarget(actual)} — an in-flight release is never migrated to another destination`,
    );
    this.name = 'ReleasePublicationTargetConflict';
  }
}

/** Canonical HEAD moved out from under a release that has not published yet. */
export class ReleasePublicationBaseConflict extends Error {
  constructor(readonly releaseId: string, readonly expected: string | null, readonly actual: string | null) {
    super(
      `Release ${releaseId} was authorised against canonical commit ${expected ?? '(empty repository)'} but HEAD is ` +
        `now ${actual ?? '(empty repository)'} and no release commit for it exists`,
    );
    this.name = 'ReleasePublicationBaseConflict';
  }
}

/** Git history contradicts itself about this release's publication commit. */
export class ReleasePublicationCommitCorrupt extends Error {
  constructor(readonly releaseId: string, detail: string) {
    super(`Release ${releaseId} canonical publication evidence is inconsistent: ${detail}`);
    this.name = 'ReleasePublicationCommitCorrupt';
  }
}

/** An operator action named an attempt that is no longer the current one. */
export class ReleasePublicationAttemptConflict extends Error {
  constructor(readonly releaseId: string, readonly requestedAttempt: number, readonly currentAttempt: number, readonly status: string) {
    super(
      `Release ${releaseId} is at attempt ${currentAttempt} (${status}); a reconciliation naming attempt ` +
        `${requestedAttempt} is stale and was refused`,
    );
    this.name = 'ReleasePublicationAttemptConflict';
  }
}

/** The deployment an operator offered is not this release's deployment. */
export class ReleasePublicationAdoptionConflict extends Error {
  constructor(readonly releaseId: string, readonly deploymentId: string, detail: string) {
    super(`Deployment ${deploymentId} cannot be adopted for release ${releaseId}: ${detail}`);
    this.name = 'ReleasePublicationAdoptionConflict';
  }
}

/** The release already has a durably known deployment. Nothing to reconcile. */
export class ReleasePublicationAlreadyCommitted extends Error {
  constructor(readonly releaseId: string, readonly deploymentId: string | null) {
    super(`Release ${releaseId} is already committed to deployment ${deploymentId ?? '(none recorded)'}`);
    this.name = 'ReleasePublicationAlreadyCommitted';
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The metadata key carrying the release identity on a Vercel deployment. */
export const RELEASE_METADATA_KEY = 'statxReleaseId';
/** The canonical revision the deployment was published from. Audit evidence. */
export const RELEASE_COMMIT_METADATA_KEY = 'statxReleaseCommit';

export interface ReleaseIdentityInput {
  readonly projectId: string;
  /** The exact `release-authorization` artifact this release publishes. */
  readonly releaseAuthorization: ArtifactRef;
}

/**
 * The deterministic identity of one logical release.
 *
 * Derived from the exact `release-authorization` artifact — the immutable,
 * versioned record of the harness's own decision to publish this revision.
 * That is the smallest authoritative input that is *stable across replay*: the
 * same authorisation always yields the same `releaseId`, and a genuinely new
 * authorisation (a later run, a later review cycle) yields a different one.
 *
 * Two things are deliberately **not** inputs.
 *
 * `baseCommit` is not, even though it is the revision being published. It is
 * canonical HEAD *before* this release's own publication commit, so including
 * it would make the identity unstable exactly when it is needed: after the
 * release commit exists, HEAD has moved, and a retry would derive a different
 * `releaseId` and fail to find its own receipt. The commit is bound durably
 * *in* the receipt instead, where it serves as drift authority (§15/§16).
 *
 * The deployment target is not, either — and that is a correctness decision,
 * not an omission. If the target were hashed in, changing `VERCEL_TEAM_ID`
 * mid-flight would mint a *different* release and silently publish it
 * somewhere else. Bound in the receipt, the same change is detected as drift
 * and fails closed.
 */
export function computeReleaseId(input: ReleaseIdentityInput): string {
  return contentHash({
    projectId: input.projectId,
    authorizationName: input.releaseAuthorization.name,
    authorizationVersion: input.releaseAuthorization.version,
    authorizationContentHash: input.releaseAuthorization.contentHash ?? null,
  });
}

/** The Git trailer proving a release-authorized commit belongs to a release. */
export function releaseMarker(releaseId: string): string {
  return `Statx-Release-Id: ${releaseId}`;
}

/** Phase 5h's commit-message shape, applied to release publication. */
export function releaseCommitMessage(releaseId: string): string {
  return `Harness: release-authorized revision\n\n${releaseMarker(releaseId)}`;
}

/**
 * Where this process is configured to publish, in non-secret terms.
 *
 * Read from the same environment `deploySite` itself reads, so the receipt
 * records the destination that would actually be used rather than a
 * description of it.
 */
export function resolveDeploymentTarget(projectId: string): ReleaseDeploymentTarget {
  return {
    project: toProjectName(projectId),
    team: process.env.VERCEL_TEAM_ID ?? null,
    environment: 'production',
  };
}

export function sameDeploymentTarget(a: ReleaseDeploymentTarget, b: ReleaseDeploymentTarget): boolean {
  return a.project === b.project && a.team === b.team && a.environment === b.environment;
}

function describeTarget(target: ReleaseDeploymentTarget): string {
  return `${target.project}@${target.team ?? 'personal'}/${target.environment}`;
}

function sameAuthorization(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.name === b.name && a.version === b.version && (a.contentHash ?? null) === (b.contentHash ?? null);
}

// ---------------------------------------------------------------------------
// Receipt lifecycle
// ---------------------------------------------------------------------------

export interface PrepareReleasePublicationInput {
  readonly releaseId: string;
  readonly projectId: string;
  readonly releaseAuthorization: ArtifactRef;
  readonly baseCommit: string | null;
  readonly deploymentTarget: ReleaseDeploymentTarget;
  /**
   * The exact canonical build being published. Supplied by every
   * `job_lifecycle` release, omitted by `legacy_direct`, never invented.
   * Deliberately not an input to `releaseId`: this is an association with a
   * release, not part of what the release is.
   */
  readonly buildAuthority?: ReleaseBuildAuthority;
  readonly now?: Date;
}

/**
 * Idempotent ensure/create of the durable release authority.
 *
 * Never a bare insert: two publishers can reach this at once, so the project's
 * one-active-publication slot is enforced by the partial unique index on
 * `{ projectId }` rather than by a check-then-write. A duplicate-key rejection
 * is re-read and classified — the same release converges on the same receipt,
 * a different one fails closed (§9/§11).
 */
export async function ensureReleasePublicationPrepared(
  store: StateStore,
  input: PrepareReleasePublicationInput,
): Promise<ReleasePublicationDocument> {
  const now = input.now ?? new Date();
  if (input.buildAuthority) assertCompleteBuildAuthority(input.releaseId, input.buildAuthority);

  const existing = await store.releasePublications.findOne({ _id: input.releaseId });
  if (existing) return assertMatchesRequest(existing, input);

  const document: ReleasePublicationDocument = {
    _id: input.releaseId,
    projectId: input.projectId,
    releaseAuthorization: input.releaseAuthorization,
    baseCommit: input.baseCommit,
    deploymentTarget: input.deploymentTarget,
    ...(input.buildAuthority
      ? {
          buildAuthority: {
            lineageRootBindingId: input.buildAuthority.lineageRootBindingId,
            canonicalBindingId: input.buildAuthority.canonicalBindingId,
            promotionId: input.buildAuthority.promotionId,
          },
        }
      : {}),
    status: 'prepared',
    active: true,
    releaseCommitSha: null,
    deploymentId: null,
    deploymentUrl: null,
    attempt: 0,
    attempts: [],
    preparedAt: now,
    committedAt: null,
    updatedAt: now,
  };

  try {
    await store.releasePublications.insertOne(document);
    return document;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;

    // Either this exact release was created concurrently — converge on it — or
    // another unfinished release holds the project's slot, which is a conflict
    // neither side may resolve by overwriting.
    const raced = await store.releasePublications.findOne({ _id: input.releaseId });
    if (raced) return assertMatchesRequest(raced, input);

    // Asked before the active slot: when this lineage already has a release,
    // that is the permanent fact, and reporting the temporary one instead
    // would tell a caller to wait for something that will never clear.
    if (input.buildAuthority) {
      const rival = await findReleasePublicationForLineage(
        store,
        input.projectId,
        input.buildAuthority.lineageRootBindingId,
      );
      if (rival) {
        throw new ReleasePublicationLineageConflict(
          input.projectId,
          input.buildAuthority.lineageRootBindingId,
          rival._id,
          input.releaseId,
        );
      }
    }

    const holder = await store.releasePublications.findOne({ projectId: input.projectId, active: true });
    throw new ReleasePublicationConflict(input.projectId, holder?._id ?? '(unknown)', input.releaseId);
  }
}

/**
 * The one release publication a build lineage owns, in whatever status it is
 * in — or `null`.
 *
 * One exact indexed read by lineage identity. Deliberately not filtered on
 * `active`: a receipt that committed and then lost its process before the
 * project finished is precisely the one a later reader must still find. Never
 * sorted, never "the newest release": the lineage index allows at most one.
 * Receipts without build authority are unreachable from here by construction,
 * so a historical or `legacy_direct` release can never be mistaken for it.
 */
export async function findReleasePublicationForLineage(
  store: StateStore,
  projectId: string,
  lineageRootBindingId: string,
): Promise<ReleasePublicationDocument | null> {
  return store.releasePublications.findOne({
    projectId,
    'buildAuthority.lineageRootBindingId': lineageRootBindingId,
  });
}

/**
 * Prove a lineage-linked receipt publishes exactly the canonical build a caller
 * derived for itself — root, binding and promotion all three.
 *
 * Matching the root alone is not enough: a lineage that moved on to a later
 * promoted build after this receipt was written shares the root and nothing
 * else, and this receipt is not publication authority for that later build.
 */
export function assertReceiptMatchesCanonicalBuild(
  receipt: ReleasePublicationDocument,
  expected: ReleaseBuildAuthority,
): void {
  const stored = receipt.buildAuthority;
  if (!stored) {
    throw new ReleasePublicationCanonicalBuildMismatch(receipt._id, 'the receipt records no build authority');
  }
  if (stored.lineageRootBindingId !== expected.lineageRootBindingId) {
    throw new ReleasePublicationCanonicalBuildMismatch(receipt._id, `lineage root is ${stored.lineageRootBindingId}, not ${expected.lineageRootBindingId}`);
  }
  if (stored.canonicalBindingId !== expected.canonicalBindingId) {
    throw new ReleasePublicationCanonicalBuildMismatch(receipt._id, `canonical binding is ${stored.canonicalBindingId}, not ${expected.canonicalBindingId}`);
  }
  if (stored.promotionId !== expected.promotionId) {
    throw new ReleasePublicationCanonicalBuildMismatch(receipt._id, `promotion is ${stored.promotionId}, not ${expected.promotionId}`);
  }
}

function assertCompleteBuildAuthority(releaseId: string, authority: ReleaseBuildAuthority): void {
  for (const key of ['lineageRootBindingId', 'canonicalBindingId', 'promotionId'] as const) {
    const value: unknown = authority[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new ReleasePublicationBindingConflict(releaseId, `build authority is incomplete: ${key} is missing`);
    }
  }
}

/**
 * Build authority is part of what a receipt is, including whether it has any.
 *
 * Checked in both directions: a linked receipt is never replayed by a caller
 * that forgot its build, and an unlinked historical receipt is never quietly
 * upgraded by a caller that now supplies one. Exported for the committed-replay
 * path, which reuses a receipt without re-preparing it.
 */
export function assertMatchingBuildAuthority(
  receipt: ReleasePublicationDocument,
  requested: ReleaseBuildAuthority | undefined,
): void {
  const stored = receipt.buildAuthority;
  if (!stored && !requested) return;
  if (!stored) {
    throw new ReleasePublicationBindingConflict(receipt._id, 'the receipt has no build authority, and one was presented');
  }
  if (!requested) {
    throw new ReleasePublicationBindingConflict(receipt._id, 'the receipt is bound to a build, and none was presented');
  }
  if (
    stored.lineageRootBindingId !== requested.lineageRootBindingId ||
    stored.canonicalBindingId !== requested.canonicalBindingId ||
    stored.promotionId !== requested.promotionId
  ) {
    throw new ReleasePublicationBindingConflict(receipt._id, 'a different canonical build (lineage, binding or promotion)');
  }
}

/**
 * The immutable bindings, re-proven before an existing receipt is trusted.
 *
 * A receipt is never edited to fit a new request: the authorisation, the
 * canonical base and the destination are what this release *is*.
 */
function assertMatchesRequest(
  receipt: ReleasePublicationDocument,
  input: PrepareReleasePublicationInput,
): ReleasePublicationDocument {
  if (receipt.projectId !== input.projectId) {
    throw new ReleasePublicationBindingConflict(receipt._id, `receipt belongs to project ${receipt.projectId}`);
  }
  if (!sameAuthorization(receipt.releaseAuthorization, input.releaseAuthorization)) {
    throw new ReleasePublicationBindingConflict(receipt._id, 'a different release-authorization artifact');
  }
  if (!sameDeploymentTarget(receipt.deploymentTarget, input.deploymentTarget)) {
    throw new ReleasePublicationTargetConflict(receipt._id, receipt.deploymentTarget, input.deploymentTarget);
  }
  assertMatchingBuildAuthority(receipt, input.buildAuthority);
  return receipt;
}

/**
 * Establish this release's canonical publication commit, replay-safely.
 *
 * Phase 5h's pattern exactly: the commit carries the release's own marker, so
 * a retry recognises the commit it already made instead of making a second
 * one. Zero markers means nothing was published yet — and then HEAD must still
 * be the commit this release was authorised against, or it fails closed rather
 * than publishing a revision nobody approved.
 *
 * A clean tree legitimately produces no commit at all (`commit` returns
 * `null`); the release then publishes `baseCommit` itself, and a retry
 * re-derives the same answer by the same route.
 */
export async function establishReleaseCommit(
  workspace: ProjectWorkspace,
  receipt: ReleasePublicationDocument,
): Promise<string | null> {
  const marker = releaseMarker(receipt._id);
  const found = await workspace.findCommitsByMarker(marker);

  if (found.length > 1) {
    throw new ReleasePublicationCommitCorrupt(receipt._id, `${found.length} commits carry this release's marker`);
  }
  if (found.length === 1) {
    const sha = found[0]!;
    if (receipt.releaseCommitSha !== null && receipt.releaseCommitSha !== sha) {
      throw new ReleasePublicationCommitCorrupt(
        receipt._id,
        'the recorded release commit is not the commit found under this release\'s marker',
      );
    }
    return sha;
  }

  // Nothing published yet. Anything that moved HEAD since authorisation —
  // another run, a manual commit — invalidates the approval this release was
  // granted on, so it stops here rather than adopting the new lineage.
  const head = await workspace.currentCommit();
  if (head !== receipt.baseCommit) {
    throw new ReleasePublicationBaseConflict(receipt._id, receipt.baseCommit, head);
  }

  return (await workspace.commit(releaseCommitMessage(receipt._id))) ?? receipt.baseCommit;
}

/**
 * `prepared | retry_authorized -> publishing`, and the last thing that happens
 * before Vercel is called.
 *
 * Guarded on the exact `(status, attempt)` pair the caller read, so two
 * publishers racing on one receipt produce exactly one attempt: the loser's
 * update matches nothing, re-reads, and finds `publishing` — which it must not
 * retry. That same CAS is what makes an operator's retry authorisation
 * single-use (§35/§41).
 */
export async function beginPublicationAttempt(
  store: StateStore,
  receipt: ReleasePublicationDocument,
  options: { readonly releaseCommitSha: string | null; readonly now?: Date },
): Promise<ReleasePublicationDocument> {
  if (receipt.status === 'committed') throw new ReleasePublicationAlreadyCommitted(receipt._id, receipt.deploymentId);
  if (receipt.status === 'publishing') {
    throw new ReleasePublicationReconciliationRequired(
      receipt._id,
      receipt.projectId,
      receipt.attempt,
      'an earlier attempt was already sent and its outcome is unknown',
    );
  }

  const now = options.now ?? new Date();
  const attempt = receipt.attempt + 1;
  const entry: ReleasePublicationAttempt = {
    attempt,
    startedAt: now,
    releaseCommitSha: options.releaseCommitSha,
    status: 'publishing',
  };

  const updated = await store.releasePublications.findOneAndUpdate(
    { _id: receipt._id, status: receipt.status, attempt: receipt.attempt },
    {
      $set: {
        status: 'publishing',
        attempt,
        releaseCommitSha: options.releaseCommitSha,
        updatedAt: now,
      },
      $push: { attempts: entry },
    },
    { returnDocument: 'after' },
  );

  if (updated) return updated;

  // Lost the race, or the receipt moved under us. Re-read and classify —
  // never assume, and never retry into an unknown external state.
  const current = await store.releasePublications.findOne({ _id: receipt._id });
  if (!current) throw new ReleasePublicationBindingConflict(receipt._id, 'receipt disappeared from durable state');
  if (current.status === 'committed') throw new ReleasePublicationAlreadyCommitted(current._id, current.deploymentId);
  throw new ReleasePublicationReconciliationRequired(
    current._id,
    current.projectId,
    current.attempt,
    `another publisher owns attempt ${current.attempt} (${current.status})`,
  );
}

/**
 * `publishing -> committed` for an attempt whose outcome is durably known.
 *
 * The only automatic exit from `publishing`, and it happens only when this
 * process holds the provider's own successful response in hand.
 */
export async function recordPublicationSuccess(
  store: StateStore,
  input: {
    readonly releaseId: string;
    readonly attempt: number;
    readonly deploymentId: string;
    readonly deploymentUrl: string;
    readonly now?: Date;
  },
): Promise<ReleasePublicationDocument> {
  const now = input.now ?? new Date();
  const updated = await store.releasePublications.findOneAndUpdate(
    { _id: input.releaseId, status: 'publishing', attempt: input.attempt },
    {
      $set: {
        status: 'committed',
        deploymentId: input.deploymentId,
        deploymentUrl: input.deploymentUrl,
        committedAt: now,
        updatedAt: now,
        'attempts.$[entry].status': 'succeeded',
        'attempts.$[entry].deploymentId': input.deploymentId,
        'attempts.$[entry].deploymentUrl': input.deploymentUrl,
        'attempts.$[entry].resolvedAt': now,
      },
      // The project's active slot is released only here and in adoption: a
      // finished release stops competing, its history stays.
      $unset: { active: '' },
    },
    { arrayFilters: [{ 'entry.attempt': input.attempt }], returnDocument: 'after' },
  );

  if (!updated) {
    const current = await store.releasePublications.findOne({ _id: input.releaseId });
    if (current?.status === 'committed') return current;
    throw new ReleasePublicationAttemptConflict(
      input.releaseId,
      input.attempt,
      current?.attempt ?? -1,
      current?.status ?? 'missing',
    );
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Operator reconciliation
// ---------------------------------------------------------------------------

/** What adoption needs from the provider. One exact id, never a search. */
export interface ReleaseDeploymentReader {
  getDeploymentById(deploymentId: string): Promise<{
    deploymentId: string;
    url: string;
    meta: Record<string, string>;
    project: string | null;
    target: string | null;
  }>;
}

export interface ReconcileReleaseInput {
  readonly projectId: string;
  readonly releaseId: string;
  /** The attempt the operator is resolving. Stale numbers are refused. */
  readonly attempt: number;
  readonly actor: string;
  readonly reason: string;
  readonly now?: Date;
}

/**
 * Operator action A — adopt one exact existing deployment as this release's
 * outcome.
 *
 * The operator supplies the id they found in the Vercel dashboard; the harness
 * then re-reads that exact deployment and refuses it unless the provider's own
 * record says it belongs to this release and this destination. An operator
 * cannot simply assert a URL into the receipt.
 *
 * This is a trusted, destructive authority: nothing here can prove the process
 * that started the ambiguous attempt is dead. The `(releaseId, attempt)` guard
 * is what stops a stale reconciliation from resolving a newer attempt.
 */
export async function adoptReleaseDeployment(
  store: StateStore,
  reader: ReleaseDeploymentReader,
  input: ReconcileReleaseInput & { readonly deploymentId: string },
): Promise<ReleasePublicationDocument> {
  const receipt = await loadReconcilableReceipt(store, input);

  const deployment = await reader.getDeploymentById(input.deploymentId);

  const marked = deployment.meta[RELEASE_METADATA_KEY] ?? null;
  if (marked !== receipt._id) {
    throw new ReleasePublicationAdoptionConflict(
      receipt._id,
      input.deploymentId,
      marked === null
        ? 'the deployment carries no release marker'
        : 'the deployment carries a different release marker',
    );
  }
  if (deployment.project !== null && deployment.project !== receipt.deploymentTarget.project) {
    throw new ReleasePublicationAdoptionConflict(receipt._id, input.deploymentId, 'it belongs to another Vercel project');
  }
  if (deployment.target !== null && deployment.target !== receipt.deploymentTarget.environment) {
    throw new ReleasePublicationAdoptionConflict(receipt._id, input.deploymentId, `it targets ${deployment.target}`);
  }
  const markedCommit = deployment.meta[RELEASE_COMMIT_METADATA_KEY] ?? null;
  if (markedCommit !== null && receipt.releaseCommitSha !== null && markedCommit !== receipt.releaseCommitSha) {
    throw new ReleasePublicationAdoptionConflict(receipt._id, input.deploymentId, 'it published a different revision');
  }

  const now = input.now ?? new Date();
  const updated = await store.releasePublications.findOneAndUpdate(
    { _id: receipt._id, status: 'publishing', attempt: input.attempt },
    {
      $set: {
        status: 'committed',
        deploymentId: deployment.deploymentId,
        deploymentUrl: deployment.url,
        committedAt: now,
        updatedAt: now,
        'attempts.$[entry].status': 'adopted',
        'attempts.$[entry].deploymentId': deployment.deploymentId,
        'attempts.$[entry].deploymentUrl': deployment.url,
        'attempts.$[entry].resolvedAt': now,
        'attempts.$[entry].resolution': { actor: input.actor, reason: input.reason },
      },
      $unset: { active: '' },
    },
    { arrayFilters: [{ 'entry.attempt': input.attempt }], returnDocument: 'after' },
  );

  if (!updated) {
    const current = await store.releasePublications.findOne({ _id: receipt._id });
    throw new ReleasePublicationAttemptConflict(
      receipt._id,
      input.attempt,
      current?.attempt ?? -1,
      current?.status ?? 'missing',
    );
  }
  return updated;
}

/**
 * Operator action B — authorise exactly one more external attempt.
 *
 * Deliberately not a flag. It is a one-shot transition that the publisher
 * consumes with the same `(status, attempt)` CAS everything else uses, so two
 * publishers cannot both spend one authorisation, and a second ambiguous
 * outcome needs a second human decision.
 *
 * The ambiguous attempt is never erased: it stays in `attempts` with the
 * operator's name and reason, because it may correspond to a real production
 * deployment that nobody has accounted for.
 */
export async function authorizeReleaseRepublication(
  store: StateStore,
  input: ReconcileReleaseInput,
): Promise<ReleasePublicationDocument> {
  const receipt = await loadReconcilableReceipt(store, input);
  const now = input.now ?? new Date();

  const updated = await store.releasePublications.findOneAndUpdate(
    { _id: receipt._id, status: 'publishing', attempt: input.attempt },
    {
      $set: {
        status: 'retry_authorized',
        updatedAt: now,
        'attempts.$[entry].status': 'retry_authorized',
        'attempts.$[entry].resolvedAt': now,
        'attempts.$[entry].resolution': { actor: input.actor, reason: input.reason },
      },
    },
    { arrayFilters: [{ 'entry.attempt': input.attempt }], returnDocument: 'after' },
  );

  if (!updated) {
    const current = await store.releasePublications.findOne({ _id: receipt._id });
    throw new ReleasePublicationAttemptConflict(
      receipt._id,
      input.attempt,
      current?.attempt ?? -1,
      current?.status ?? 'missing',
    );
  }
  return updated;
}

/**
 * The receipt an operator may act on: this project's, this release's, at this
 * exact attempt, and currently ambiguous.
 *
 * A committed release is not reconcilable — its outcome is already known, and
 * re-opening it would be how a second deployment gets made.
 */
async function loadReconcilableReceipt(
  store: StateStore,
  input: ReconcileReleaseInput,
): Promise<ReleasePublicationDocument> {
  const receipt = await store.releasePublications.findOne({ _id: input.releaseId });
  if (!receipt) {
    throw new ReleasePublicationBindingConflict(input.releaseId, 'no release publication exists under this id');
  }
  if (receipt.projectId !== input.projectId) {
    throw new ReleasePublicationBindingConflict(input.releaseId, `it belongs to project ${receipt.projectId}`);
  }
  if (receipt.status === 'committed') {
    throw new ReleasePublicationAlreadyCommitted(receipt._id, receipt.deploymentId);
  }
  if (receipt.status !== 'publishing' || receipt.attempt !== input.attempt) {
    throw new ReleasePublicationAttemptConflict(receipt._id, input.attempt, receipt.attempt, receipt.status);
  }
  return receipt;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}
