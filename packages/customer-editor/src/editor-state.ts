/**
 * The one customer editor-state loader.
 *
 *   authorised to view (persisted tenancy; any denial is "not found")
 *     → the project's exact current canonical draft, fully re-proven — available,
 *       or handed off to the operation that claimed it
 *     → that draft's exact build
 *     → the exact editable-site-model ref that build pinned, resolved exactly
 *     → the exact site-export-snapshot the draft names, proven to be of exactly
 *       that build, promotion and model
 *     → while a semantic edit holds the draft: its customer-safe status
 *
 * Nothing is looked up as "latest": not a model, not a snapshot, not a draft.
 * While an edit runs, the draft it was made against stays the editor's authority
 * — its model and its snapshot — until the edit concludes a new current draft;
 * the edit's own result model is never shown as canonical.
 *
 * Two outputs from one resolution: the bounded DTO a browser receives, and the
 * exact internal authority server routes act on (the preview route serves only
 * this snapshot; the edit route submits only against this draft, build and model).
 */
import type { ArtifactRef, EditableSiteModel, SiteExportSnapshot } from '@statxai/contracts';
import { authorizeCustomerProjectView, CUSTOMER_ROLE_PERMISSIONS, type CustomerPrincipal, type CustomerProjectAuthorization } from '@statxai/customer-auth';
import {
  FRONTEND_BACKEND_INPUT,
  readSemanticEditExecutionStatus,
  resolveCanonicalDraftAuthority,
  resolveEditableSiteModel,
  type SemanticEditExecutionStatus,
} from '@statxai/orchestrator';
import type { CanonicalDraftDocument, CustomerRole, StateStore } from '@statxai/state';
import { ArtifactRegistry, readSiteExportSnapshot, resolveSiteExportRequest } from '@statxai/workspace';
import type { CustomerEditorState, CustomerEditStatusView, DraftEditability, ExactRefView } from './dto.js';
import { editorModelView } from './model-view.js';

/** The exact authority one editor state was resolved from. Server-only; never serialised. */
export interface EditorDraftAuthority {
  readonly projectId: string;
  readonly role: CustomerRole;
  readonly draft: CanonicalDraftDocument;
  readonly handedOff: boolean;
  readonly canonicalBindingId: string;
  readonly modelRef: ArtifactRef & { readonly contentHash: string };
  readonly model: EditableSiteModel;
  readonly snapshotRef: ArtifactRef & { readonly contentHash: string };
  readonly snapshot: SiteExportSnapshot;
  readonly edit: SemanticEditExecutionStatus | null;
}

export type CustomerEditorLoad =
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: true; readonly state: CustomerEditorState; readonly authority: EditorDraftAuthority | null; readonly authorization: Extract<CustomerProjectAuthorization, { allowed: true }> };

const exactView = (ref: ArtifactRef & { readonly contentHash: string }): ExactRefView => ({ name: ref.name, version: ref.version, contentHash: ref.contentHash });
const hasHash = (ref: ArtifactRef | undefined | null): ref is ArtifactRef & { contentHash: string } => !!ref && typeof ref.contentHash === 'string' && ref.contentHash.length > 0;
const sameExactRef = (a: ArtifactRef, b: ArtifactRef) => a.name === b.name && a.version === b.version && hasHash(a) && a.contentHash === b.contentHash;

/** Proven internally, but not something the draft can be edited or previewed from. */
class DraftNotUsable extends Error {}

export function customerEditStatusView(status: SemanticEditExecutionStatus): CustomerEditStatusView {
  return { intentId: status.intentId, state: status.state, failure: status.failure, baseDraftId: status.sourceDraftId, resultDraftId: status.resultDraftId };
}

