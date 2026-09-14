/**
 * Draft-targeted run completion: the contract offline, and its authority structurally.
 *
 * The completion target is one strict value, absence means release, and it is
 * part of the run's durable intent — hashed into the run intent, recorded on the
 * lineage root, and read back by recovery. A draft-targeted run branches only
 * once nothing blocking, no replan and no refinement remain, before any
 * release-specific authority, and concludes through canonical draft authority.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RunCompletionTarget, normalizeRunCompletionTarget } from '@statxai/contracts';
import { releaseReadinessRefusal } from '@statxai/policy-engine';
import { contentHash } from '@statxai/workspace';
import { FrontendBackendBuildBindingCorrupt, computeRunIntentHash, readRunCompletionTarget } from '../src/run-binding/frontend-backend.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));
const ORCHESTRATOR = 'packages/orchestrator/src/orchestrator.ts';

async function productionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', 'test', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await productionFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}
function body(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return code.slice(from, to);
}

const profile = { businessName: 'Harrowgate Joinery' } as never;

describe('the completion target contract', () => {
  it('is exactly release or draft; absence means release; anything else is refused', () => {
    expect(RunCompletionTarget.parse('release')).toBe('release');
    expect(RunCompletionTarget.parse('draft')).toBe('draft');
    for (const bad of ['publish', 'Draft', '', true, null, 1]) expect(RunCompletionTarget.safeParse(bad).success, String(bad)).toBe(false);
    expect(normalizeRunCompletionTarget(undefined)).toBe('release');
    expect(normalizeRunCompletionTarget('draft')).toBe('draft');
    expect(() => normalizeRunCompletionTarget(null)).toThrow();
    expect(() => normalizeRunCompletionTarget('auto')).toThrow();
  });

  it('is part of the run intent: release hashes exactly as every run always has, draft hashes differently', () => {
    const historical = contentHash({ projectId: 'p', profile });
    expect(computeRunIntentHash({ projectId: 'p', profile })).toBe(historical);
    expect(computeRunIntentHash({ projectId: 'p', profile, completionTarget: 'release' })).toBe(historical);
    expect(computeRunIntentHash({ projectId: 'p', profile, completionTarget: 'draft' })).not.toBe(historical);
    expect(computeRunIntentHash({ projectId: 'p', profile, completionTarget: 'draft' })).toBe(computeRunIntentHash({ projectId: 'p', profile, completionTarget: 'draft' }));
  });

  it('is read from the lineage root: absent is release, draft is draft, anything else is corruption', () => {
    const root = { _id: 'frontend-backend-build-root' } as never;
    expect(readRunCompletionTarget(root)).toBe('release');
    expect(readRunCompletionTarget({ ...(root as object), completionTarget: 'draft' } as never)).toBe('draft');
    expect(() => readRunCompletionTarget({ ...(root as object), completionTarget: 'release' } as never)).toThrow(FrontendBackendBuildBindingCorrupt);
    expect(() => readRunCompletionTarget({ ...(root as object), completionTarget: 'publish' } as never)).toThrow(FrontendBackendBuildBindingCorrupt);
  });

  it('draft readiness is exactly release readiness: the same deterministic refusals', () => {
    expect(releaseReadinessRefusal({ buildSucceeded: true, blockingDefects: 0, gatesPassed: true })).toBeNull();
    expect(releaseReadinessRefusal({ buildSucceeded: false, blockingDefects: 0, gatesPassed: true })).toMatch(/build did not succeed/);
    expect(releaseReadinessRefusal({ buildSucceeded: true, blockingDefects: 1, gatesPassed: true })).toMatch(/blocking defect/);
    expect(releaseReadinessRefusal({ buildSucceeded: true, blockingDefects: 0, gatesPassed: false })).toMatch(/gates did not pass/);
  });
});

describe('the completion target is durable', () => {
  it('runProject normalises it first, refuses legacy_direct drafts, hashes it into the intent and records it on the root', async () => {
    const orchestrator = await src(ORCHESTRATOR);
    const normalised = orchestrator.indexOf('const completionTarget: RunCompletionTarget = normalizeRunCompletionTarget(options.completionTarget);');
    expect(normalised).toBeGreaterThan(-1);
    expect(normalised).toBeLessThan(orchestrator.indexOf('validateIntake(options.intake)'));
    expect(orchestrator).toMatch(/if \(completionTarget === 'draft' && frontendBackendExecutionMode !== 'job_lifecycle'\) \{\s*throw new RunCompletionTargetUnsupported/);
    expect(orchestrator.match(/computeRunIntentHash\(\{ projectId, profile(?:: validated\.profile)?, completionTarget \}\)/g)).toHaveLength(4);
    expect(orchestrator).not.toMatch(/computeRunIntentHash\(\{ projectId, profile(?:: validated\.profile)? \}\)/);
    expect(orchestrator).toMatch(/specificationBaseCommit: await workspace\.currentCommit\(\),\s*completionTarget,\s*\}\);/);
    expect(orchestrator).toContain('recovered = await resolvePostPromotionRecovery({ store, registry, workspacesRoot, projectId, runIntentHash, completionTarget });');
    expect(orchestrator).not.toMatch(/process\.env\.[A-Z_]*COMPLETION|autoPublish/);

    const binding = await src('packages/orchestrator/src/run-binding/frontend-backend.ts');
    expect(binding).toMatch(/: \{ activeLineage: true as const, \.\.\.\(completionTarget === 'draft' \? \{ completionTarget: 'draft' as const \} : \{\}\) \}\),/);
    expect(body(binding, 'export function computeRunIntentHash', '\n}\n')).toMatch(/=== 'draft'\s*\? contentHash\(\{ projectId: intent\.projectId, profile: intent\.profile, completionTarget: 'draft' \}\)\s*: contentHash\(\{ projectId: intent\.projectId, profile: intent\.profile \}\);/);
  });

  it('recovery reads the target from the root, never from the caller, time or project state', async () => {
    const recovery = await src('packages/orchestrator/src/run-recovery/frontend-backend.ts');
    const resolve = body(recovery, 'export async function resolvePostPromotionRecovery', '\n}\n');
    expect(resolve).toMatch(/const completionTarget = readRunCompletionTarget\(root\);\s*if \(completionTarget !== input\.completionTarget\) \{\s*throw new ActiveContinuationCorrupt/);
    expect(resolve).toMatch(/if \(publication && completionTarget === 'draft'\) \{\s*throw new ActiveContinuationCorrupt/);
    expect(resolve).toMatch(/publication,\s*completionTarget,\s*\};/);
    expect(resolve).not.toMatch(/completionTarget: 'release'|completionTarget: 'draft'|\?\? 'release'/);
  });
});

describe('the draft branch', () => {
  it('comes after adjudication, repair, replan and refinement settle, and before every release-specific step', async () => {
    const orchestrator = await src(ORCHESTRATOR);
    const loop = body(orchestrator, '  while (true) {\n    const evaluation = await evaluateSite(ctx(), {', 'const stillBlocked = isReleaseBlocked(');
    const blockingCheck = loop.indexOf('if (mustFix.length === 0) {');
    const refinement = loop.indexOf('const refinement = await authorizeVisualRefinement({');
    const refinedContinue = loop.indexOf('continue;', refinement);
    const branch = loop.indexOf("if (completionTarget === 'draft') {");
    const seek = loop.indexOf('const release = await seekRelease(ctx(), {');
    const adjudicate = loop.indexOf('const decided = await adjudicateDefects(');
    expect(blockingCheck).toBeGreaterThan(-1);
    expect(refinement).toBeGreaterThan(blockingCheck);
    expect(branch).toBeGreaterThan(refinedContinue);
    expect(seek).toBeGreaterThan(branch);
    expect(adjudicate).toBeGreaterThan(seek);
    const draftBranch = body(loop, "if (completionTarget === 'draft') {", "say({ phase: 'approve', detail: 'No blocking criteria outstanding");
    expect(draftBranch).toContain('releaseReadinessRefusal({ buildSucceeded: compiled.ok, blockingDefects: 0, gatesPassed: gateRun.passed })');
    expect(draftBranch).toMatch(/progress\.terminalDecision = 'mark_blocked';\s*break;/);
    expect(draftBranch).toContain('return concludeDraftRun(evaluation.siteExportSnapshot, evaluation.siteExportSnapshotRefusal);');
    expect(draftBranch).not.toMatch(/seekRelease|publishRelease|recommendApproval|authorizeRelease|awaiting_human_review/);
  });

  it('concludes exactly the run canonical build through canonical draft authority, with its exact model — no second implementation', async () => {
    const orchestrator = await src(ORCHESTRATOR);
    const conclude = body(orchestrator, 'const concludeDraftRun = async (siteExportSnapshot: ArtifactRef | null, snapshotRefusal: string | null): Promise<RunResult> => {', '\n  };\n');
    expect(conclude).toContain('const editableSiteModel = canonicalBuild.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel];');
    expect(conclude).toMatch(/if \(!editableSiteModel\?\.contentHash\) \{\s*throw new RunCompletionTargetUnsupported/);
    expect(conclude).toMatch(/await concludeCanonicalDraft\(\{\s*store,\s*registry,\s*siteExportSnapshot,\s*workspace,\s*projectId,\s*canonicalBindingId: canonicalBuild\._id,\s*promotion: canonicalPromotion \?\?/);
    expect(conclude).not.toMatch(/canonicalDrafts\.|activeLineage|releaseActiveLineage|state: 'draft'|registry\.|\.sort\(|latest/i);
    expect(orchestrator.match(/concludeCanonicalDraft\(/g)).toHaveLength(1);
    for (const file of await productionFiles('packages/orchestrator/src')) {
      if (file === 'packages/orchestrator/src/canonical-draft/authority.ts') continue;
      expect(await src(file), file).not.toMatch(/canonicalDrafts\.(insertOne|updateOne)|\$set: \{ state: 'draft'/);
    }
  });

  it('release mode keeps the existing release path, and nothing here touches semantic editing or customer surfaces', async () => {
    const orchestrator = await src(ORCHESTRATOR);
    expect(orchestrator).toContain("say({ phase: 'approve', detail: 'No blocking criteria outstanding — asking Sol to judge release' });");
    expect(orchestrator).toContain('const { manifest, finalCommit } = await publishRelease(ctx(), progress.authorization, {');
    expect(orchestrator).not.toMatch(/applySemanticEdit|semantic-edit\/apply|handOffCanonicalDraft/);
    const routes = (await productionFiles('apps/customer/app')).filter((f) => /route\.ts$|page\.tsx$/.test(f)).sort();
    expect(routes).toEqual(['apps/customer/app/api/auth/callback/route.ts', 'apps/customer/app/api/auth/login/route.ts', 'apps/customer/app/api/auth/logout/route.ts', 'apps/customer/app/api/auth/me/route.ts']);
    for (const file of [...(await productionFiles('apps/console/app')), ...(await productionFiles('apps/console/lib'))]) {
      expect(await src(file), file).not.toMatch(/completionTarget/);
    }
  });
});
