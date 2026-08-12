/**
 * Connectivity and capability probe for the configured Mongo deployment.
 *
 * Verifies the one property the whole control plane depends on: that this
 * deployment can run multi-document transactions. A standalone mongod cannot,
 * and the failure mode is silent — budgets would appear to work while being
 * unenforceable — so this is checked explicitly rather than assumed.
 *
 *   pnpm db:check
 */
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? 'statxai';

function fail(message: string): never {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

if (!uri) fail('MONGODB_URI is not set. Copy .env.example to .env.local.');

// Guard the handoff placeholders explicitly — otherwise the driver reports an
// opaque authentication failure and the real cause is easy to miss.
for (const placeholder of ['<db_password>', 'PASSWORD_HERE']) {
  if (uri.includes(placeholder)) {
    fail(`MONGODB_URI still contains the placeholder "${placeholder}". Substitute the real password.`);
  }
}

const isSrv = uri.startsWith('mongodb+srv://');
const hasDbPath = /mongodb(\+srv)?:\/\/[^/]+\/[^?]+/.test(uri);
if (!hasDbPath) {
  console.warn(`  WARN  No database name in the URI path; falling back to MONGODB_DB="${dbName}".`);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });

try {
  await client.connect();

  const admin = client.db(dbName).admin();
  const { version } = (await admin.command({ buildInfo: 1 })) as { version: string };

  // `client.topology` is driver-internal. `hello` is the supported way to learn
  // the deployment type: mongos reports msg="isdbgrid", a replica set member
  // reports its setName, and a standalone reports neither.
  const hello = (await admin.command({ hello: 1 })) as {
    setName?: string;
    msg?: string;
    isWritablePrimary?: boolean;
  };
  const topology =
    hello.msg === 'isdbgrid'
      ? 'Sharded (mongos)'
      : hello.setName
        ? `ReplicaSet "${hello.setName}"${hello.isWritablePrimary ? ' (primary)' : ' (secondary)'}`
        : 'Standalone';

  console.log(`\n  connection   ${isSrv ? 'Atlas (mongodb+srv)' : 'direct (mongodb)'}`);
  console.log(`  server       MongoDB ${version}`);
  console.log(`  topology     ${topology}`);
  console.log(`  database     ${dbName}`);

  if (topology === 'Standalone') {
    fail(
      'This is a standalone mongod, which cannot run multi-document transactions.\n' +
        '        Budget enforcement requires a replica set or sharded cluster.\n' +
        '        For local development: pnpm db:up',
    );
  }

  // Prove it rather than infer it: commit a real transaction and roll one back.
  const probe = client.db(dbName).collection<{ _id: string; n: number }>('_txn_probe');
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await probe.updateOne({ _id: 'probe' }, { $inc: { n: 1 } }, { upsert: true, session });
    });
    await session
      .withTransaction(async () => {
        await probe.updateOne({ _id: 'probe' }, { $inc: { n: 100 } }, { session });
        throw new Error('deliberate abort');
      })
      .catch(() => {
        /* expected */
      });
  } finally {
    await session.endSession();
  }

  const after = await probe.findOne({ _id: 'probe' });
  await probe.drop().catch(() => {
    /* ignore */
  });

  // The committed transaction contributes +1; the aborted one must contribute
  // nothing. Any other value means writes are leaking out of aborted sessions.
  if (after?.n !== 1) {
    fail(`Rollback is not isolating writes: expected n=1 after commit+abort, got n=${after?.n}.`);
  }
  console.log(`  transactions commit + rollback verified`);
  console.log(`\n  OK    deployment is suitable for the job engine.\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await client.close();
}
