/**
 * The customer editor HTTP surface, as framework-agnostic `Request → Response`
 * handlers. The customer app's route files do nothing but call these.
 *
 * Every handler authenticates through `requireCustomerPrincipal` — the customer
 * session cookie, never an Authorization header — and authorises the exact
 * project through the central tenancy checks before reading anything about it.
 * Every project denial is the same generic 404. Every body is bounded and
 * customer-safe; no internal error text, document, lease, token or provider
 * message is ever returned.
 *
 *   GET  /api/projects
 *   GET  /api/projects/:projectId/editor
 *   GET  /api/projects/:projectId/preview/:draftId/[...route]?channel=…
 *   POST /api/projects/:projectId/edits
 *   GET  /api/projects/:projectId/edits/:intentId
 */
import {
  authorizeCustomerProjectEdit,
  authorizeCustomerProjectView,
  customerProjectDenialResponse,
  customerUnauthenticatedResponse,
  isSameOriginCustomerMutation,
  requireCustomerPrincipal,
  type CustomerAuthConfig,
} from '@statxai/customer-auth';
import type { StateStore } from '@statxai/state';
import { BlobStore, readSiteExportFile, resolveSiteExportRequest } from '@statxai/workspace';
import type { CustomerEditorError } from './dto.js';
import { loadCustomerEditorState } from './editor-state.js';
import { CustomerEditRequest, MAX_EDIT_REQUEST_BYTES, readCustomerEditStatus, submitCustomerSemanticEdit } from './edits.js';
import { PREVIEW_CHANNEL } from './messages.js';
import { listCustomerProjects } from './projects.js';
import { EditorPreviewTooLarge, renderEditorPreviewDocument } from './preview/transport.js';

export interface CustomerEditorDeps {
  readonly store: StateStore;
  readonly config: Pick<CustomerAuthConfig, 'appOrigin' | 'secureCookies'>;
  /** Canonical project workspaces — read by edit submission to record the exact source. */
  readonly workspacesRoot: string;
  readonly validationWorkspacesRoot: string;
  readonly now?: () => Date;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function customerEditorErrorResponse(error: CustomerEditorError, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

async function principalOf(request: Request, deps: CustomerEditorDeps) {
  const auth = await requireCustomerPrincipal(request, deps);
  return auth.ok ? auth.principal : null;
}

/** GET /api/projects */
export async function handleCustomerProjects(request: Request, deps: CustomerEditorDeps): Promise<Response> {
  const principal = await principalOf(request, deps);
  if (!principal) return customerUnauthenticatedResponse();
  return Response.json({ projects: await listCustomerProjects(deps.store, principal) }, { status: 200, headers: NO_STORE });
}

/** GET /api/projects/:projectId/editor */
export async function handleCustomerEditorState(request: Request, deps: CustomerEditorDeps, projectId: string): Promise<Response> {
  const principal = await principalOf(request, deps);
  if (!principal) return customerUnauthenticatedResponse();
  const load = await loadCustomerEditorState(deps.store, principal, projectId);
  if (!load.ok) return customerProjectDenialResponse();
  return Response.json(load.state, { status: 200, headers: NO_STORE });
}

/**
 * GET /api/projects/:projectId/preview/:draftId/[...route]?channel=…
 *
 * One page of the exact current draft's exact snapshot, as an isolated
 * editor-selection document. A draft id that is not the project's current draft
 * is not found: this route never previews history with current bytes.
 */
export async function handleCustomerEditorPreview(
  request: Request,
  deps: CustomerEditorDeps,
  params: { readonly projectId: string; readonly draftId: string; readonly route: readonly string[] },
): Promise<Response> {
  const principal = await principalOf(request, deps);
  if (!principal) return customerUnauthenticatedResponse();
  const load = await loadCustomerEditorState(deps.store, principal, params.projectId);
  if (!load.ok) return customerProjectDenialResponse();
  const authority = load.authority;
  if (!authority || authority.draft._id !== params.draftId) return customerEditorErrorResponse('not_found', 404);

  const channel = new URL(request.url).searchParams.get('channel') ?? '';
  if (!PREVIEW_CHANNEL.test(channel)) return customerEditorErrorResponse('preview_unavailable', 400);

  let documentPath: string | null;
  try {
    documentPath = await resolveSiteExportRequest(authority.snapshot, params.route);
  } catch {
    return customerEditorErrorResponse('not_found', 404);
  }
  if (!documentPath || !documentPath.endsWith('.html')) return customerEditorErrorResponse('not_found', 404);

  const blobs = new BlobStore(deps.store);
  try {
    const preview = await renderEditorPreviewDocument({
      documentPath,
      channel,
      files: { read: (path) => readSiteExportFile(blobs, authority.snapshot, path) },
    });
    return new Response(preview.html, {
      status: 200,
      headers: {
        ...NO_STORE,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': preview.contentSecurityPolicy,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'x-frame-options': 'SAMEORIGIN',
      },
    });
  } catch (error) {
    if (error instanceof EditorPreviewTooLarge) return customerEditorErrorResponse('preview_too_large', 413);
    return customerEditorErrorResponse('preview_unavailable', 503);
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return undefined;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_EDIT_REQUEST_BYTES) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_EDIT_REQUEST_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * POST /api/projects/:projectId/edits
 *
 * principal → same-origin → edit authorisation → exact current draft and model
 * → request concurrency → durable submission. 202 with the intent, promptly.
 */
export async function handleCustomerEditSubmit(request: Request, deps: CustomerEditorDeps, projectId: string): Promise<Response> {
  const principal = await principalOf(request, deps);
  if (!principal) return customerUnauthenticatedResponse();
  if (!isSameOriginCustomerMutation(request, deps.config)) return customerEditorErrorResponse('forbidden', 403);

  const authorization = await authorizeCustomerProjectEdit(deps.store, principal, projectId);
  if (!authorization.allowed) {
    // A member who may see this project learns only that they may not change it; anyone else learns nothing.
    return authorization.denial === 'insufficient_role' ? customerEditorErrorResponse('forbidden', 403) : customerProjectDenialResponse();
  }

  const load = await loadCustomerEditorState(deps.store, principal, projectId);
  if (!load.ok) return customerProjectDenialResponse();
  if (!load.authority) return customerEditorErrorResponse('edit_unavailable', 409);

  const body = CustomerEditRequest.safeParse(await readBoundedJson(request));
  if (!body.success) return customerEditorErrorResponse('invalid_edit', 400);

  const submitted = await submitCustomerSemanticEdit({
    store: deps.store,
    workspacesRoot: deps.workspacesRoot,
    validationWorkspacesRoot: deps.validationWorkspacesRoot,
    principal,
    authority: load.authority,
    request: body.data,
  });
  if (!submitted.ok) return customerEditorErrorResponse(submitted.error, submitted.error === 'invalid_edit' ? 400 : 409);
  return Response.json(submitted.accepted, { status: 202, headers: NO_STORE });
}

/** GET /api/projects/:projectId/edits/:intentId */
export async function handleCustomerEditStatus(request: Request, deps: CustomerEditorDeps, params: { readonly projectId: string; readonly intentId: string }): Promise<Response> {
  const principal = await principalOf(request, deps);
  if (!principal) return customerUnauthenticatedResponse();
  const authorization = await authorizeCustomerProjectView(deps.store, principal, params.projectId);
  if (!authorization.allowed) return customerProjectDenialResponse();
  const status = await readCustomerEditStatus(deps.store, params.projectId, params.intentId);
  if (!status) return customerEditorErrorResponse('not_found', 404);
  return Response.json(status, { status: 200, headers: NO_STORE });
}
