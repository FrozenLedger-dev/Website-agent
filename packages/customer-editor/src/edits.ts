/**
 * Submitting one customer semantic edit, and reading where it stands.
 *
 * Submission is durable handoff only: it proves the request against the exact
 * current draft, build and model, and calls `submitSemanticEdit` — which records
 * the claim, the result model, the source snapshot and the intent, and returns.
 * No model, build, validation, promotion, evaluation or release runs in the
 * request; the standalone semantic-edit worker continues the edit.
 *
 * The browser supplies exactly the concurrency inputs — the draft it was
 * looking at, the exact model it edited, and the patch. Account, role, build,
 * job, worker or source are never read from it; a body carrying anything else is
 * refused.
 */
import * as z from 'zod/v4';
import { ArtifactRef, SemanticPatch } from '@statxai/contracts';
import type { CustomerPrincipal } from '@statxai/customer-auth';
import { SemanticEditRefused, readSemanticEditExecutionStatus, submitSemanticEdit } from '@statxai/orchestrator';
import type { StateStore } from '@statxai/state';
import type { CustomerEditAccepted, CustomerEditStatusView } from './dto.js';
import { customerEditStatusView, type EditorDraftAuthority } from './editor-state.js';

/** The largest edit request body read. */
export const MAX_EDIT_REQUEST_BYTES = 64 * 1024;

export const CustomerEditRequest = z.strictObject({
  expectedDraftId: z.string().min(1).max(200),
  /** Exactly the contract's base-model ref: an exact, hash-carrying model version. */
  baseModel: SemanticPatch.shape.baseModel,
  patch: z.unknown(),
});
export type CustomerEditRequest = z.infer<typeof CustomerEditRequest>;

export const SEMANTIC_EDIT_INTENT_ID = /^semantic-edit-[a-f0-9]{64}$/;

export type CustomerEditSubmission =
  | { readonly ok: true; readonly accepted: CustomerEditAccepted }
  | { readonly ok: false; readonly error: 'invalid_edit' | 'stale_revision' | 'edit_in_progress' | 'edit_unavailable' };

const sameExactRef = (a: ArtifactRef, b: ArtifactRef) => a.name === b.name && a.version === b.version && typeof a.contentHash === 'string' && a.contentHash === b.contentHash;

/**
 * Submit one edit against the exact authority the caller resolved for a customer
 * already authorised to edit this project.
 */
export async function submitCustomerSemanticEdit(input: {
  readonly store: StateStore;
  readonly workspacesRoot: string;
  readonly validationWorkspacesRoot: string;
  readonly principal: CustomerPrincipal;
  readonly authority: EditorDraftAuthority;
  readonly request: CustomerEditRequest;
}): Promise<CustomerEditSubmission> {
  const { authority, request } = input;
  if (authority.handedOff || authority.draft.status !== 'available') return { ok: false, error: 'edit_in_progress' };
  if (request.expectedDraftId !== authority.draft._id || !sameExactRef(request.baseModel, authority.modelRef)) return { ok: false, error: 'stale_revision' };
  const patchBase = (request.patch as { baseModel?: unknown } | null)?.baseModel;
  const parsedBase = ArtifactRef.safeParse(patchBase);
  if (!parsedBase.success || !sameExactRef(parsedBase.data, request.baseModel)) return { ok: false, error: 'invalid_edit' };

  try {
    const result = await submitSemanticEdit({
      store: input.store,
      workspacesRoot: input.workspacesRoot,
      validationWorkspacesRoot: input.validationWorkspacesRoot,
      projectId: authority.projectId,
      expectedDraftId: authority.draft._id,
      expectedCanonicalBindingId: authority.canonicalBindingId,
      baseEditableSiteModel: authority.modelRef,
      patch: request.patch,
      requestedBy: { customerUserId: input.principal.customerUserId },
    });
    const status = await readSemanticEditExecutionStatus(input.store, authority.projectId, result.intentId);
    return {
      ok: true,
      accepted: {
        intentId: result.intentId,
        state: status?.state ?? 'queued',
        baseDraftId: result.sourceDraftId,
        baseModel: { name: authority.modelRef.name, version: authority.modelRef.version, contentHash: authority.modelRef.contentHash },
      },
    };
  } catch (error) {
    if (!(error instanceof SemanticEditRefused)) throw error;
    switch (error.reason) {
      case 'invalid_patch':
        return { ok: false, error: error.patchRejection === 'stale_expectation' || error.patchRejection === 'base_mismatch' ? 'stale_revision' : 'invalid_edit' };
      case 'stale_draft':
      case 'stale_tip':
      case 'stale_base':
      case 'no_current_draft':
        return { ok: false, error: 'stale_revision' };
      case 'draft_claimed':
        return { ok: false, error: 'edit_in_progress' };
      case 'source_unavailable':
      case 'source_too_large':
        return { ok: false, error: 'edit_unavailable' };
    }
  }
}

/** One edit's customer-safe status, by exact project and intent id. `null` when the project has no such edit. */
export async function readCustomerEditStatus(store: StateStore, projectId: string, intentId: string): Promise<CustomerEditStatusView | null> {
  if (!SEMANTIC_EDIT_INTENT_ID.test(intentId)) return null;
  const status = await readSemanticEditExecutionStatus(store, projectId, intentId);
  return status ? customerEditStatusView(status) : null;
}
