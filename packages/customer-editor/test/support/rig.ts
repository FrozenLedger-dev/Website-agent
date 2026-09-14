/**
 * The customer editor's integration rig: a real canonical draft D0 — built,
 * validated, accepted and promoted through the real lifecycle, evaluated, with
 * its exact immutable export snapshot — owned by a real customer account, and
 * the real semantic-edit worker to continue edits submitted against it.
 *
 * Faked (see `rig-mocks.ts`), exactly as in the semantic-edit suites: the model skills, the compiler
 * (a faithful one: the page files a build wrote become its export, together with
 * a Next-style static asset set), the gates and the browser capture. Suites
 * register the fakes with `vi.mock(..., () => rigMocks.x(...))` and share this
 * module's call record.
 *
 * Test support only.
 */
import type { ArtifactRef, EditableSiteModel } from '@statxai/contracts';
import { ModelRuntime } from '@statxai/agents';
import { JobEngine } from '@statxai/job-engine';
import {
  bindProjectToCustomerAccount,
  createCustomerAccount,
  createCustomerSession,
  customerCookieName,
  grantCustomerMembership,
  resolveCustomerUser,
  type CustomerPrincipal,
} from '@statxai/customer-auth';
import { createBudget, type CanonicalDraftDocument, type CustomerRole, type FrontendBackendBuildBindingDocument, type StateStore } from '@statxai/state';
import { ArtifactRegistry, ProjectWorkspace } from '@statxai/workspace';
import { INTAKE, PLAN } from './rig-mocks.js';
import { computeRunIntentHash, ensureSpecificationCommitted, finalizeBindingPromoted, prepareFrontendBackendBuildBinding, rehydrateSpecificationFiles } from '../../../orchestrator/src/run-binding/frontend-backend.js';
import { createFrontendBackendJobSpec } from '../../../orchestrator/src/job-specs/frontend-backend.js';
import { createFrontendBackendLifecycleCoordinator } from '../../../orchestrator/src/job-lifecycle/frontend-backend.js';
import { validateIntake } from '../../../orchestrator/src/phases/discover.js';
import { evaluateSite } from '../../../orchestrator/src/phases/evaluate.js';
import { createRunProgress, snapshotProgress, type RunContext } from '../../../orchestrator/src/run-context.js';
import { modelFromPlan } from '../../../orchestrator/src/site-model/materialize.js';
import { recordEditableSiteModel } from '../../../orchestrator/src/site-model/persist.js';
import { concludeCanonicalDraft } from '../../../orchestrator/src/canonical-draft/authority.js';

// ---------------------------------------------------------------------------
// Durable fixtures
// ---------------------------------------------------------------------------

export const TEST_COLLECTIONS = [
  'jobs',
  'auditLog',
  'artifacts',
  'projects',
  'budgets',
  'defectBudgets',
  'promotions',
  'frontendBackendBuildBindings',
  'releasePublications',
  'visualRefinementIntents',
  'blobs',
  'canonicalDrafts',
  'semanticEditIntents',
  'customerUsers',
  'customerAccounts',
  'customerMemberships',
  'projectAccountBindings',
  'customerSessions',
] as const;

export async function clearStore(store: StateStore): Promise<void> {
  for (const name of TEST_COLLECTIONS) await (store[name] as unknown as { deleteMany(f: object): Promise<unknown> }).deleteMany({});
}

const profile = (() => {
  const validated = validateIntake(INTAKE);
  if (!validated.ok) throw new Error('fixture intake invalid');
  return validated.profile;
})();

export interface RigRoots {
  readonly store: StateStore;
  readonly workspacesRoot: string;
  readonly validationWorkspacesRoot: string;
}

export interface Draft {
  readonly projectId: string;
  readonly ws: ProjectWorkspace;
  readonly b0: FrontendBackendBuildBindingDocument;
  readonly m0: ArtifactRef & { contentHash: string };
  readonly model0: EditableSiteModel;
  readonly d0: CanonicalDraftDocument;
  readonly s0: ArtifactRef & { contentHash: string };
}

let counter = 0;

