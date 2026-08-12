/**
 * Run the deterministic gates against an already-built project.
 *
 *   pnpm gate:check <projectId>
 *
 * Useful for two things: checking a released site after adding a new gate, and
 * reproducing a gate finding without paying for a full delivery run.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BusinessProfile, type SitePlan } from '@statxai/contracts';
import { StateStore } from '@statxai/state';
import { runGates, type SiteFile } from '@statxai/gates';

const projectId = process.argv[2];
if (!projectId) {
  console.error('\n  usage: pnpm gate:check <projectId>\n');
  process.exit(1);
}

const siteRoot = resolve(process.env.WORKSPACES_ROOT ?? './workspaces', projectId, 'app');

async function walk(dir: string, base = dir): Promise<SiteFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: SiteFile[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push({ path: full.slice(base.length + 1), contents: await readFile(full, 'utf8') });
  }
  return out;
}

const store = await StateStore.connect();
try {
  const files = await walk(siteRoot);
  const profileDoc = await store.artifacts.findOne(
    { projectId, name: 'business-profile' },
    { sort: { version: -1 } },
  );
  const planDoc = await store.artifacts.findOne({ projectId, name: 'site-plan' }, { sort: { version: -1 } });

  if (!profileDoc || !planDoc) {
    console.error(`\n  No stored artifacts for ${projectId}.\n`);
    process.exit(1);
  }

  const result = runGates({
    files,
    profile: BusinessProfile.parse(profileDoc.data),
    plan: planDoc.data as SitePlan,
  });

  const bySeverity = result.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`\n  project   ${projectId}`);
  console.log(`  files     ${files.length}`);
  console.log(`  gates     ${result.gatesRun.join(', ')}`);
  console.log(`  findings  ${result.findings.length} ${JSON.stringify(bySeverity)}`);
  console.log(`  blocking  ${result.passed ? 'none' : 'yes'}\n`);

  for (const f of result.findings) {
    console.log(`  [${f.severity}] ${f.gate.padEnd(14)} ${f.location}`);
    console.log(`        ${f.message}`);
  }
  console.log();
} finally {
  await store.close();
}
