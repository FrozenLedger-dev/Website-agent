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

/**
 * A project with no current draft yet is either genuinely untouched, or has an
 * initial generation under way or stopped — three different things to show, all
 * still `draft: 'none'` for compatibility with existing draft-editability
 * display logic. `null` while the project has (or never had) a generation
 * request; the projects list never opens the editor for `'in_progress'`.
 */
export type InitialGenerationSummary = 'in_progress' | 'failed';

export interface CustomerProjectSummary {
  readonly projectId: string;
  /** A human-readable name for the project, derived from its intake when the project itself names nothing. Never the project id. */
  readonly displayName: string;
  readonly accountName: string;
  readonly role: 'owner' | 'editor' | 'viewer';
  readonly draft: 'none' | DraftEditability;
  readonly generation: InitialGenerationSummary | null;
}

/** Every active account this customer may create a project in. */
export interface CustomerCreateEligibleAccount {
  readonly accountId: string;
  readonly displayName: string;
}

/** The typed, customer-safe body of a project-creation refusal. */
export type CustomerProjectCreateError = 'unauthenticated' | 'forbidden' | 'invalid_request' | 'account_required' | 'too_many_active';

/** Where a requested initial draft generation stands, in terms a customer route can show directly. */
export type CustomerGenerationState = 'queued' | 'planning' | 'building' | 'validating' | 'finishing' | 'completed' | 'failed';

/** A generation failure a customer may be told about. Nothing internal. */
export type CustomerGenerationFailure = 'invalid_request' | 'generation_failed' | 'temporarily_unavailable' | 'needs_attention';

export interface CustomerProjectCreateAccepted {
  readonly creationRequestId: string;
  readonly projectId: string;
  /** Usually `queued`; an exact replay of an already-progressed request reports its real current state. */
  readonly status: CustomerGenerationState;
}

export interface CustomerGenerationStatusView {
  readonly projectId: string;
  readonly state: CustomerGenerationState;
  readonly failure: CustomerGenerationFailure | null;
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