async function resolveAuthority(store: StateStore, projectId: string, role: CustomerRole): Promise<EditorDraftAuthority | null> {
  const resolved = await resolveCanonicalDraftAuthority(store, projectId);
  if (!resolved) return null;
  const { draft } = resolved;

  const build = await store.frontendBackendBuildBindings.findOne({ _id: draft.canonicalBindingId, projectId });
  if (!build) throw new DraftNotUsable('draft build missing');
  const modelRef = build.jobSpec.inputs[FRONTEND_BACKEND_INPUT.editableSiteModel];
  if (!hasHash(modelRef)) throw new DraftNotUsable('draft build pins no exact editable model');
  const registry = new ArtifactRegistry(store);
  const model = await resolveEditableSiteModel(registry, projectId, modelRef);

  const snapshotRef = draft.siteExportSnapshot;
  if (!hasHash(snapshotRef)) throw new DraftNotUsable('draft names no exact export snapshot');
  const snapshot = await readSiteExportSnapshot(registry, projectId, snapshotRef);
  const authority = snapshot.subject.authority;
  if (
    authority.mode !== 'job_lifecycle' ||
    authority.buildBindingId !== draft.canonicalBindingId ||
    authority.promotionId !== draft.promotionId ||
    authority.promotionCommitSha !== draft.promotionCommitSha ||
    !snapshot.subject.editableSiteModel ||
    !sameExactRef(snapshot.subject.editableSiteModel, modelRef)
  ) {
    throw new DraftNotUsable('the snapshot is not of exactly this draft build and model');
  }

  let edit: SemanticEditExecutionStatus | null = null;
  if (draft.claim?.kind === 'semantic_edit') {
    edit = await readSemanticEditExecutionStatus(store, projectId, draft.claim.operationId);
    // The current draft's own edit has not concluded a successor; anything else contradicts authority.
    if (!edit || edit.sourceDraftId !== draft._id || edit.state === 'completed') throw new DraftNotUsable('the draft claim names no matching edit');
  }
  return { projectId, role, draft, handedOff: resolved.state === 'handed_off', canonicalBindingId: draft.canonicalBindingId, modelRef, model, snapshotRef, snapshot, edit };
}

function editabilityOf(authority: EditorDraftAuthority): DraftEditability {
  if (authority.draft.status === 'available' && !authority.handedOff) return 'ready_to_edit';
  if (authority.edit) return authority.edit.state === 'failed' ? 'edit_failed' : 'edit_in_progress';
  return 'busy';
}

/**
 * The editor state for one customer and one project. `not_found` for every
 * authorisation denial, so a project id alone reveals nothing. A draft whose
 * authority fails to prove is reported as unavailable — never with the cause.
 */
export async function loadCustomerEditorState(store: StateStore, principal: CustomerPrincipal, projectId: string): Promise<CustomerEditorLoad> {
  const authorization = await authorizeCustomerProjectView(store, principal, projectId);
  if (!authorization.allowed) return { ok: false, reason: 'not_found' };
  const account = await store.customerAccounts.findOne({ _id: authorization.accountId });
  const project = { projectId, accountName: account?.displayName ?? '' };
  const canEdit = CUSTOMER_ROLE_PERMISSIONS[authorization.role].includes('edit');
  const unavailable = (reason: 'no_draft' | 'draft_unavailable'): CustomerEditorLoad => ({
    ok: true,
    authorization,
    authority: null,
    state: { kind: 'unavailable', project, unavailable: reason, permissions: { canEdit, canSubmit: false } },
  });

  let authority: EditorDraftAuthority | null;
  try {
    authority = await resolveAuthority(store, projectId, authorization.role);
  } catch {
    return unavailable('draft_unavailable');
  }
  if (!authority) return unavailable('no_draft');

  const editability = editabilityOf(authority);
  const routes = [];
  for (const page of authority.model.pages) {
    const title = page.fields.find((f) => f.key === 'title');
    let available = false;
    try {
      available = ((await resolveSiteExportRequest(authority.snapshot, page.route === '/' ? '' : page.route)) ?? '').endsWith('.html');
    } catch {
      available = false;
    }
    routes.push({ route: page.route, pageId: page.pageId, title: typeof title?.value === 'string' ? title.value : page.route, available });
  }

  return {
    ok: true,
    authorization,
    authority,
    state: {
      kind: 'draft',
      project,
      draft: { draftId: authority.draft._id, editability, editableSiteModel: exactView(authority.modelRef), siteExportSnapshot: exactView(authority.snapshotRef) },
      model: editorModelView(authority.model),
      preview: { routes },
      permissions: { canEdit, canSubmit: canEdit && editability === 'ready_to_edit' },
      edit: authority.edit ? customerEditStatusView(authority.edit) : null,
    },
  };
}
