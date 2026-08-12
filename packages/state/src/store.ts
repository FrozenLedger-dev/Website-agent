/**
 * MongoDB state store: connection, typed collections, indexes, and the
 * transaction helper the control plane's safety properties depend on.
 */
import { MongoClient } from 'mongodb';
import type { ClientSession, Collection, Db } from 'mongodb';
import type {
  ArtifactDocument,
  AuditEvent,
  BudgetDocument,
  DefectBudgetDocument,
  JobDocument,
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
    ]);

    await this.defectBudgets.createIndex({ projectId: 1, fingerprint: 1 }, { unique: true });

    await this.reviews.createIndexes([{ key: { projectId: 1, reviewCycle: -1 } }]);

    await this.auditLog.createIndexes([{ key: { projectId: 1, at: -1 } }, { key: { kind: 1, at: -1 } }]);

    await this.runs.createIndexes([{ key: { startedAt: -1 } }, { key: { projectId: 1 } }]);
    await this.runEvents.createIndexes([{ key: { runId: 1, seq: 1 }, unique: true }]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
