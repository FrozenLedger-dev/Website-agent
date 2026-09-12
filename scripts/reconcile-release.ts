/**
 * Reconcile one ambiguous production release publication (Phase 5p).
 *
 *   pnpm release:reconcile show   <projectId>
 *   pnpm release:reconcile adopt  <projectId> <releaseId> <attempt> <deploymentId> <reason...>
 *   pnpm release:reconcile retry  <projectId> <releaseId> <attempt> <reason...>
 *
 * A release whose `createDeployment` outcome is unknown stops automation: the
 * receipt stays `publishing`, and no later run will deploy that release again.
 * That is deliberate. `@vercel/sdk@1.28.17` has no idempotency key for
 * deployment creation and no way to search deployments by our own metadata, so
 * nothing in the harness can prove whether a production deployment exists. A
 * person can: the Vercel dashboard shows it, and the deployment carries a
 * `statxReleaseId` marker naming the exact release that created it.
 *
 * This script is that person's authority, and it is genuinely trusted — it
 * cannot prove the process that started the ambiguous attempt is dead, only
 * that the operator says they have looked. `actor` is derived from the OS user
 * running it, never from a flag, and every action names the exact release and
 * the exact attempt it resolves, so a stale command can never resolve a newer
 * attempt. Not exposed over HTTP: Phase 5o gave the console an authenticated
 * boundary, but an abandonment/reconciliation API is a separate capability.
 *
 *   adopt — "this exact deployment is the outcome of that attempt". The
 *           harness re-reads it from Vercel and refuses it unless its marker
 *           and target match this release. No new deployment is created.
 *
 *   retry — "I have reconciled the previous attempt well enough to allow one
 *           more". Single-use: it authorises exactly one further attempt, the
 *           ambiguous one stays on record, and a second ambiguity needs a
 *           second decision.
 */
import { userInfo } from 'node:os';
import { StateStore } from '@statxai/state';
import { getDeploymentById } from '@statxai/workspace';
import {
  ReleasePublicationAdoptionConflict,
  ReleasePublicationAlreadyCommitted,
  ReleasePublicationAttemptConflict,
  ReleasePublicationBindingConflict,
  adoptReleaseDeployment,
  authorizeReleaseRepublication,
} from '@statxai/orchestrator';

const usage = `
  usage: pnpm release:reconcile show   <projectId>
         pnpm release:reconcile adopt  <projectId> <releaseId> <attempt> <deploymentId> <reason...>
         pnpm release:reconcile retry  <projectId> <releaseId> <attempt> <reason...>
`;

const [action, projectId, ...rest] = process.argv.slice(2);

if (!action || !projectId || !['show', 'adopt', 'retry'].includes(action)) {
  console.error(usage);
  process.exit(1);
}

const actor = `operator:${userInfo().username}`;
const store = await StateStore.connect();

try {
  if (action === 'show') {
    const receipts = await store.releasePublications
      .find({ projectId })
      .sort({ preparedAt: -1 })
      .limit(10)
      .toArray();

    if (receipts.length === 0) {
      console.log(`\n  No release publications recorded for ${projectId}.\n`);
    }
    for (const receipt of receipts) {
      console.log(`\n  release     ${receipt._id}`);
      console.log(`  status      ${receipt.status}${receipt.active ? ' (holds this project’s publication slot)' : ''}`);
      console.log(`  attempt     ${receipt.attempt}`);
      console.log(`  revision    ${receipt.releaseCommitSha ?? '(none yet)'}`);
      console.log(`  target      ${receipt.deploymentTarget.project}/${receipt.deploymentTarget.environment}`);
      console.log(`  deployment  ${receipt.deploymentId ?? '(unknown)'}`);
      for (const attempt of receipt.attempts) {
        const resolution = attempt.resolution ? ` by ${attempt.resolution.actor}: ${attempt.resolution.reason}` : '';
        console.log(`    #${attempt.attempt} ${attempt.status}${resolution}`);
      }
    }
    console.log('');
  } else {
    const [releaseId, rawAttempt, ...tail] = rest;
    const deploymentId = action === 'adopt' ? tail.shift() : undefined;
    const reason = tail.join(' ');
    const attempt = Number(rawAttempt);

    if (!releaseId || !Number.isInteger(attempt) || attempt < 1 || reason.trim() === '') {
      console.error(usage);
      process.exit(1);
    }
    if (action === 'adopt' && !deploymentId) {
      console.error(usage);
      process.exit(1);
    }

    try {
      const receipt =
        action === 'adopt'
          ? await adoptReleaseDeployment(
              store,
              { getDeploymentById },
              { projectId, releaseId, attempt, deploymentId: deploymentId!, actor, reason },
            )
          : await authorizeReleaseRepublication(store, { projectId, releaseId, attempt, actor, reason });

      console.log(`\n  release     ${receipt._id}`);
      console.log(`  status      ${receipt.status}`);
      console.log(`  attempt     ${receipt.attempt}`);
      console.log(`  actor       ${actor}`);
      if (action === 'adopt') {
        console.log(`  deployment  ${receipt.deploymentId}`);
        console.log(`  url         ${receipt.deploymentUrl}`);
        console.log('\n  Adopted. No new deployment was created.\n');
      } else {
        console.log('\n  One further deployment attempt is authorised for this release.');
        console.log('  The ambiguous attempt stays on record — it may correspond to a real deployment.\n');
      }
    } catch (error) {
      if (error instanceof ReleasePublicationAlreadyCommitted) {
        console.error(`\n  Nothing to reconcile: ${error.message}.\n`);
        process.exit(1);
      }
      if (error instanceof ReleasePublicationAttemptConflict) {
        console.error(`\n  Refused: ${error.message}.\n  Re-read the release with "show" and name the current attempt.\n`);
        process.exit(1);
      }
      if (error instanceof ReleasePublicationAdoptionConflict) {
        console.error(`\n  Refused: ${error.message}.\n  Only a deployment carrying this release’s own marker can be adopted.\n`);
        process.exit(1);
      }
      if (error instanceof ReleasePublicationBindingConflict) {
        console.error(`\n  Refused: ${error.message}.\n`);
        process.exit(1);
      }
      throw error;
    }
  }
} finally {
  await store.close();
}
