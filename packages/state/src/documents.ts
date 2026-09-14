/**
 * Persisted document shapes.
 *
 * These are the platform's own state — the half of the system the model never
 * authors and cannot influence (Appendix B: "state belongs to the platform,
 * reasoning belongs to the model").
 */
import type { ArtifactRef, AutonomyMode, JobRecord, JobSpec, ReviewOutcomeRecord, SemanticEditSuccessorProvenance, SemanticPatch, VisualRefinementSuccessorProvenance, WorkerRole } from '@statxai/contracts';
import type { Binary } from 'mongodb';

/** Project lifecycle, distinct from job lifecycle. */
export type ProjectState =
  | 'intake'
  /**
   * Terminal. Intake did not meet the minimum business-profile bar, so the
   * project never reaches Build. Kept separate from `blocked` because the
   * remedy is different: `blocked` needs an engineering or policy decision,
   * this needs more information from the client.
   */
  | 'intake_insufficient'
  | 'planning'
  | 'building'
  | 'validating'
  | 'awaiting_human_review'
  /**
   * Concluded and unreleased. The run that built the canonical build is over,
   * no build lineage owns continuation, and exactly one current
   * {@link CanonicalDraftDocument} names the exact promoted build the canonical
   * tree implements. Never resumed, re-evaluated or replaced by a fresh run on
   * its own: only an explicit claim on that draft may continue from it.
   */
  | 'draft'
  | 'releasing'
  | 'released'
  | 'blocked'
  | 'rolled_back';

