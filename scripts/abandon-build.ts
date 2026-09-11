/**
 * Explicitly abandon one active frontend_backend job-mode build binding
 * (Phase 5m).
 *
 *   pnpm build:abandon <projectId> <bindingId> <reason...>
 *
 * Still not exposed over HTTP. Phase 5o gave the console an authenticated
 * operator boundary, so the original reason this was CLI-only — every
 * console route was reachable by anyone who could open the port — no longer
 * holds; but an abandonment endpoint is a separate capability, and Phase 5o
 * deliberately shipped the boundary without it. This script remains the
 * operator surface, following the same trust boundary every other script
 * under `scripts/` already relies on (`db-check.ts`, `gate-check.ts`,
 * `run-agent.ts`): whoever can run a script on this host already has the
 * access an operator action requires. `actor` is derived from the OS user
 * running this process, never from a flag — the same discipline an
 * authenticated API route applies to a request body field, applied here to
 * the one identity source this script actually has.
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
import {
  abandonFrontendBackendBuild,
  FrontendBackendBuildPromotionOwned,
  FrontendBackendBuildAbandonmentDownstreamDependency,
  FrontendBackendBuildAbandonmentPromotionEvidenceConflict,
} from '@statxai/orchestrator';

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
  let result;
  try {
    result = await abandonFrontendBackendBuild({ projectId, bindingId, actor, reason }, { store, engine });
  } catch (error) {
    if (error instanceof FrontendBackendBuildPromotionOwned) {
      console.error(`\n  Cannot abandon: promotion already owns this build (${error.message}).\n  Wait for it to finish, or escalate — Phase 5n does not revoke promotion authority.\n`);
      process.exit(1);
    }
    if (error instanceof FrontendBackendBuildAbandonmentDownstreamDependency) {
      console.error(`\n  Cannot abandon: another job already depends on this one's acceptance (${error.message}).\n  This capability does not revoke a dependency graph.\n`);
      process.exit(1);
    }
    if (error instanceof FrontendBackendBuildAbandonmentPromotionEvidenceConflict) {
      console.error(`\n  Cannot abandon: this build already has promotion evidence on record (${error.message}).\n`);
      process.exit(1);
    }
    throw error;
  }

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
