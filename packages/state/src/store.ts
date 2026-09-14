/**
 * MongoDB state store: connection, typed collections, indexes, and the
 * transaction helper the control plane's safety properties depend on.
 */
import { MongoClient } from 'mongodb';
import type { ClientSession, Collection, Db } from 'mongodb';
import type {
  ArtifactDocument,
  ArtifactSequenceDocument,
  BlobDocument,
  AuditEvent,
  BudgetDocument,
  DefectBudgetDocument,
  FrontendBackendBuildBindingDocument,
  JobDocument,
  JobPromotionRecord,
  ProjectDocument,
  ReleasePublicationDocument,
  ReviewDocument,
  VisualRefinementIntentDocument,
  CustomerUserDocument,
  CustomerAccountDocument,
  CustomerMembershipDocument,
  ProjectAccountBindingDocument,
  CustomerSessionDocument,
  CustomerLoginAttemptDocument,
} from './documents.js';
import type { RunDocument, RunEventDocument } from './runs.js';

export interface StateStoreOptions {
  uri?: string;
  dbName?: string;
}

/** Raised when a conditional budget guard matches no document. */
export class BudgetExhausted extends Error {
  constructor(readonly budget: string) {
    super(`Budget exhausted: ${budget}`);
    this.name = 'BudgetExhausted';
  }
}

export class StateStore {
  private constructor(
    private readonly client: MongoClient,
    readonly db: Db,
  ) {}

  static async connect(options: StateStoreOptions = {}): Promise<StateStore> {
    const uri = options.uri ?? process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set.');
    const dbName = options.dbName ?? process.env.MONGODB_DB ?? 'statxai';

    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    return new StateStore(client, client.db(dbName));
  }

  get projects(): Collection<ProjectDocument> {
    return this.db.collection<ProjectDocument>('projects');
  }
  get jobs(): Collection<JobDocument> {
    return this.db.collection<JobDocument>('jobs');
  }
  get budgets(): Collection<BudgetDocument> {
    return this.db.collection<BudgetDocument>('budgets');
  }
  get defectBudgets(): Collection<DefectBudgetDocument> {
    return this.db.collection<DefectBudgetDocument>('defect_budgets');
  }
  get artifacts(): Collection<ArtifactDocument> {
    return this.db.collection<ArtifactDocument>('artifacts');
  }
  /**
   * Per-project artifact lineage counters.
   *
   * Deliberately separate from `projects`: a run deletes and recreates the
   * project record at startup, and artifact history outlives that lifecycle.
   */
  /** Content-addressed binary evidence; `_id` is the hash, so it needs no other index. */
  get blobs(): Collection<BlobDocument> {
    return this.db.collection<BlobDocument>('blobs');
  }

  get artifactSequences(): Collection<ArtifactSequenceDocument> {
    return this.db.collection<ArtifactSequenceDocument>('artifact_sequences');
  }
  get reviews(): Collection<ReviewDocument> {
    return this.db.collection<ReviewDocument>('reviews');
  }
  get auditLog(): Collection<AuditEvent> {
    return this.db.collection<AuditEvent>('audit_log');
  }
  get runs(): Collection<RunDocument> {
    return this.db.collection<RunDocument>('runs');
  }
  get runEvents(): Collection<RunEventDocument> {
    return this.db.collection<RunEventDocument>('run_events');
  }
  /**
   * Durable canonical-promotion receipts (Phase 5h). `_id` is the
   * deterministic promotion identity, so this collection is itself the
   * idempotency ledger — no separate lock or lease collection exists.
   */
  get promotions(): Collection<JobPromotionRecord> {
    return this.db.collection<JobPromotionRecord>('job_promotions');
  }
  /**
   * Durable active/historical `frontend_backend` job-mode build bindings
   * (Phase 5k) — what lets a fresh `runProject` invocation resume an
   * incomplete build after a restart instead of starting discovery/planning
   * again. See `FrontendBackendBuildBindingDocument`'s own doc comment.
   */
  get frontendBackendBuildBindings(): Collection<FrontendBackendBuildBindingDocument> {
    return this.db.collection<FrontendBackendBuildBindingDocument>('frontend_backend_build_bindings');
  }
  /**
   * Durable release-publication authority (Phase 5p) — one document per
   * logical production release, keyed by its deterministic `releaseId`, plus
   * the immutable history of every external deployment attempt made under it.
   * See `ReleasePublicationDocument`'s own doc comment.
   */
  get releasePublications(): Collection<ReleasePublicationDocument> {
    return this.db.collection<ReleasePublicationDocument>('release_publications');
  }
  /**
   * Durable visual-refinement authorisations — one per refined predecessor
   * build, keyed deterministically, written with the budget spend that
   * authorised it. See `VisualRefinementIntentDocument`.
   */
  get visualRefinementIntents(): Collection<VisualRefinementIntentDocument> {
    return this.db.collection<VisualRefinementIntentDocument>('visual_refinement_intents');
  }
  /** Customer people, by exact external identity. See `CustomerUserDocument`. */
  get customerUsers(): Collection<CustomerUserDocument> {
    return this.db.collection<CustomerUserDocument>('customer_users');
  }
  get customerAccounts(): Collection<CustomerAccountDocument> {
    return this.db.collection<CustomerAccountDocument>('customer_accounts');
  }
  get customerMemberships(): Collection<CustomerMembershipDocument> {
    return this.db.collection<CustomerMembershipDocument>('customer_memberships');
  }
  /** Which account each customer-accessible project belongs to. See `ProjectAccountBindingDocument`. */
  get projectAccountBindings(): Collection<ProjectAccountBindingDocument> {
    return this.db.collection<ProjectAccountBindingDocument>('project_account_bindings');
  }
  get customerSessions(): Collection<CustomerSessionDocument> {
    return this.db.collection<CustomerSessionDocument>('customer_sessions');
  }
  get customerLoginAttempts(): Collection<CustomerLoginAttemptDocument> {
    return this.db.collection<CustomerLoginAttemptDocument>('customer_login_attempts');
  }

