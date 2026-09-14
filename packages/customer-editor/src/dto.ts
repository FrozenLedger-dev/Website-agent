/**
 * What a customer browser is told about projects and their current draft.
 * Browser-safe types only.
 *
 * Bounded by construction: exact refs the editor needs for concurrency, the
 * customer-safe model view, the preview routes, permissions and a customer-safe
 * edit status. Never a raw document, a build or promotion id, a lineage, a job,
 * a lease or token, a provider message or an internal error.
 */
import type { EditorModelView } from './model-view.js';
import type { CustomerEditFailure, CustomerEditState } from './messages.js';

export interface ExactRefView {
  readonly name: string;
  readonly version: number;
  readonly contentHash: string;
}

/**
 * The draft's editability, in customer terms. A draft is valid, evaluated and
 * editable — never "approved" or "ready to publish".
 */
export type DraftEditability =
  /** Available: an edit may be submitted. */
  | 'ready_to_edit'
  /** Handed to an edit that is still queued, running or finishing. */
  | 'edit_in_progress'
  /** Handed to an edit that stopped for good; the draft stays held by it. */
  | 'edit_failed'
  /** Held by some other operation. */
  | 'busy';

export type EditorUnavailable =
  /** The project has no current draft yet. */
  | 'no_draft'
  /** The draft exists but has no exact preview or model this editor can use, or its authority failed to prove. */
  | 'draft_unavailable';

export interface CustomerEditStatusView {
  readonly intentId: string;
  readonly state: CustomerEditState;
  readonly failure: CustomerEditFailure | null;
  /** The draft the edit was made against. */
  readonly baseDraftId: string;
  /** Present exactly when `completed`. */
  readonly resultDraftId: string | null;
}

export interface CustomerEditorPreviewRoute {
  readonly route: string;
  readonly pageId: string;
  readonly title: string;
  /** Whether the exact snapshot has a document for this route. */
  readonly available: boolean;
}

export type CustomerEditorState =
  | {
      readonly kind: 'unavailable';
      readonly project: { readonly projectId: string; readonly accountName: string };
      readonly unavailable: EditorUnavailable;
      readonly permissions: { readonly canEdit: boolean; readonly canSubmit: false };
    }
  | {
      readonly kind: 'draft';
      readonly project: { readonly projectId: string; readonly accountName: string };
      readonly draft: {
        readonly draftId: string;
        readonly editability: DraftEditability;
        readonly editableSiteModel: ExactRefView;
        readonly siteExportSnapshot: ExactRefView;
      };
      readonly model: EditorModelView;
      readonly preview: { readonly routes: readonly CustomerEditorPreviewRoute[] };
      readonly permissions: {
        /** The customer's role may edit this project. */
        readonly canEdit: boolean;
        /** An edit may be submitted right now: the role may edit and the draft is available. */
        readonly canSubmit: boolean;
      };
      readonly edit: CustomerEditStatusView | null;
    };

export interface CustomerProjectSummary {
  readonly projectId: string;
  readonly accountName: string;
  readonly role: 'owner' | 'editor' | 'viewer';
  readonly draft: 'none' | DraftEditability;
}

/** The typed, customer-safe body of every non-success editor response. */
export type CustomerEditorError =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_edit'
  | 'stale_revision'
  | 'edit_in_progress'
  | 'edit_unavailable'
  | 'preview_unavailable'
  | 'preview_too_large'
  | 'unavailable';

export interface CustomerEditAccepted {
  readonly intentId: string;
  readonly state: CustomerEditState;
  readonly baseDraftId: string;
  readonly baseModel: ExactRefView;
}
