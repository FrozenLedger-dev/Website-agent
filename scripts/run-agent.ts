/**
 * Run one project end to end.
 *
 *   pnpm agent:run                        # uses examples/intake.json
 *   pnpm agent:run path/to/intake.json
 *   pnpm agent:run --mode supervised_autonomous
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StateStore } from '@statxai/state';
import { launchRun } from '@statxai/orchestrator';

const argv = process.argv.slice(2);
const modeFlag = argv.indexOf('--mode');
const autonomyMode = (modeFlag >= 0 ? argv[modeFlag + 1] : 'full_autonomous') as
  | 'full_autonomous'
  | 'supervised_autonomous'
  | 'human_in_the_loop';
const intakePath = resolve(argv.find((a) => !a.startsWith('--') && a !== autonomyMode) ?? 'examples/intake.json');

const COLOURS = { info: '\x1b[0m', ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m' } as const;
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const intake: unknown = JSON.parse(await readFile(intakePath, 'utf8'));

const store = await StateStore.connect();
await store.ensureIndexes();

const started = Date.now();
try {
  // Same entry point the console uses, so a CLI run shows up in the run list
  // and its progress is readable from the database rather than this terminal.
  const handle = await launchRun({
    store,
    intake,
    workspacesRoot: process.env.WORKSPACES_ROOT ?? './workspaces',
    autonomyMode,
  });

  console.log(`\n  ${DIM}intake${RESET}   ${intakePath}`);
  console.log(`  ${DIM}project${RESET}  ${handle.projectId}`);
  console.log(`  ${DIM}run${RESET}      ${handle.runId}`);
  console.log(`  ${DIM}autonomy${RESET} ${autonomyMode}`);
  console.log(`  ${DIM}console${RESET}  http://localhost:3100/runs/${handle.runId}\n`);

  // Tail persisted progress so the terminal mirrors what the console shows.
  let seq = 0;
  const tail = setInterval(() => {
    void (async () => {
      const events = await store.runEvents.find({ runId: handle.runId, seq: { $gt: seq } }).sort({ seq: 1 }).toArray();
      for (const e of events) {
        seq = e.seq;
        console.log(`  ${COLOURS[e.level]}${e.phase.padEnd(9)}${RESET}${DIM}│${RESET} ${e.detail}`);
      }
    })();
  }, 500);

  const result = await handle.completed;
  clearInterval(tail);
  if (!result) {
    const run = await store.runs.findOne({ _id: handle.runId });
    console.error(`\n  ${COLOURS.fail}run failed${RESET}: ${run?.error ?? 'unknown error'}\n`);
    process.exitCode = 1;
    throw new Error('run failed');
  }

  const projectId = handle.projectId;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  ${'─'.repeat(64)}`);
  console.log(`  outcome        ${result.outcome === 'released' ? COLOURS.ok : COLOURS.fail}${result.outcome}${RESET}`);
  if (result.terminalDecision) console.log(`  decision       ${result.terminalDecision}`);
  console.log(`  quality score  ${result.qualityScore}`);
  console.log(`  review cycles  ${result.reviewCycles}`);
  console.log(`  repairs        ${result.repairsApplied}`);
  console.log(`  commit         ${result.commit?.slice(0, 12) ?? '—'}`);
  console.log(`  tokens         ${result.usage.inputTokens} in / ${result.usage.outputTokens} out over ${result.usage.calls} calls`);
  console.log(`  elapsed        ${elapsed}s`);

  if (result.openDefects.length > 0) {
    console.log(`\n  open findings`);
    for (const d of result.openDefects) {
      console.log(`    ${DIM}${d.severity}${RESET} ${d.category.padEnd(16)} ${d.location} — ${d.reason}`);
    }
  }

  if (result.siteRoot) {
    console.log(`\n  site           ${result.siteRoot}`);
    console.log(`  preview        pnpm preview ${projectId}\n`);
  }

  process.exitCode = result.outcome === 'released' ? 0 : 1;
} finally {
  await store.close();
}
