/**
 * Structural enforcement of the semantic-edit application.
 *
 * An edit begins from a canonical-draft handoff and never from an active
 * lineage; builds only through the existing lifecycle coordinator; never
 * accepts, promotes, writes source, releases, publishes or refines; reads models
 * and bindings by exact ref and id only; ends in canonical draft authority; and
 * stays out of reach of customer authentication and HTTP.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));
const APPLY = 'packages/orchestrator/src/semantic-edit/apply.ts';

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
const imports = (code: string) => [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

describe('an edit begins from a draft handoff', () => {
  it('proves the exact available draft, build and base model, then claims and hands off the draft in the same transaction as the model, source and intent', async () => {
    const apply = await src(APPLY);
    // One preparation path: submission returns after it; the synchronous form continues after the same one.
    expect(body(apply, 'export async function submitSemanticEdit(', '\n}\n')).toMatch(/const \{ intent, replayed \} = await prepareSemanticEdit\(input\);\s*return resultOf\(intent, replayed\);/);
    expect(body(apply, 'export async function applySemanticEdit(', '\n}\n')).toMatch(/const \{ intent, replayed \} = await prepareSemanticEdit\(input\);\s*return continueSemanticEdit\(input, intent, replayed, \{\}\);/);
    const fn = body(apply, 'async function prepareSemanticEdit(', '\n}\n');
    const order = [
      'applySemanticPatch({ baseRef: input.baseEditableSiteModel, base, patch: input.patch })',
      'const existing = await store.semanticEditIntents.findOne({ _id: intentId });',
      'await resolveCanonicalDraftAuthority(store, projectId);',
      "if (authority.state !== 'concluded' || draft.status !== 'available')",
      'if (!pinned || !sameExactRef(pinned, input.baseEditableSiteModel))',
      'await assertCanonicalDraftPromotionMarker(workspace, draft);',
      'await workspace.isAncestorCommit(draft.promotionCommitSha, sourceCommit)',
      'await workspace.readModelSourceAtCommit(sourceCommit, SEMANTIC_EDIT_SOURCE_LIMITS);',
      'store.withTransaction(async (session) => {',
      'await handOffCanonicalDraft({ store, projectId, expectedDraftId: draft._id, expectedCanonicalBindingId: predecessor._id, claimant }, session);',
      'await recordEditableSiteModel(registry, projectId, result, session);',
      'await registry.put(projectId, SEMANTIC_EDIT_SOURCE_ARTIFACT, source, session);',
      'await store.semanticEditIntents.insertOne(doc, { session });',
      'return { intent, replayed: !won };',
    ];
    let at = -1;
    for (const step of order) {
      const next = fn.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    expect(fn).toContain("const claimant = { kind: 'semantic_edit' as const, operationId: intentId };");
  });

  it('never begins from an active lineage, a latest binding or a latest model', async () => {
    const apply = await src(APPLY);
    expect(apply).not.toMatch(/findActiveLineageRoot|deriveActiveLineageTip|activeLineage|findActivePreparedBinding/);
    expect(apply).not.toMatch(/\.sort\(|newest|latest|Date\.now|Math\.random|randomUUID/i);
    expect(apply).not.toMatch(/registry\.get\(|EDITABLE_SITE_MODEL_ARTIFACT|'editable-site-model'/);
    // Bindings and intents are read by exact id only.
    for (const read of apply.match(/frontendBackendBuildBindings\.findOne\(\{[^}]*\}/g) ?? []) expect(read).toMatch(/_id: /);
    for (const read of apply.match(/semanticEditIntents\.findOne\(\{[^}]*\}/g) ?? []) expect(read).toMatch(/_id: /);
  });

  it('the intent id is deterministic from exact authority alone', async () => {
    const apply = await src(APPLY);
    const id = body(apply, 'export function semanticEditIntentId(', '\n}\n');
    expect(id).toMatch(/contentHash\(\{\s*projectId: identity\.projectId,\s*sourceDraftId: identity\.sourceDraftId,\s*predecessorBindingId: identity\.predecessorBindingId,/);
    expect(id).not.toMatch(/Date|now|random|session|customer/i);
  });
});

describe('an edit builds only through the existing lifecycle', () => {
  it('uses the one lifecycle coordinator with the semantic_edit origin, and never accepts, promotes, writes source or commits itself', async () => {
    const apply = await src(APPLY);
    expect(apply.match(/createFrontendBackendLifecycleCoordinator\(\{/g)).toHaveLength(1);
    expect(apply).toContain("const built = await coordinator.run(intent.jobSpec, { kind: 'semantic_edit', intentId: intent._id });");
    expect(apply).not.toMatch(/acceptValidatedFrontendBackendCandidate|promoteAcceptedFrontendBackendCandidate|createFrontendBackendCandidateValidator|createTerraFrontendBackendHandler|JobRunner/);
    expect(apply).not.toMatch(/writeSiteFiles|\.commit\(|clearSite|editSiteSemantically|buildSite\(|runtime\.invoke/);
    expect(apply).not.toMatch(/kind: 'replan'|kind: 'visual_refine'|ReplanSuccessorProvenance|VisualRefinementSuccessorProvenance/);
    // Promotion is recorded only after the lifecycle reports it.
    const promoted = apply.indexOf("if (built.outcome !== 'promoted')");
    expect(promoted).toBeGreaterThan(-1);
    expect(apply.indexOf('await finalizeBindingPromoted(store, successor._id')).toBeGreaterThan(promoted);
  });

  it('terra-edit is called only by the job handler, through its own skill and the job grant', async () => {
    const callers: string[] = [];
    for (const dir of ['packages/orchestrator/src', 'packages/customer-auth/src', 'apps/customer/app', 'apps/console/app', 'scripts']) {
      for (const file of await productionFiles(dir)) if (/editSiteSemantically\(/.test(await src(file))) callers.push(file);
    }
    expect(callers).toEqual(['packages/orchestrator/src/job-handlers/frontend-backend.ts']);
    const handler = await src('packages/orchestrator/src/job-handlers/frontend-backend.ts');
    const prepare = body(handler, 'async function prepareSemanticEdit(', '\n  }\n');
    expect(prepare).not.toMatch(/ProjectWorkspace|writeSiteFiles|registry\.put|registry\.accept|store\.|browser|git/i);
    expect(prepare).toContain('if (contentHash(source.files) !== source.filesDigest)');
    expect(prepare).toContain("provenance.kind !== 'semantic_patch'");
    // The same grant as every build: exactly the scaffold filesystem and the advisory test runner, intersected with the job's own.
    expect(handler).toContain("export const FRONTEND_BACKEND_SUPPORTED_TOOLS: readonly ToolId[] = Object.freeze(['filesystem', 'test_runner']);");
    expect(handler).toContain('grantedTools: effectiveTools(job.spec.allowedTools, FRONTEND_BACKEND_SUPPORTED_TOOLS),');
    expect(handler).toContain('createScaffoldFilesystemAdapter({ root: defaultTemplateRoot() }),');
    expect(handler).toContain("candidate = await prepareSemanticEdit(job, profile as RunFacts['profile'], plan as Parameters<typeof prepareBuildFromPlan>[1], toolAccess('terra-edit'), ctx.signal, siteModel);");

    const skill = await src('packages/agents/src/skills/terra-edit.ts');
    expect(skill).toContain("skill: 'terra-edit',");
    expect(skill).not.toMatch(/terra-build'|terra-refine'|terra-review'|images:|runtime\.invoke|ModelClient/);
    expect(imports(skill).sort()).toEqual(['../runtime.js', './terra-build.js', '@statxai/contracts'].sort());
  });

  it('validation holds an edit to the plan and to exactly M1, through the one validator', async () => {
    const validation = await src('packages/orchestrator/src/job-validation/frontend-backend.ts');
    expect(validation).toContain('const conformance = isVisualRefinementSpec(job.spec) || isSemanticEditSpec(job.spec) ? planConformanceFindings(candidate.files, plan) : [];');
    const guarded = validation.indexOf('assertModelWritableFiles(candidate.files);');
    expect(guarded).toBeGreaterThan(-1);
    expect(guarded).toBeLessThan(validation.indexOf('await ws.writeSiteFiles(candidate.files);'));
    const binding = await src('packages/orchestrator/src/run-binding/frontend-backend.ts');
    expect(binding).toContain("'spec pins semantic edit inputs, but the binding is not a semantic edit successor'");
  });
});

describe('an edit ends at a draft', () => {
  it('evaluates exactly the successor, never refines, and concludes it as a draft superseding the claimed one', async () => {
    const apply = await src(APPLY);
    expect(apply).toContain("authority: { mode: 'job_lifecycle', buildBindingId: successor._id, promotionId: promotion.promotionId, promotionCommitSha: promotion.promotionCommitSha },");
    expect(apply).toContain('editableSiteModel: intent.editableSiteModel,');
    expect(apply).not.toMatch(/authorizeVisualRefinement|refineSiteVisually|visual-refinement/);
    expect(apply).toContain('supersede: { draftId: intent.sourceDraftId, claimant },');
    expect(apply).not.toMatch(/releaseCanonicalDraftClaim|claimCanonicalDraft\(/);
  });

  it('never seeks, authorises or publishes a release', async () => {
    const apply = await src(APPLY);
    expect(imports(apply).filter((i) => /release|publish|policy-engine/.test(i))).toEqual([]);
    expect(apply).not.toMatch(/seekRelease|publishRelease|ensureReleasePublicationPrepared|deploySite|recommendApproval|adjudicate|release-authorization/);
  });

  it('draft authority supersedes only the exact handed-off draft, by its exact claimant, one generation back', async () => {
    const authority = await src('packages/orchestrator/src/canonical-draft/authority.ts');
    const conclude = body(authority, 'export async function concludeCanonicalDraft', '\n}\n');
    expect(conclude).toMatch(/authority\?\.state !== 'handed_off'[\s\S]*existing\._id !== input\.supersede\.draftId[\s\S]*!sameClaimant\(existing\.claim, claimant\)[\s\S]*tip\.predecessorBindingId !== existing\.canonicalBindingId/);
    expect(conclude).toMatch(/\{ _id: existing\._id, projectId, current: true, status: 'claimed', 'claim\.kind': claimant\.kind, 'claim\.operationId': claimant\.operationId \},\s*\{ \$unset: \{ current: '' \}, \$set: \{ supersededByDraftId: draftId, updatedAt: now \} \}/);
    const handoff = body(authority, 'export async function handOffCanonicalDraft', '\n}\n');
    expect(handoff).toMatch(/\{ _id: draft\.lineageRootBindingId, projectId, lineageRootBindingId: draft\.lineageRootBindingId, activeLineage: \{ \$exists: false \} \}/);
    expect(handoff).not.toMatch(/insertOne|prepareFrontendBackendBuildBinding/);
  });

  it('Phase 5q and runProject hand a handed-off draft to its edit, and never continue it as a run', async () => {
    const recovery = await src('packages/orchestrator/src/run-recovery/frontend-backend.ts');
    expect(recovery.match(/throw new ActiveContinuationSemanticEditOwned\(/g)).toHaveLength(2);
    expect(recovery).not.toMatch(/ActiveContinuationSuccessorNotOwned|applySemanticEdit|resumeSemanticEdit\(/);
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    const guard = orchestrator.indexOf('await assertNoCanonicalDraftOwnsRun(store, projectId);');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(orchestrator.indexOf('const existingBinding = await findActivePreparedBinding(store, projectId);'));
    expect(orchestrator).not.toMatch(/semantic-edit\/apply|applySemanticEdit/);
  });
});

describe('authority separation', () => {
  it('the edit service reads no cookie, session, token or header, and records only a customer user id for audit', async () => {
    const apply = await src(APPLY);
    expect(apply).not.toMatch(/cookie|session(Id|Token)|bearer|authorization|headers|oidc|password|@statxai\/customer-auth|email/i);
    expect(apply).toContain("if (input.requestedBy !== undefined && (Object.keys(input.requestedBy).join() !== 'customerUserId' || !CUSTOMER_USER_ID.test(input.requestedBy.customerUserId)))");
    const documents = await src('packages/state/src/documents.ts');
    const intent = body(documents, 'export interface SemanticEditIntentDocument', '\n}');
    expect(intent).toMatch(/requestedBy\?: \{ customerUserId: string \};/);
    expect(intent).not.toMatch(/session|token|cookie|email/i);
  });

  it('customer authentication reaches neither the edit service nor build authority; the customer app submits edits only through the customer editor', async () => {
    for (const file of [...(await productionFiles('packages/customer-auth/src')), ...(await productionFiles('apps/customer/app')), ...(await productionFiles('apps/customer/lib'))]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/@statxai\/orchestrator|applySemanticEdit|semantic-edit|canonicalDrafts|frontendBackendBuildBindings|semanticEditIntents/);
    }
    const routes = (await productionFiles('apps/customer/app')).filter((f) => f.endsWith('route.ts') || f.endsWith('page.tsx')).sort();
    expect(routes).toEqual([
      'apps/customer/app/api/auth/callback/route.ts',
      'apps/customer/app/api/auth/login/route.ts',
      'apps/customer/app/api/auth/logout/route.ts',
      'apps/customer/app/api/auth/me/route.ts',
      'apps/customer/app/api/projects/[projectId]/editor/route.ts',
      'apps/customer/app/api/projects/[projectId]/edits/[intentId]/route.ts',
      'apps/customer/app/api/projects/[projectId]/edits/route.ts',
      'apps/customer/app/api/projects/[projectId]/preview/[draftId]/[[...route]]/route.ts',
      'apps/customer/app/api/projects/route.ts',
      'apps/customer/app/page.tsx',
      'apps/customer/app/projects/[projectId]/editor/page.tsx',
      'apps/customer/app/projects/page.tsx',
    ]);
    // The editor submits durably and nothing else: it never applies, resumes or continues an edit.
    for (const file of await productionFiles('packages/customer-editor/src')) {
      expect(await src(file), file).not.toMatch(/applySemanticEdit|resumeSemanticEdit|resumeSemanticEditIntent|continueSemanticEdit|semanticEditIntents\./);
    }
    expect(await src('packages/customer-editor/src/edits.ts')).toMatch(/await submitSemanticEdit\(\{/);
    for (const file of await productionFiles('apps/console/app')) {
      expect(await src(file), file).not.toMatch(/applySemanticEdit|SemanticPatch|semantic-edit/);
    }
  });

  it('build lineage carries no customer or session identity', async () => {
    const lineage = await src('packages/contracts/src/build-lineage.ts');
    expect(body(lineage, 'export const SemanticEditSuccessorProvenance = z', '  .refine(')).not.toMatch(/customer|session|token|patch|intent/i);
    const job = await src('packages/contracts/src/job.ts');
    expect(job).toContain("z.strictObject({ kind: z.literal('semantic_edit'), intentId: z.string().regex(/^semantic-edit-[a-f0-9]{64}$/) }),");
  });
});
