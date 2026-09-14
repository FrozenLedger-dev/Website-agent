/**
 * Structural enforcement of canonical draft authority.
 *
 * A draft is a third owner, distinct from a run's active lineage and from a
 * release publication: only the draft module concludes, claims or releases one,
 * `draft` project state is written nowhere else, nothing about a draft is
 * decided by time, release proves the current tip before anything external, and
 * nothing here reaches semantic editing or customer authentication.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));

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
async function allProductionFiles(): Promise<string[]> {
  const packages = await readdir(join(REPO, 'packages'));
  return (await Promise.all([...packages.map((p) => `packages/${p}/src`), 'apps/console/app', 'apps/console/lib', 'apps/customer/app', 'apps/customer/lib', 'scripts'].map(productionFiles))).flat();
}
function body(code: string, start: string, end: string): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return code.slice(from, to);
}

const AUTHORITY = 'packages/orchestrator/src/canonical-draft/authority.ts';

describe('draft authority is its own owner', () => {
  it('adds `draft` to the project states, and keeps every historical state', async () => {
    const documents = await src('packages/state/src/documents.ts');
    const states = body(documents, 'export type ProjectState =', ';');
    for (const state of ['intake', 'intake_insufficient', 'planning', 'building', 'validating', 'awaiting_human_review', 'draft', 'releasing', 'released', 'blocked', 'rolled_back']) {
      expect(states).toContain(`'${state}'`);
    }
  });

  it('stores drafts in their own collection, with a durable one-current-per-project slot', async () => {
    const store = await src('packages/state/src/store.ts');
    expect(store).toMatch(/get canonicalDrafts\(\): Collection<CanonicalDraftDocument>[\s\S]*?'canonical_drafts'/);
    expect(store).toMatch(/this\.canonicalDrafts\.createIndexes\(\[\s*\{ key: \{ projectId: 1 \}, unique: true, partialFilterExpression: \{ current: true \}, name: 'projectId_1_currentDraft' \}/);

    const documents = await src('packages/state/src/documents.ts');
    const draft = body(documents, 'export interface CanonicalDraftDocument', '\n}');
    // Its own marker — never the lineage's or a publication's.
    expect(draft).toMatch(/current\?: true;/);
    expect(draft).not.toMatch(/activeLineage|active\?:/);
    expect(draft).toMatch(/status: 'available' \| 'claimed';/);
  });

  it('only the draft module writes `draft` state, draft documents or claims', async () => {
    for (const file of await allProductionFiles()) {
      if (file === AUTHORITY) continue;
      const code = await src(file);
      expect(code, file).not.toMatch(/state: 'draft'/);
      expect(code, file).not.toMatch(/canonicalDrafts\.(insertOne|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|bulkWrite)/);
    }
    const authority = await src(AUTHORITY);
    // One write of `draft` (conclusion); the handoff only ever matches on it.
    expect(authority.match(/\$set: \{ state: 'draft'/g)).toHaveLength(1);
    expect(authority.match(/state: 'draft'/g)).toHaveLength(2);
    expect(authority).toContain("{ _id: projectId, state: 'draft' }, { $set: { state: 'building', updatedAt: now } }");
    expect(authority.match(/canonicalDrafts\.insertOne/g)).toHaveLength(1);
  });

  it('`draft` state is written in the same transaction that inserts the draft and releases the active lineage', async () => {
    const authority = await src(AUTHORITY);
    const conclude = body(authority, 'export async function concludeCanonicalDraft', '\n}\n');
    const txn = body(conclude, 'store.withTransaction(async (session) => {', 'return { draft, replayed: false };');
    const insert = txn.indexOf('canonicalDrafts.insertOne(draft, { session })');
    const state = txn.indexOf("$set: { state: 'draft'");
    const release = txn.indexOf("$unset: { activeLineage: '' }");
    expect(insert).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(insert);
    expect(release).toBeGreaterThan(state);
    // Each write is conditional and counted, inside the session.
    expect(txn).toMatch(/updateOne\(\{ _id: projectId, state: project\.state \}[\s\S]*?\{ session \}\);\s*if \(moved\.matchedCount !== 1\)/);
    expect(txn).toMatch(/\{ _id: root\._id, projectId, activeLineage: true \}[\s\S]*?\{ session \},\s*\);\s*if \(released\.matchedCount !== 1\)/);
    // The proof precedes the writes: tip, promotion, release owner, existing draft.
    for (const proof of ['deriveActiveLineageTip(store, root, { session })', 'provePromotion(store, tip', 'releaseOwner(store, projectId, root._id', 'canonicalDrafts.findOne(']) {
      expect(txn.indexOf(proof), proof).toBeGreaterThan(-1);
      expect(txn.indexOf(proof), proof).toBeLessThan(insert);
    }
  });

  it('decides nothing by time: no ordering, age, lease or clock in draft authority or tip proofs', async () => {
    const authority = await src(AUTHORITY);
    expect(authority).not.toMatch(/\.sort\(|createdAt:\s*\{|updatedAt:\s*\{|\$lte?\b|\$gte?\b|Date\.now|expiresAt|\blease|heartbeat|timeout|Math\.random|randomUUID|\bnewest\b|\blatest\b/i);
    // Timestamps are only ever written, never filtered on.
    for (const filter of authority.match(/updateOne\(\s*\{[^}]*\}/g) ?? []) expect(filter).not.toMatch(/createdAt|updatedAt/);
    expect(body(authority, 'export function canonicalDraftId', '\n}\n')).not.toMatch(/Date|now|random/);

    const binding = await src('packages/orchestrator/src/run-binding/frontend-backend.ts');
    for (const fn of [body(binding, 'export async function deriveLineageTipFromRoot', '\n}\n'), body(binding, 'export async function assertReleaseBuildIsCurrentTip', '\n}\n')]) {
      expect(fn).not.toMatch(/\.sort\(|createdAt|updatedAt|Date\.now|newest|latest/i);
    }
  });

  it('the active lineage walk requires the active slot; the exact-root walk is the one shared structure', async () => {
    const binding = await src('packages/orchestrator/src/run-binding/frontend-backend.ts');
    const active = body(binding, 'export async function deriveActiveLineageTip', '\n}\n');
    expect(active).toMatch(/if \(root\.activeLineage !== true\) \{\s*throw new FrontendBackendBuildLineageCorrupt/);
    expect(active).toMatch(/return deriveLineageTipFromRoot\(store, root, options\);/);
    const walk = body(binding, 'export async function deriveLineageTipFromRoot', '\n}\n');
    expect(walk).toMatch(/does not branch/);
    expect(walk).toMatch(/countDocuments\(/);
  });

  it('a draft proves its tip from its exact stored root, never from an active lineage', async () => {
    const authority = await src(AUTHORITY);
    const prove = body(authority, 'async function proveDraft', '\n}\n');
    expect(prove).toMatch(/findOne\(\{ _id: draft\.lineageRootBindingId, projectId \}/);
    expect(prove).toMatch(/deriveLineageTipFromRoot\(store, root, options\)/);
    expect(prove).toMatch(/activeLineage: true[\s\S]*?if \(active\) throw corrupt/);
    expect(prove).toMatch(/provePromotion\(store, tip, draft/);
    expect(prove).toMatch(/releaseOwner\(store, projectId, root\._id/);
  });

  it('a claim is a compare-and-set on the exact draft, build and availability — and a release on the exact holder', async () => {
    const authority = await src(AUTHORITY);
    const claim = body(authority, 'async function claimInSession', '\n}\n');
    expect(body(authority, 'export async function claimCanonicalDraft', '\n}\n')).toMatch(/parseCanonicalDraftClaimant\(input\.claimant\)/);
    expect(body(authority, 'export async function handOffCanonicalDraft', '\n}\n')).toMatch(/parseCanonicalDraftClaimant\(input\.claimant\)[\s\S]*claimInSession\(store, input, claimant, session\)/);
    expect(claim).toMatch(/\{ _id: draft\._id, projectId, current: true, status: 'available', canonicalBindingId: input\.expectedCanonicalBindingId \}/);
    expect(claim).toMatch(/if \(result\.matchedCount !== 1\) throw new CanonicalDraftClaimConflict/);
    const current = body(authority, 'async function currentForClaim', '\n}\n');
    expect(current).toMatch(/draft\._id !== input\.expectedDraftId[\s\S]*?'stale_draft'/);
    expect(current).toMatch(/draft\.canonicalBindingId !== input\.expectedCanonicalBindingId[\s\S]*?'stale_tip'/);
    const release = body(authority, 'export async function releaseCanonicalDraftClaim', '\n}\n');
    expect(release).toMatch(/status: 'claimed', 'claim\.kind': claimant\.kind, 'claim\.operationId': claimant\.operationId/);
  });

  it('a claimant is a kind and an operation id — never a person, session or credential', async () => {
    const documents = await src('packages/state/src/documents.ts');
    const claimant = body(documents, 'export interface CanonicalDraftClaimant', '\n}');
    expect(claimant.replace(/\s+/g, ' ')).toMatch(/\{ kind: CanonicalDraftClaimKind; operationId: string;$/);
    expect(await src(AUTHORITY)).not.toMatch(/session(Id|Token)|cookie|bearer|oidc|password|customerUserId|email/i);
  });
});

describe('Phase 5q and run start', () => {
  it('Phase 5q asks for a concluded draft exactly when no run owns the project, and refuses both owners at once', async () => {
    const recovery = await src('packages/orchestrator/src/run-recovery/frontend-backend.ts');
    const resolve = body(recovery, 'export async function resolvePostPromotionRecovery', '\n}\n');
    const noRoot = body(resolve, 'if (!root) {', 'const tip = await deriveActiveLineageTip');
    expect(noRoot).toMatch(/loadCurrentCanonicalDraft\(store, projectId\)[\s\S]*?if \(!draft\) return null;[\s\S]*?assertCanonicalDraftPromotionMarker[\s\S]*?throw new ActiveContinuationConcludedDraft/);
    expect(noRoot).toMatch(/canonicalDrafts\.findOne\(\{ projectId, current: true \}\)[\s\S]*?throw new ActiveContinuationCorrupt/);
    expect(resolve).toMatch(/projectDoc\.state === 'draft'\) \{\s*throw new ActiveContinuationCorrupt/);
    // A concluded draft is not recovered: nothing after the refusal evaluates, approves or publishes.
    expect(noRoot).not.toMatch(/evaluate|seekRelease|publish/);
    const legacy = body(recovery, 'export async function assertNoActiveLineageForLegacyDirect', '\n}\n');
    expect(legacy).toMatch(/loadCurrentCanonicalDraft[\s\S]*?throw new ActiveContinuationConcludedDraft/);
  });

  it('runProject reaches the draft check before discovery on both execution modes', async () => {
    const orchestrator = await src('packages/orchestrator/src/orchestrator.ts');
    const recover = orchestrator.indexOf('recovered = await resolvePostPromotionRecovery(');
    const legacy = orchestrator.indexOf('await assertNoActiveLineageForLegacyDirect(store, projectId)');
    const discoveries = [...orchestrator.matchAll(/discovery = await discoverProject\(/g)].map((m) => m.index!);
    expect(discoveries).toHaveLength(2);
    expect(recover).toBeGreaterThan(-1);
    expect(recover).toBeLessThan(discoveries[0]!);
    expect(legacy).toBeGreaterThan(-1);
    expect(legacy).toBeLessThan(discoveries[1]!);
    // A run concludes a draft in exactly one place — a draft-targeted run's completion — and never claims or releases one.
    expect(orchestrator.match(/concludeCanonicalDraft\(/g)).toHaveLength(1);
    expect(orchestrator).not.toMatch(/claimCanonicalDraft|releaseCanonicalDraftClaim|handOffCanonicalDraft/);
  });

  it('a fresh root is refused while a draft is current', async () => {
    const binding = await src('packages/orchestrator/src/run-binding/frontend-backend.ts');
    const prepare = body(binding, 'export async function prepareFrontendBackendBuildBinding', '\n}\n');
    const guard = prepare.indexOf('canonicalDrafts.findOne({ projectId: input.projectId, current: true })');
    expect(guard).toBeGreaterThan(-1);
    expect(prepare.slice(guard - 60, guard)).toMatch(/if \(!input\.lineage\) \{/);
    expect(guard).toBeLessThan(prepare.indexOf('frontendBackendBuildBindings.insertOne(prepared)'));
  });
});

describe('release publishes only the current tip', () => {
  it('publishRelease proves the current tip before project state, receipts, Git or the provider', async () => {
    const publish = await src('packages/orchestrator/src/phases/publish.ts');
    const fn = body(publish, 'export async function publishRelease', '\n}\n');
    const fence = fn.indexOf('await assertReleaseBuildIsCurrentTip(deps.store, facts.projectId, options.canonicalBuildBindingId)');
    expect(fence).toBeGreaterThan(-1);
    expect(fn.slice(fence - 90, fence)).toMatch(/if \(options\.canonicalBuildBindingId !== undefined\) \{/);
    for (const later of ["state: 'releasing'", 'deploymentConfigured()', 'ensureReleasePublicationPrepared(', 'establishReleaseCommit(', 'beginPublicationAttempt(', 'gateway.deploy(', 'writeManifest(']) {
      expect(fn.indexOf(later), later).toBeGreaterThan(fence);
    }
  });

  it('the tip proof is the active structural tip, compared by exact id', async () => {
    const binding = await src('packages/orchestrator/src/run-binding/frontend-backend.ts');
    const fence = body(binding, 'export async function assertReleaseBuildIsCurrentTip', '\n}\n');
    expect(fence).toMatch(/findActiveLineageRoot\(store, projectId\)/);
    expect(fence).toMatch(/if \(!root\) throw new FrontendBackendReleaseBuildNotCurrent/);
    expect(fence).toMatch(/deriveActiveLineageTip\(store, root\)/);
    expect(fence).toMatch(/if \(tip\._id !== bindingId\) \{\s*throw new FrontendBackendReleaseBuildNotCurrent/);
  });

  it('a draft cannot coexist with release authority', async () => {
    const authority = await src(AUTHORITY);
    const owner = body(authority, 'async function releaseOwner', '\n}\n');
    expect(owner).toMatch(/\{ projectId, \$or: \[\{ active: true \}, \{ 'buildAuthority\.lineageRootBindingId': lineageRootBindingId \}\] \}/);
    expect(body(authority, 'export async function concludeCanonicalDraft', '\n}\n')).toMatch(/if \(owner\) throw refuse/);
    expect(body(authority, 'async function proveDraft', '\n}\n')).toMatch(/if \(owner\) throw corrupt/);
    // Draft authority never publishes, and publication never reaches into drafts.
    expect(authority).not.toMatch(/release-publication|phases\/publish|deploySite|vercel/i);
    expect(await src('packages/orchestrator/src/release-publication/publication.ts')).not.toMatch(/canonical-draft|canonicalDrafts/);
  });
});

describe('scope', () => {
  it('draft authority knows semantic editing only as the one kind of operation that builds from a draft', async () => {
    const authority = await src(AUTHORITY);
    expect(authority.match(/semantic_edit/g)).toHaveLength(2);
    expect(authority).toContain("const HANDOFF_KINDS: ReadonlySet<CanonicalDraftClaimant['kind']> = new Set<CanonicalDraftClaimant['kind']>(['semantic_edit']);");
    expect(authority).not.toMatch(/terra-edit|semanticEditIntents|applySemanticEdit|coordinator|evaluateSite/);
  });

  it('customer authentication neither reaches draft or build authority nor gains an edit route', async () => {
    for (const file of [...(await productionFiles('packages/customer-auth/src')), ...(await productionFiles('apps/customer/app')), ...(await productionFiles('apps/customer/lib'))]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/@statxai\/orchestrator|canonical-draft|canonicalDrafts|claimCanonicalDraft|frontendBackendBuildBindings|promotions|releasePublications/);
    }
    const routes = (await productionFiles('apps/customer/app')).filter((f) => f.endsWith('route.ts')).sort();
    expect(routes).toEqual(['apps/customer/app/api/auth/callback/route.ts', 'apps/customer/app/api/auth/login/route.ts', 'apps/customer/app/api/auth/logout/route.ts', 'apps/customer/app/api/auth/me/route.ts']);
    expect((await productionFiles('apps/customer/app')).filter((f) => /page\.tsx$/.test(f))).toEqual([]);
  });
});