export interface ProjectDocument {
  _id: string;
  state: ProjectState;
  autonomyMode: AutonomyMode;
  /** Monotonic counter; increments on every completed review cycle. */
  reviewCycle: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A job document is its contract record plus the routing keys Mongo indexes. */
export interface JobDocument extends JobRecord {
  _id: string;
  projectId: string;
  role: WorkerRole;
}

/**
 * Project-level execution budgets (v1.2 §7).
 *
 * `limits` is per-project rather than global: §7 states these are starting
 * defaults, that Sol may lower them for high-risk projects, and that budget
 * changes are themselves recorded as project decisions.
 */
export interface BudgetLimits {
  reviewRejections: number;
  repairsPerDefect: number;
  totalRepairJobs: number;
  fullRebuilds: number;
  replans: number;
  failedDeployments: number;
  /**
   * Terra visual refinements of the canonical build. Optional because a budget
   * written before visual refinement existed has no such key — and a guarded
   * spend against a missing limit matches nothing, so such a project is simply
   * never refined. No backfill.
   */
  visualRefinements?: number;
}

export interface BudgetUsage {
  reviewRejections: number;
  totalRepairJobs: number;
  fullRebuilds: number;
  replans: number;
  failedDeployments: number;
  /** See {@link BudgetLimits.visualRefinements}. */
  visualRefinements?: number;
}

export interface BudgetDocument {
  _id: string;
  limits: BudgetLimits;
  used: BudgetUsage;
  updatedAt: Date;
}

/**
 * Per-defect repair counter, keyed by fingerprint.
 *
 * Held in its own collection rather than as a map inside BudgetDocument so the
 * "repairs for this defect" and "repairs for this project" guards can each be a
 * single conditional update inside one transaction.
 */
export interface DefectBudgetDocument {
  _id: string;
  projectId: string;
  fingerprint: string;
  repairsUsed: number;
  firstSeenCycle: number;
  updatedAt: Date;
}

export function defectBudgetId(projectId: string, fingerprint: string): string {
  return `${projectId}:${fingerprint}`;
}

/** Stored artifact version. Immutable once written (Appendix B). */
export interface ArtifactDocument {
  _id: string;
  projectId: string;
  name: string;
  version: number;
  contentHash: string;
  data: unknown;
  /** Set when Sol accepts this version as an input for downstream work. */
  acceptedAt: Date | null;
  /**
   * Where this artifact sits in the project's persisted lineage.
   *
   * `version` is monotonic within one *name* — `site-plan@1`, `site-plan@2` —
   * and says nothing about whether the plan was written before or after the
   * route decision that followed it. This is monotonic across every artifact
   * the project has, allocated atomically by the store, and is the authority
   * for that question.
   *
   * Optional only because artifacts written before it existed do not have one.
   * Everything `ArtifactRegistry.put` writes does.
   */
  lineageSeq?: number;
  /**
   * When the artifact was recorded. Observational metadata, deliberately not
   * the ordering authority: it has millisecond resolution, and two writes in
   * the same millisecond are indistinguishable by it. Use {@link lineageSeq}
   * to ask what came before what.
   */
  createdAt: Date;
}

/**
 * The per-project artifact lineage counter.
 *
 * Its own collection rather than a field on `ProjectDocument`, because a run
 * deletes and recreates the project record at startup and artifact history
 * outlives that: a counter living there would reset, and the second run's
 * artifacts would claim to precede the first run's.
 *
 * `_id` is the project id, so Mongo's own `_id` uniqueness gives exactly one
 * counter per project with no extra index.
 */
export interface ArtifactSequenceDocument {
  _id: string;
  lastAllocated: number;
  updatedAt: Date;
}

export function artifactId(projectId: string, name: string, version: number): string {
  return `${projectId}:${name}@${version}`;
}

export interface ReviewDocument extends ReviewOutcomeRecord {
  _id: string;
}

/**
 * Append-only audit trail (§9). Records every sensitive tool call, approval,
 * release and budget decision.
 */
export interface AuditEvent {
  _id?: never;
  projectId: string;
  jobId: string | null;
  kind:
    | 'job_transition'
    | 'budget_spend'
    | 'budget_exhausted'
    | 'tool_call'
    | 'tool_denied'
    | 'artifact_accepted'
    | 'review_recorded'
    | 'release_decision';
  actor: string;
  detail: Record<string, unknown>;
  at: Date;
}

export type JobPromotionStatus = 'prepared' | 'committed';

/**
 * Durable receipt for one canonical promotion of an accepted job's exact
 * execution output (Phase 5h).
 *
 * `_id` is the deterministic promotion identity: the same accepted
 * execution (project, job, attempt, exact candidate ref) always derives the
 * same one, so a retry after any crash — mid-write, after the canonical Git
 * commit but before this record is finalized, or long after — finds and
 * resumes this exact record rather than ever creating a second one. This is
 * the durable half of promotion's replay safety; the other half is the
 * machine-readable marker Phase 5h writes into the promotion commit itself,
 * since a crash between the Git commit succeeding and this record being
 * finalized means Mongo alone cannot yet know the commit happened at all —
 * only the commit can prove that on the next attempt.
 *
 * `status` only ever moves `prepared -> committed`, once, by whichever
 * caller's retry is first to either create the canonical commit or discover
 * one already exists. There is no `promoted` `JobState`: acceptance and
 * canonical promotion are separate lifecycle dimensions, and this record —
 * not `JobDocument` — is where promotion's own state lives.
 */
export interface JobPromotionRecord {
  _id: string;
  projectId: string;
  jobId: string;
  attempt: number;
  output: ArtifactRef;
  /**
   * The canonical workspace commit this promotion was prepared against —
   * `null` when the workspace had no commit at all yet (a legitimate first
   * build, not a placeholder). Before applying a still-`prepared` promotion,
   * current canonical HEAD must still equal this, or promotion fails closed
   * rather than silently building on an unexpected lineage.
   */
  baseCommit: string | null;
  status: JobPromotionStatus;
  /** Set only once, the moment the canonical promotion commit is known — created by this attempt, or discovered already there. */
  commitSha: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FrontendBackendBuildBindingStatus = 'prepared' | 'promoted' | 'abandoned';

/**
 * The durable record that lets a fresh `runProject` invocation (Phase 5k)
 * resume an incomplete `frontend_backend` job-mode build after a restart,
 * rather than starting discovery/planning again and producing a different
 * `businessProfile`/`sitePlan` version — and therefore a different
 * deterministic `JobSpec`/`jobId` — for a build Phase 5i may already be
 * partway through.
 *
 * `_id` is deterministic (see `computeBindingId`,
 * `run-binding/frontend-backend.ts`), so a second fresh invocation for the
 * same logical request always derives the same record rather than ever
 * creating a second one. `jobSpec` is stored in full, not only as a hash: a
 * future code deployment could change the factory's defaults (objective
 * wording, `allowedTools`, output conventions), and reconstructing the spec
 * from new code on resume could silently address a different request than
 * the one Phase 5i is actually partway through executing. The stored spec
 * is authoritative for resume; `jobSpecHash` is an integrity/indexing aid,
 * never a substitute for it.
 *
 * `status` moves `prepared -> promoted` exactly once, the moment Phase 5i
 * returns `promoted` — mirroring `JobPromotionRecord`'s own
 * `prepared -> committed` shape — or `prepared -> abandoned` exactly once,
 * the moment an operator explicitly revokes an incomplete build (Phase 5m,
 * `run-binding/frontend-backend.ts`'s `abandonFrontendBackendBuild`). Both
 * `promoted` and `abandoned` are retained as historical control-plane
 * evidence, never deleted, and neither occupies the project's
 * one-active-binding slot (see the partial unique index on `{ projectId }`
 * in `StateStore.ensureIndexes`, filtered to `status: 'prepared'`), so a
 * later, genuinely new build generation — or, after `abandoned`, a
 * `legacy_direct` rollback — is free to proceed for the same project as far
 * as *that* slot is concerned. Whether one may actually start is a separate
 * question, answered by {@link FrontendBackendBuildBindingDocument.activeLineage}:
 * a promoted build whose outer run has not reached a durable terminal state
 * still owns the project's continuation authority.
 */
export interface FrontendBackendBuildBindingDocument {
  _id: string;
  projectId: string;
  status: FrontendBackendBuildBindingStatus;
  /** Identifies the logical request this binding answers — see `computeRunIntentHash`. */
  runIntentHash: string;
  businessProfile: ArtifactRef;
  sitePlan: ArtifactRef;
  /** The exact immutable request Phase 5i must resume — authoritative on resume, never reconstructed from current code. */
  jobSpec: JobSpec;
  jobSpecHash: string;
  jobId: string;
  /** Canonical HEAD at the moment this binding was prepared, before its specification commit — `null` for a project's first-ever commit. */
  specificationBaseCommit: string | null;
  /** Set once the specification commit is known to exist — created by this invocation, or discovered already there via its marker. */
  specificationCommitSha: string | null;
  /** Set only once `status` becomes `promoted`, from Phase 5i/5h's own returned values. */
  promotionId: string | null;
  promotionCommitSha: string | null;
  /**
   * The exact canonical build this one replaces (Phase 5q0), and — in exactly
   * one of the two reason fields below — why it replaces it.
   *
   * Absent, with no reason, on an initial build — there is nothing to replace
   * — and present, with exactly one reason, on every successor. That makes canonical build authority an explicit chain (`B0 -> B1 -> B2`)
   * rather than something a later reader has to infer from timestamps or by
   * picking the newest promoted binding, both of which are wrong the moment
   * two generations exist for one project.
   *
   * Optional rather than `| null`-defaulted, for the same reason the
   * abandonment fields below are: a binding written before Phase 5q0 simply
   * has neither key, which is a valid historical initial build and not a
   * document awaiting migration. Absent therefore means "initial or legacy",
   * never "successor whose lineage was lost".
   *
   * Immutable once written: a successor is defined by what it replaces.
   */
  predecessorBindingId?: string;
  /**
   * How a replan successor records its reason — the original encoding, still
   * written for every replan successor, so historical and new replan bindings
   * have one identical shape and none needs migrating.
   */
  replanDecision?: ArtifactRef;
  /**
   * How a visual-refinement successor records its reason: the exact review,
   * screenshot set and cycle. Never present alongside `replanDecision`, and
   * never on a root. Read only through the build-lineage reader, which turns
   * either encoding into one typed `BuildSuccessorProvenance` and refuses any
   * document that holds both, neither, or a malformed one.
   */
  successorProvenance?: VisualRefinementSuccessorProvenance | SemanticEditSuccessorProvenance;
  /**
   * The exact root of the build lineage this binding belongs to.
   *
   * An initial build is its own root (`lineageRootBindingId === _id`), and
   * every replan successor carries the exact same value its predecessor
   * carries — so a whole chain (`B0 -> B1 -> B2`) names one root that no
   * reader has to walk backwards, sort, or infer to find.
   *
   * Immutable once written: which lineage a build belongs to is not a fact
   * that can later change.
   *
   * Optional for the same reason the two lineage fields above are: a binding
   * written before this existed simply has no key, which is readable history
   * rather than a document awaiting migration. Absent means "legacy, root
   * unproven" — never "root lost", and never an invitation to guess one from
   * creation order.
   */
  lineageRootBindingId?: string;
  /**
   * Present only on the ROOT binding of the lineage that currently owns this
   * project's unfinished continuation authority, and absent everywhere else —
   * including on every successor in that same lineage.
   *
   * This is the project's one-active-lineage slot: the partial unique index on
   * `{ projectId }` in `StateStore.ensureIndexes` is filtered on it, exactly
   * as `ReleasePublicationDocument.active` is. A separate field rather than a
   * filter on `status`, because a lineage stays active *across* statuses: it
   * is acquired when the root is prepared, survives the root's promotion and
   * every successor's, and continues through evaluation, repair, replan,
   * approval and publication.
   *
   * Scoped to unfinished work, never to project history. Released only when
   * the outer project reaches a durable semantic terminal state — never
   * because a process died or a build failed to promote — after which the
   * whole lineage remains durable, readable history and a later legitimate
   * fresh generation may acquire the slot.
   */
  activeLineage?: true;
  /**
   * How the run this lineage answers ends when it succeeds — recorded on the
   * ROOT binding only, at preparation, before any build work, and never changed.
   * Present only as `draft`; absent means `release`, which is what every binding
   * written before this existed means. Recovery reads it here rather than from
   * the caller, the environment or the project's state.
   */
  completionTarget?: 'draft';
  /**
   * Operator evidence, set only once `status` becomes `abandoned` (Phase
   * 5m) — all three together, never individually. Optional, not
   * `| null`-defaulted: a binding written before Phase 5m existed simply
   * has none of the three fields present at all, which is a normal, valid
   * `prepared`/`promoted` document rather than one needing a migration.
   */
  abandonedAt?: Date;
  abandonedBy?: string;
  abandonmentReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Visual refinement intent
// ---------------------------------------------------------------------------

/**
 * The durable authorisation of one Terra visual refinement of one exact
 * canonical build.
 *
 * `_id` is deterministic from the project and the predecessor build, and a
 * predecessor can be refined at most once (it has one successor slot, forever),
 * so this collection is itself the replay ledger: the record, the budget spend
 * that authorised it and the exact source snapshot it pins are written in one
 * transaction, before any model is invoked. A retry after any crash finds this
 * record and reuses it — the same source, the same job, no second spend —
 * rather than authorising again from whatever a fresh evaluation says.
 *
 * Immutable once written. What became of the attempt is not recorded here: the
 * successor binding, its job and its promotion receipt already say that.
 */
export interface VisualRefinementIntentDocument {
  _id: string;
  projectId: string;
  /** The root of the build lineage the predecessor belongs to. */
  lineageRootBindingId: string;
  /** The exact promoted canonical build being refined. */
  predecessorBindingId: string;
  /** The exact review and screenshot set that authorised it. */
  visualQualityReview: ArtifactRef;
  screenshotSet: ArtifactRef;
  refinementCycle: number;
  /** The eligibility policy the decision was made under. */
  policyVersion: string;
  /** The canonical commit the source was read at, and the exact snapshot. */
  sourceCommit: string;
  source: ArtifactRef;
  /** The deterministic job and successor binding this intent is answered by. */
  jobId: string;
  jobSpec: JobSpec;
  successorBindingId: string;
  /** The budget spend this intent consumed: `used.visualRefinements` after it. */
  budgetSlot: number;
  authorizedAt: Date;
}

// ---------------------------------------------------------------------------
// Canonical draft authority
// ---------------------------------------------------------------------------

/**
 * Which kind of operation holds a claim on a canonical draft. A typed category,
 * never a person: who asked for the operation is that operation's own record.
 */
export type CanonicalDraftClaimKind = 'semantic_edit' | 'release';

/**
 * The exact operation holding a draft. Non-secret by construction — a kind and
 * the operation's own deterministic id — so no session, token or credential
 * ever becomes part of project authority.
 */
export interface CanonicalDraftClaimant {
  kind: CanonicalDraftClaimKind;
  operationId: string;
}

/**
 * A concluded, unreleased canonical draft: the one authority over what happens
 * next to a project whose run ended without releasing.
 *
 * It replaces the build lineage's `activeLineage` ownership rather than
 * coexisting with it — both are written in one transaction, together with the
 * project's `draft` state — and it names the exact build it owns: the lineage
 * root the tip is re-derived from structurally, the tip itself, and that tip's
 * one promotion. Nothing else is copied: plan, model and profile are the
 * binding's own exact refs.
 *
 * `_id` is deterministic from exactly that authority, so concluding the same
 * build again converges on the same document. A later draft of the same project
 * is a different document; this one is never rewritten to describe another build.
 */
export interface CanonicalDraftDocument {
  _id: string;
  projectId: string;
  lineageRootBindingId: string;
  canonicalBindingId: string;
  promotionId: string;
  promotionCommitSha: string;
  /**
   * The exact immutable `site-export-snapshot` of the build this draft owns —
   * what a preview of this draft serves, and nothing else ever. Absent only on
   * drafts concluded before snapshots existed: those have no exact preview, and
   * nothing substitutes the mutable export for one.
   */
  siteExportSnapshot?: ArtifactRef;
  /**
   * `available` until one exact operation claims it; a claim is durable, never
   * expires, and moves only by its own claimant's explicit release.
   */
  status: 'available' | 'claimed';
  /** Present exactly while `status` is `claimed`. */
  claim?: CanonicalDraftClaimant;
  /**
   * Present only on the project's one current draft — the partial unique index
   * on `{ projectId }` is filtered on it, the same slot shape as
   * `activeLineage` and `ReleasePublicationDocument.active`.
   */
  current?: true;
  /**
   * Set exactly when this draft stops being current because the operation that
   * claimed it concluded the next draft — written in that same transaction.
   * The claim is kept as it was: history of who took this draft forward.
   */
  supersededByDraftId?: string;
  /** Metadata only — never consulted to decide anything. */
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Where one semantic edit stands. Forward only:
 *
 *   building  — the draft is claimed, its lineage handed to this edit, the
 *               result model and source snapshot recorded, the job fixed;
 *   promoted  — the successor build promoted;
 *   evaluated — that exact build was freshly evaluated, evidence recorded;
 *   completed — the successor concluded as the new current draft.
 *
 * A lifecycle stop (validation failure, a retry, a model failure) is not a
 * status: the edit stays `building`, its claim and job durable, and replaying
 * the same edit resumes exactly that job.
 */
export type SemanticEditIntentStatus = 'building' | 'promoted' | 'evaluated' | 'completed';

/**
 * The durable authority for one semantic edit of one exact canonical draft.
 *
 * `_id` is deterministic from the draft, its build, the base model and the
 * patch, so the same edit always resolves to the same intent, model version,
 * source snapshot, job and successor. At most one edit per draft, ever — the
 * draft's claim and a unique index say so together.
 */
export interface SemanticEditIntentDocument {
  _id: string;
  projectId: string;
  /** The exact draft claimed, its lineage and the build it owns. */
  sourceDraftId: string;
  lineageRootBindingId: string;
  predecessorBindingId: string;
  /** The model the predecessor build carries, and the model this edit implements. */
  baseEditableSiteModel: ArtifactRef;
  editableSiteModel: ArtifactRef;
  /** The exact patch, and its content digest (part of the intent's identity). */
  patch: SemanticPatch;
  patchDigest: string;
  /** The canonical commit the source was read at, and the exact snapshot. */
  sourceCommit: string;
  source: ArtifactRef;
  /** The deterministic job and successor binding this intent is answered by. */
  jobId: string;
  jobSpec: JobSpec;
  successorBindingId: string;
  /** Audit only, when a trusted caller supplied it — never authority, never a session or token. */
  requestedBy?: { customerUserId: string };
  status: SemanticEditIntentStatus;
  /** Set from `promoted`. */
  promotion?: { promotionId: string; promotionCommitSha: string };
  /** Set from `evaluated`: the exact evidence the successor build's fresh evaluation wrote. */
  evaluation?: {
    testReport: ArtifactRef;
    /** The exact immutable export snapshot of the successor — what its draft will name. */
    siteExportSnapshot: ArtifactRef;
    screenshotSet: ArtifactRef | null;
    visualQualityReview: ArtifactRef | null;
    gatesPassed: boolean;
    qualityScore: number;
  };
  /** Set at `completed`: the draft this edit concluded. */
  resultDraftId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Customer identity and tenancy
// ---------------------------------------------------------------------------
//
// A separate authority from the operator console: nothing here is created,
// read or trusted by operator HTTP Basic auth, and no operator credential is
// ever a customer principal.

/**
 * One customer person, as the platform knows them.
 *
 * Identity is the exact external identity the configured OpenID provider
 * asserted — `issuer` and `subject` together, uniquely indexed — never an email
 * address. `email` and `displayName` are profile metadata, refreshed at login,
 * and authorise nothing. No provider token is stored.
 */
export interface CustomerUserDocument {
  /** Opaque, server-minted: `cu_` + 32 hex. */
  _id: string;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean | null;
  displayName: string | null;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date;
}

/** One customer tenant. Projects belong to exactly one; people reach them only through membership. */
export interface CustomerAccountDocument {
  /** Opaque, server-minted: `acct_` + 32 hex. */
  _id: string;
  displayName: string;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

export type CustomerRole = 'owner' | 'editor' | 'viewer';

/** A customer user's authority in one account — at most one per (account, user), uniquely indexed. */
export interface CustomerMembershipDocument {
  _id: string;
  accountId: string;
  customerUserId: string;
  role: CustomerRole;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Which account one project belongs to — the persisted tenancy authority.
 *
 * Its own collection rather than a field on `ProjectDocument`, because a run
 * deletes and recreates the project document at discovery: ownership stored
 * there would silently vanish on the next run. `_id` is the project id, so a
 * project can be bound at most once; a binding is insert-only and never
 * transferred. A project with no binding — every historical and operator
 * project — is not customer-accessible, and needs no migration.
 */
export interface ProjectAccountBindingDocument {
  /** The project id. */
  _id: string;
  accountId: string;
  /** Which trusted server authority bound it, for audit. */
  boundBy: string;
  boundAt: Date;
}

/**
 * One customer login session. `_id` is the sha256 of the opaque cookie token,
 * so the database never holds a usable credential. Expiry and revocation are
 * decided here, server-side, on every request.
 */
export interface CustomerSessionDocument {
  _id: string;
  customerUserId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * One in-flight OpenID login: the state, nonce and PKCE verifier the callback
 * must match, held server-side under the sha256 of an opaque, short-lived
 * cookie. Consumed at most once.
 */
export interface CustomerLoginAttemptDocument {
  _id: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Release publication (Phase 5p)
// ---------------------------------------------------------------------------

/**
 * Where one release publishes to, in non-secret terms.
 *
 * Persisted so a retry can prove it is still publishing to the same
 * destination. Deliberately excluded from the release identity itself: if the
 * target were part of `releaseId`, changing `VERCEL_TEAM_ID` mid-flight would
 * silently mint a *different* release rather than being detected as drift, and
 * an in-flight publication would migrate to another Vercel project without
 * anyone deciding to. Bound here instead, so drift fails closed.
 *
 * Never holds a token: `VERCEL_TOKEN` is read at call time and never stored.
 */
export interface ReleaseDeploymentTarget {
  /** The Vercel project name this release deploys to (`toProjectName`). */
  project: string;
  /** `VERCEL_TEAM_ID`, or `null` for a personal account. Not a secret. */
  team: string | null;
  /** The Vercel deployment target — `production` for a real release. */
  environment: string;
}

/**
 * Release publication status (Phase 5p).
 *
 * `publishing` is the state that matters: it means a `createDeployment`
 * request *may already have reached Vercel*, and its outcome is not durably
 * known here. @vercel/sdk@1.28.17 exposes no idempotency key for deployment
 * creation and no server-side metadata filter to find a deployment by our own
 * marker, so nothing in this process can prove whether that request created a
 * production deployment. Automation therefore stops: `publishing` is never
 * retried automatically, and never expires, times out, or reverts to
 * `prepared` because a process died.
 *
 * `retry_authorized` is the *only* way out other than adoption, and it is
 * written by a human operator through `scripts/reconcile-release.ts`, who has
 * reconciled the ambiguous attempt against the Vercel dashboard themselves.
 */
export type ReleasePublicationStatus = 'prepared' | 'publishing' | 'retry_authorized' | 'committed';

/** What one external publication attempt did. Never rewritten, never removed. */
export interface ReleasePublicationAttempt {
  attempt: number;
  startedAt: Date;
  /** The exact canonical revision this attempt published. */
  releaseCommitSha: string | null;
  status: 'publishing' | 'succeeded' | 'adopted' | 'retry_authorized';
  deploymentId?: string;
  deploymentUrl?: string;
  /** When an operator (or a known-success outcome) resolved this attempt. */
  resolvedAt?: Date;
  /** Operator evidence, present only on an operator-resolved attempt. */
  resolution?: { actor: string; reason: string };
}

/**
 * The exact canonical build a release publication publishes.
 *
 * One value object rather than three loose optional fields, so it is present
 * whole or absent whole — a receipt naming a lineage without the exact build
 * and promotion inside it would be exactly the half-proven association this
 * exists to rule out.
 */
export interface ReleaseBuildAuthority {
  /** The root of the build lineage that owns this release. */
  lineageRootBindingId: string;
  /** The exact promoted `frontend_backend` binding whose tree is published. */
  canonicalBindingId: string;
  /** That binding's own promotion identity. */
  promotionId: string;
}

/**
 * The durable authority for one logical production release (Phase 5p).
 *
 * `_id` is the deterministic `releaseId` (see `computeReleaseId`), so this
 * collection is itself the idempotency ledger — the same shape Phase 5h's
 * `job_promotions` uses one layer down. What it adds over that pattern is an
 * immutable *attempt history*: canonical Git promotion can prove its own
 * replay from a commit marker, but an external Vercel deployment cannot be
 * proven from inside this process at all, so every attempt that may have
 * reached the provider is kept as evidence for the operator who has to
 * reconcile it.
 *
 * A document with no `active` key is finished history (`committed`); a
 * pre-Phase-5p release has no document here at all, which means "legacy
 * historical release", never "stuck publishing".
 */
export interface ReleasePublicationDocument {
  /** The deterministic release identity. */
  _id: string;
  projectId: string;
  /** The exact authorisation this release publishes — immutable binding. */
  releaseAuthorization: ArtifactRef;
  /**
   * Canonical HEAD at the moment this release was prepared, before its own
   * release-authorized commit — `null` when the workspace had no commit at
   * all. Authority on retry: HEAD that has moved without this release's Git
   * marker fails closed rather than being adopted.
   */
  baseCommit: string | null;
  deploymentTarget: ReleaseDeploymentTarget;
  /**
   * The exact canonical build this release publishes — immutable once written.
   *
   * Always present on a receipt created by a `job_lifecycle` run, which is
   * what lets a later reader go from a project's active build lineage straight
   * to its one publication, in any status, without ordering receipts by time.
   *
   * Absent on receipts written before this existed and on `legacy_direct`
   * releases, which have no build lineage to name. Absent means "no proven
   * association" — never "probably the current lineage", and never something
   * to fill in afterwards.
   */
  buildAuthority?: ReleaseBuildAuthority;
  status: ReleasePublicationStatus;
  /**
   * Present only while this release is unfinished, and absent once
   * `committed`. This is the project's one-active-publication slot: the
   * partial unique index in `StateStore.ensureIndexes` is filtered on it.
   * A separate field rather than a filter on `status` because Mongo's
   * `partialFilterExpression` has no `$in` — the same reason Phase 5h's
   * index filters on one exact status value.
   */
  active?: true;
  /** The exact canonical revision published, once Git identity is established. */
  releaseCommitSha: string | null;
  deploymentId: string | null;
  deploymentUrl: string | null;
  /** How many external attempts have been started. `0` before the first. */
  attempt: number;
  attempts: ReleasePublicationAttempt[];
  preparedAt: Date;
  committedAt: Date | null;
  updatedAt: Date;
}

/**
 * Durable, content-addressed binary evidence (a screenshot, today).
 *
 * `_id` is `sha256:<hex>` of `data`, so identical bytes are one document and a
 * write is one atomic insert. Immutable: never updated, never deleted here.
 * Bounded by what writers allow per object — far below the 16 MB document limit.
 */
export interface BlobDocument {
  _id: string;
  sha256: string;
  bytes: number;
  contentType: string;
  data: Binary;
  createdAt: Date;
}
