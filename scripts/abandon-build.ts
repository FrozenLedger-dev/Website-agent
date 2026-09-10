/**
 * Explicitly abandon one active frontend_backend job-mode build binding
 * (Phase 5m).
 *
 *   pnpm build:abandon <projectId> <bindingId> <reason...>
 *
 * Not exposed over HTTP: the console (`apps/console`) has no authentication
 * of any kind — every route is reachable by anyone who can open the port —
 * so an HTTP abandonment endpoint would let an unauthenticated caller
 * revoke a production build. This script is the operator surface instead,
 * following the same trust boundary every other script under `scripts/`
 * already relies on (`db-check.ts`, `gate-check.ts`, `run-agent.ts`):
 * whoever can run a script on this host already has the access an operator
 * action requires. `actor` is derived from the OS user running this
 * process, never from a flag — the same discipline a real authenticated API
 * route would apply to a request body field, applied here to the one
 * identity source this script actually has.
 *
 * `bindingId` is required and exact — find it first (e.g. via the console's
 * run view, or a direct query against `frontend_backend_build_bindings`
 * for `{ projectId, status: 'prepared' }`). This script does not offer an
 * "abandon whatever is currently active" shortcut: a stale bindingId must
 * never abandon a newer generation that appeared since you looked.
 */
import { userInfo } from 'node:os';
import { StateStore } from '@statxai/state';
import { JobEngine } from '@statxai/job-engine';
import { abandonFrontendBackendBuild } from '@statxai/orchestrator';

const [projectId, bindingId, ...reasonParts] = process.argv.slice(2);
const reason = reasonParts.join(' ');

if (!projectId || !bindingId || reason.trim() === '') {
  console.error('\n  usage: pnpm build:abandon <projectId> <bindingId> <reason...>\n');
  process.exit(1);
}

const actor = `operator:${userInfo().username}`;

const store = await StateStore.connect();
try {
  const engine = new JobEngine(store);
  const result = await abandonFrontendBackendBuild({ projectId, bindingId, actor, reason }, { store, engine });

  console.log(`\n  project   ${projectId}`);
  console.log(`  binding   ${result.binding._id}`);
  console.log(`  actor     ${actor}`);
  console.log(`  outcome   ${result.outcome}`);
  if (result.outcome === 'abandoned') {
    console.log(`  job       ${result.supersededJobId ?? '(none enqueued yet)'}`);
  }
  console.log('');

  if (result.outcome === 'already_promoted') {
    console.error('  This binding already promoted — nothing to abandon.\n');
    process.exit(1);
  }
} finally {
  await store.close();
}