  /**
   * Run `fn` inside a multi-document transaction.
   *
   * The driver retries the callback on transient transaction errors, so `fn`
   * must be idempotent — it may execute more than once. Domain errors thrown
   * from `fn` (notably {@link BudgetExhausted}) carry no retry label, so they
   * abort the transaction and propagate, which is exactly the intent: the
   * budget check and the state change it guards fail together.
   */
  async withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(
        async () => {
          result = await fn(session);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Indexes. Uniqueness here is a correctness control, not a performance one:
   * it is what stops a concurrent writer creating a second artifact version 3,
   * or a duplicate per-defect budget row that would double the repair budget.
   */
  async ensureIndexes(): Promise<void> {
    await this.jobs.createIndexes([
      { key: { projectId: 1, state: 1 } },
      { key: { state: 1, 'lease.expiresAt': 1 } },
      { key: { projectId: 1, 'origin.defectFingerprint': 1 } },
    ]);

    await this.artifacts.createIndexes([
      { key: { projectId: 1, name: 1, version: -1 } },
      { key: { projectId: 1, name: 1, version: 1 }, unique: true },
      // Two artifacts in one project can never claim the same position in its
      // history. Partial because artifacts written before lineage numbers
      // existed have no `lineageSeq`, and a plain unique index would treat
      // every one of them as a duplicate `null` and refuse to build.
      {
        key: { projectId: 1, lineageSeq: 1 },
        unique: true,
        partialFilterExpression: { lineageSeq: { $exists: true } },
      },
    ]);

    // Touching the collection here also creates it, so an allocation running
    // inside a caller's transaction never has to create a namespace.
    await this.artifactSequences.createIndex({ updatedAt: -1 });

    await this.defectBudgets.createIndex({ projectId: 1, fingerprint: 1 }, { unique: true });

    await this.reviews.createIndexes([{ key: { projectId: 1, reviewCycle: -1 } }]);

    await this.auditLog.createIndexes([{ key: { projectId: 1, at: -1 } }, { key: { kind: 1, at: -1 } }]);

    await this.runs.createIndexes([{ key: { startedAt: -1 } }, { key: { projectId: 1 } }]);
    await this.runEvents.createIndexes([{ key: { runId: 1, seq: 1 }, unique: true }]);

    // At most one in-progress (`prepared`) canonical promotion per project —
    // the project-scoped serialization Phase 5h needs, enforced by Mongo
    // itself rather than a separate lock service. Partial, the same way the
    // artifact lineage index is: a `committed` promotion no longer
    // participates, freeing the project for the next one.
    await this.promotions.createIndexes([
      { key: { projectId: 1 }, unique: true, partialFilterExpression: { status: 'prepared' } },
      { key: { projectId: 1, jobId: 1 } },
    ]);

    // At most one unfinished ("prepared") frontend/backend build binding per
    // project (Phase 5k) — the same project-scoped active-slot shape as
    // `promotions` above, for the same reason: a `promoted` binding no
    // longer participates, freeing the project for its next build
    // generation, while history is preserved rather than deleted.
    await this.frontendBackendBuildBindings.createIndexes([
      { key: { projectId: 1 }, unique: true, partialFilterExpression: { status: 'prepared' } },
      { key: { projectId: 1, jobId: 1 } },
      // At most one successor per exact predecessor (Phase 5q0), whatever
      // its reason: the key is the predecessor alone, so a replan successor
      // and a visual-refinement successor compete for the same one slot.
      // Deliberately *not* filtered on `status` like the active-slot index
      // above: that one frees the project once a build promotes, which is
      // right for "may another generation start?" and wrong for lineage. A
      // promoted successor still means its predecessor has been replaced, so
      // a second successor of the same predecessor must stay impossible
      // forever, not just while the first is unfinished. Partial on the
      // field's existence, so every pre-5q0 binding — which has no such
      // field — is outside the index and the build succeeds without any
      // backfill.
      {
        key: { projectId: 1, predecessorBindingId: 1 },
        unique: true,
        partialFilterExpression: { predecessorBindingId: { $exists: true } },
      },
      // At most one unfinished build *lineage* owns a project at a time.
      //
      // Filtered on `activeLineage` rather than on `status`, because that and
      // the active-slot index above answer different questions. That one frees
      // the project the moment a build promotes — right for "may another build
      // generation start?", and wrong for "does an unfinished lineage still
      // own this project?", where a promoted root is precisely when the answer
      // must stay yes. Filtered on the literal value the way
      // `release_publications.active` is, and partial so every binding written
      // before this existed stays outside the index with no backfill.
      //
      // Explicitly named: the active-slot index above already occupies the
      // default name Mongo derives from this same `{ projectId: 1 }` key
      // pattern, and two indexes may not share a name.
      {
        key: { projectId: 1 },
        unique: true,
        partialFilterExpression: { activeLineage: true },
        name: 'projectId_1_activeLineage',
      },
    ]);

    // At most one unfinished release publication per project (Phase 5p) — the
    // same project-scoped active-slot shape again, but filtered on `active`
    // rather than on one status value: a release is unfinished across three
    // statuses (`prepared`, `publishing`, `retry_authorized`) and Mongo's
    // `partialFilterExpression` does not support `$in`. Two different releases
    // must never be mid-publication for one project at the same time, because
    // each of them can create a production deployment.
    await this.releasePublications.createIndexes([
      { key: { projectId: 1 }, unique: true, partialFilterExpression: { active: true } },
      { key: { projectId: 1, preparedAt: -1 } },
      // At most one logical release per build lineage — ever, not only while
      // unfinished. Deliberately *not* filtered on `active` like the slot
      // above: a committed receipt still means this lineage has published, and
      // a second, different release for it must stay impossible, which is also
      // what keeps a committed receipt exactly findable by lineage afterwards.
      // Partial on the field's existence, so historical and `legacy_direct`
      // receipts — which carry no build authority — sit outside it with no
      // backfill.
      {
        key: { projectId: 1, 'buildAuthority.lineageRootBindingId': 1 },
        unique: true,
        partialFilterExpression: { 'buildAuthority.lineageRootBindingId': { $exists: true } },
        name: 'projectId_1_buildAuthority_lineageRoot',
      },
    ]);

    // At most one visual refinement per exact predecessor build, ever — the
    // same predecessor-keyed shape as the one-successor index above, and never
    // keyed on a review: a re-evaluation of the same build writes a new review,
    // and must find the refinement already authorised rather than authorise another.
    await this.visualRefinementIntents.createIndexes([
      { key: { projectId: 1, predecessorBindingId: 1 }, unique: true },
    ]);

    // Customer identity and tenancy. Uniqueness here is the authority, not an
    // optimisation: one external identity is one customer user, and one user
    // has at most one membership in an account, so authority is never ambiguous.
    await this.customerUsers.createIndexes([
      { key: { issuer: 1, subject: 1 }, unique: true, name: 'issuer_1_subject_1' },
    ]);
    await this.customerMemberships.createIndexes([
      { key: { accountId: 1, customerUserId: 1 }, unique: true, name: 'accountId_1_customerUserId_1' },
      { key: { customerUserId: 1 } },
    ]);
    await this.projectAccountBindings.createIndexes([{ key: { accountId: 1 } }]);
    // Expired rows are removed eventually; expiry is always checked on read regardless.
    await this.customerSessions.createIndexes([
      { key: { customerUserId: 1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ]);
    await this.customerLoginAttempts.createIndexes([{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
