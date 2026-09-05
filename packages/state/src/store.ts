/**
 * MongoDB state store: connection, typed collections, indexes, and the
 * transaction helper the control plane's safety properties depend on.
 */
import { MongoClient } from 'mongodb';
import type { ClientSession, Collection, Db } from 'mongodb';
import type {
  ArtifactDocument,
  ArtifactSequenceDocument,
  AuditEvent,
  BudgetDocument,
  DefectBudgetDocument,
  JobDocument,
  JobPromotionRecord,
  ProjectDocument,
  ReviewDocument,
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
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