/** B0 built, validated, accepted and promoted through the real lifecycle, evaluated, and concluded as the available draft D0. */
export async function draftProject(roots: RigRoots, prefix = 'proj_editor'): Promise<Draft> {
  const { store, workspacesRoot, validationWorkspacesRoot } = roots;
  const registry = new ArtifactRegistry(store);
  const projectId = `${prefix}_${process.pid}_${(counter += 1)}`;
  const ws = await ProjectWorkspace.open(projectId, workspacesRoot);
  await store.projects.insertOne({ _id: projectId, state: 'building', autonomyMode: 'full_autonomous', reviewCycle: 0, createdAt: new Date(), updatedAt: new Date() });
  await createBudget(store, projectId);
  const businessProfileRef = await registry.put(projectId, 'business-profile', profile);
  const sitePlanRef = await registry.put(projectId, 'site-plan', PLAN);
  const model = await recordEditableSiteModel(registry, projectId, modelFromPlan({ projectId, sitePlanRef, plan: PLAN }));
  const spec = createFrontendBackendJobSpec({ projectId, businessProfileRef, sitePlanRef, editableSiteModelRef: model.ref });
  const binding = await prepareFrontendBackendBuildBinding(store, { projectId, runIntentHash: computeRunIntentHash({ projectId, profile }), businessProfileRef, sitePlanRef, jobSpec: spec, specificationBaseCommit: await ws.currentCommit() });
  await rehydrateSpecificationFiles(ws, profile, PLAN);
  await ensureSpecificationCommitted(store, ws, binding, PLAN);
  const coordinator = createFrontendBackendLifecycleCoordinator({ store, registry, engine: new JobEngine(store), model: new ModelRuntime(), workerIdentity: { workerId: `fixture:${projectId}`, tier: 'terra' }, workspacesRoot, validationWorkspacesRoot });
  const built = await coordinator.run(spec);
  if (built.outcome !== 'promoted') throw new Error(`fixture build did not promote: ${built.outcome}`);
  await finalizeBindingPromoted(store, binding._id, { promotionId: built.promotionId, promotionCommitSha: built.commitSha });
  const b0 = (await store.frontendBackendBuildBindings.findOne({ _id: binding._id }))!;
  const progress = createRunProgress();
  progress.plan = PLAN;
  const context: RunContext = {
    deps: { store, registry, workspace: ws, model: new ModelRuntime(), say: () => {} },
    facts: { projectId, profile, autonomyMode: 'full_autonomous', budgetLimits: {} as never },
    progress: snapshotProgress(progress),
  };
  const evaluation = await evaluateSite(context, { sitePlan: sitePlanRef, editableSiteModel: model.ref, authority: { mode: 'job_lifecycle', buildBindingId: b0._id, promotionId: b0.promotionId, promotionCommitSha: b0.promotionCommitSha } });
  if (evaluation.kind !== 'evaluated' || !evaluation.siteExportSnapshot) throw new Error('fixture evaluation captured no export snapshot');
  const { draft } = await concludeCanonicalDraft({ store, registry, siteExportSnapshot: evaluation.siteExportSnapshot, workspace: ws, projectId, canonicalBindingId: b0._id, promotion: { promotionId: b0.promotionId, promotionCommitSha: b0.promotionCommitSha } });
  return { projectId, ws, b0, m0: model.ref as Draft['m0'], model0: model.model, d0: draft, s0: evaluation.siteExportSnapshot as Draft['s0'] };
}

export { PAGE_HEAD, PNG, rig, rigMocks, staticAssets } from './rig-mocks.js';

const ISSUER = 'https://idp.example.com';
let people = 0;

export interface Customer {
  readonly principal: CustomerPrincipal;
  readonly token: string;
}

/** A signed-in customer: a user by exact external identity, and a live server-side session. */
export async function customer(store: StateStore, name = 'person'): Promise<Customer> {
  const subject = `${name}-${process.pid}-${(people += 1)}`;
  const user = await resolveCustomerUser(store, { issuer: ISSUER, subject, email: `${subject}@example.com`, emailVerified: true, displayName: subject }, new Date());
  const session = await createCustomerSession(store, user._id, 3600, new Date());
  return { principal: { customerUserId: user._id, externalIdentity: { issuer: ISSUER, subject }, authMethod: 'oidc_session' }, token: session.token };
}

/** An account owning `projectIds`, with `members` in their roles. */
export async function tenant(store: StateStore, name: string, projectIds: readonly string[], members: readonly { readonly who: Customer; readonly role: CustomerRole }[]) {
  const account = await createCustomerAccount(store, { displayName: name });
  for (const projectId of projectIds) await bindProjectToCustomerAccount(store, { projectId, accountId: account._id, boundBy: 'operator:test' });
  for (const { who, role } of members) await grantCustomerMembership(store, { accountId: account._id, customerUserId: who.principal.customerUserId, role });
  return account;
}

export const APP_ORIGIN = 'https://app.statxai.example';
export const CONFIG = { appOrigin: APP_ORIGIN, secureCookies: true } as const;

export function cookieFor(who: Customer | null): Record<string, string> {
  return who ? { cookie: `${customerCookieName('session', CONFIG)}=${who.token}` } : {};
}
