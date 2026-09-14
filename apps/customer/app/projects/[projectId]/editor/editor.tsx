'use client';

/**
 * The customer draft editor.
 *
 * The browser holds only what the user is doing — the selected semantic ID, the
 * previewed route, form values, the draft and exact model it is editing, and the
 * edit it submitted. Every authority comes from the server: which draft is
 * current, which model and snapshot it has, whether this customer may edit, and
 * where an edit stands. Nothing here decides that an edit succeeded or that a
 * model is canonical; after an edit completes, the editor reloads its whole state.
 *
 * The preview is a sandboxed frame without same-origin, serving an isolated,
 * scriptless view of the draft's exact snapshot with one trusted selection
 * bridge. A message is trusted only from exactly that frame's window, on its own
 * random channel, and the IDs it carries select only what the exact model has on
 * the previewed page.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SUPPORTED_BLOCKS, type BlockKind, type SiteField } from '@statxai/contracts/editable-site-model';
import {
  ADDABLE_BLOCK_KINDS,
  EDIT_FAILURE_LABEL,
  EDIT_STATE_LABEL,
  EDIT_STATUS_POLL_MS,
  EditorPatchInvalid,
  PREVIEW_MESSAGE_TYPE,
  SECTION_LAYOUTS,
  addBlockPatch,
  isTerminalEditState,
  isValidFieldValue,
  moveSectionPatch,
  parsePreviewMessage,
  removeBlockPatch,
  resolveSelection,
  selectFromMarkers,
  setFieldValuePatch,
  setSectionLayoutPatch,
  setVisibilityPatch,
  type CustomerEditAccepted,
  type CustomerEditStatusView,
  type CustomerEditorState,
  type EditorBlockView,
  type EditorPageView,
  type EditorSectionView,
  type ExactModelRef,
  type ResolvedSelection,
  type SelectionTarget,
} from '@statxai/customer-editor/client';

type DraftState = Extract<CustomerEditorState, { kind: 'draft' }>;
type Notice = { readonly tone: 'info' | 'success' | 'error'; readonly text: string } | null;

const VIEWPORTS = { desktop: '100%', tablet: '820px', mobile: '390px' } as const;
type Viewport = keyof typeof VIEWPORTS;

const EDITABILITY_LABEL: Record<DraftState['draft']['editability'], string> = {
  ready_to_edit: 'Ready to edit',
  edit_in_progress: 'Edit in progress',
  edit_failed: 'Edit could not be completed',
  busy: 'Not editable right now',
};

const ERROR_TEXT: Record<string, string> = {
  invalid_edit: 'That change is not valid.',
  stale_revision: 'This draft changed since you opened it. The current draft has been loaded.',
  edit_in_progress: 'An edit is already in progress for this draft.',
  edit_unavailable: 'Edits are not available for this draft right now.',
  forbidden: 'You do not have permission to edit this project.',
};

const newChannel = () => `ch_${crypto.randomUUID().replace(/-/g, '')}`;
/** The exact model the server said this draft carries; the server proves it again on submission. */
const exactModelRef = (state: DraftState): ExactModelRef => state.draft.editableSiteModel as ExactModelRef;

function isDraftState(value: unknown): value is CustomerEditorState {
  const v = value as CustomerEditorState | null;
  return !!v && (v.kind === 'unavailable' || (v.kind === 'draft' && typeof v.draft?.draftId === 'string' && Array.isArray(v.model?.pages) && Array.isArray(v.preview?.routes)));
}

export function Editor({ initialState }: { readonly initialState: DraftState }) {
  const [state, setState] = useState<CustomerEditorState>(initialState);
  const [route, setRoute] = useState('/');
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [channel, setChannel] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionTarget | null>(null);
  const [edit, setEdit] = useState<CustomerEditStatusView | null>(initialState.edit);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  const draft = state.kind === 'draft' ? state : null;
  const projectId = state.project.projectId;
  const page = draft?.model.pages.find((p) => p.route === route) ?? null;
  const resolved: ResolvedSelection | null = draft && selection ? resolveSelection(draft.model, route, selection) : null;
  const canSubmit = !!draft && draft.permissions.canSubmit && !busy && !(edit && !isTerminalEditState(edit.state)) && draft.draft.editability === 'ready_to_edit';

  // One fresh channel per exact draft and route: a frame of another draft or page can never be heard.
  useEffect(() => {
    setChannel(newChannel());
  }, [draft?.draft.draftId, route]);

  const refreshState = useCallback(
    async (expectation: { readonly resultDraftId?: string | null } = {}): Promise<CustomerEditorState | null> => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/editor`, { cache: 'no-store', credentials: 'same-origin' });
      if (response.status === 401) {
        window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
        return null;
      }
      if (!response.ok) {
        setNotice({ tone: 'error', text: 'The editor could not refresh right now.' });
        return null;
      }
      const next: unknown = await response.json();
      if (!isDraftState(next)) {
        setNotice({ tone: 'error', text: 'The editor could not refresh right now.' });
        return null;
      }
      setState(next);
      if (next.kind === 'draft') {
        setEdit(next.edit);
        // Keep the route and selection only while the new exact model still has them.
        const nextRoute = next.model.pages.some((p) => p.route === route) ? route : '/';
        setRoute(nextRoute);
        setSelection((current) => (current && resolveSelection(next.model, nextRoute, current) ? current : null));
        if (expectation.resultDraftId !== undefined && expectation.resultDraftId !== null) {
          setNotice(
            next.draft.draftId === expectation.resultDraftId
              ? { tone: 'success', text: 'Changes applied' }
              : { tone: 'success', text: 'Changes applied. A newer revision of this site is now current.' },
          );
        }
      } else {
        setEdit(null);
        setSelection(null);
      }
      setChannel(newChannel());
      return next;
    },
    [projectId, route],
  );

  // Poll a running edit at a bounded interval; stop when it is terminal or the editor unmounts.
  useEffect(() => {
    if (!edit || isTerminalEditState(edit.state)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/edits/${encodeURIComponent(edit.intentId)}`, { cache: 'no-store', credentials: 'same-origin' });
        if (cancelled) return;
        if (!response.ok) {
          setEdit({ ...edit });
          return;
        }
        const status = (await response.json()) as CustomerEditStatusView;
        if (cancelled || status.intentId !== edit.intentId) return;
        if (status.state === 'completed') {
          // Authority comes from a fresh editor state, never from the status alone.
          const next = await refreshState({ resultDraftId: status.resultDraftId });
          if (!cancelled && next?.kind === 'draft' && next.draft.draftId === edit.baseDraftId) setEdit({ ...status, state: 'finishing' });
          return;
        }
        if (status.state === 'failed') {
          setEdit(status);
          await refreshState();
          return;
        }
        setEdit(status);
      } catch {
        if (!cancelled) setEdit({ ...edit });
      }
    }, EDIT_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [edit, projectId, refreshState]);

  // Frame messages: exactly our frame's window, exactly our channel, strictly parsed, resolved against the exact model.
  useEffect(() => {
    if (!draft || !channel) return;
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = parsePreviewMessage(event.data, channel);
      if (!message) return;
      if (message.event === 'ready') return;
      const selected = selectFromMarkers(draft.model, route, message.markers);
      setSelection(selected ? { kind: selected.kind, id: selected.id } : null);
      setNotice(selected ? null : { tone: 'info', text: 'That part of the page cannot be edited here.' });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [draft, channel, route]);

  const highlight = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target || !channel) return;
    target.postMessage({ type: PREVIEW_MESSAGE_TYPE, version: 1, channel, event: 'highlight', kind: resolved?.kind ?? null, id: resolved?.id ?? null }, '*');
  }, [channel, resolved?.kind, resolved?.id]);
  useEffect(highlight, [highlight]);

  const submit = useCallback(
    async (build: (base: ExactModelRef) => unknown) => {
      if (!draft) return;
      let patch: unknown;
      try {
        patch = build(exactModelRef(draft));
      } catch (error) {
        setNotice({ tone: 'error', text: error instanceof EditorPatchInvalid ? error.message : 'That change is not valid.' });
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/edits`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedDraftId: draft.draft.draftId, baseModel: draft.draft.editableSiteModel, patch }),
        });
        if (response.status === 202) {
          const accepted = (await response.json()) as CustomerEditAccepted;
          setEdit({ intentId: accepted.intentId, state: accepted.state, failure: null, baseDraftId: accepted.baseDraftId, resultDraftId: null });
          await refreshState();
          return;
        }
        if (response.status === 401) {
          window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setNotice({ tone: 'error', text: ERROR_TEXT[body.error ?? ''] ?? 'Your change could not be saved right now.' });
        if (response.status === 409) await refreshState();
      } catch {
        setNotice({ tone: 'error', text: 'Your change could not be saved right now.' });
      } finally {
        setBusy(false);
      }
    },
    [draft, projectId, refreshState],
  );

  const previewSrc = useMemo(() => {
    if (!draft || !channel) return null;
    const path = route === '/' ? '' : route;
    return `/api/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(draft.draft.draftId)}${path}?channel=${channel}`;
  }, [draft, channel, route, projectId]);

  if (!draft) {
    return (
      <main className="page narrow">
        <h1>{projectId}</h1>
        <p role="status">This draft cannot be opened in the editor right now.</p>
        <Link href="/projects">Back to your projects</Link>
      </main>
    );
  }

  const editing = edit && !isTerminalEditState(edit.state);
  const readOnlyReason = !draft.permissions.canEdit
    ? 'You can view this draft. Your role does not allow editing.'
    : draft.draft.editability === 'edit_in_progress' || editing
      ? 'Editing is paused while your change is applied.'
      : draft.draft.editability === 'edit_failed'
        ? 'This draft cannot be edited until the failed edit has been looked at.'
        : draft.draft.editability === 'busy'
          ? 'This draft is not editable right now.'
          : null;
  const disabled = !canSubmit || readOnlyReason !== null;

  return (
    <div className="editor">
      <header className="editor-bar">
        <div className="editor-title">
          <Link href="/projects" className="muted">
            Projects
          </Link>
          <span aria-hidden="true">/</span>
          <strong>{projectId}</strong>
          <span className="muted">{draft.project.accountName}</span>
        </div>
        <p className={`badge badge-${draft.draft.editability}`}>Draft · {EDITABILITY_LABEL[draft.draft.editability]}</p>
        <div className="editor-status" role="status" aria-live="polite">
          {edit ? (
            <span className={edit.state === 'failed' ? 'status-error' : 'status-pending'}>
              {EDIT_STATE_LABEL[edit.state]}
              {edit.state === 'failed' && edit.failure ? ` — ${EDIT_FAILURE_LABEL[edit.failure]}` : null}
            </span>
          ) : null}
          {notice ? <span className={`status-${notice.tone}`}>{notice.text}</span> : null}
        </div>
      </header>

      {editing ? <div className="banner">Your change is being applied. You are still looking at the current draft until the new revision is ready.</div> : null}

      <div className="editor-body">
        <section className="canvas" aria-label="Preview">
          <div className="canvas-controls">
            <label>
              Page{' '}
              <select value={route} onChange={(e) => { setRoute(e.target.value); setSelection(null); }}>
                {draft.preview.routes.map((r) => (
                  <option key={r.route} value={r.route} disabled={!r.available}>
                    {r.title} ({r.route})
                  </option>
                ))}
              </select>
            </label>
            <div role="group" aria-label="Preview width" className="segmented">
              {(Object.keys(VIEWPORTS) as Viewport[]).map((v) => (
                <button key={v} type="button" aria-pressed={viewport === v} onClick={() => setViewport(v)}>
                  {v[0]!.toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="frame-wrap">
            {previewSrc ? (
              <iframe
                key={`${draft.draft.draftId}:${channel}`}
                ref={frame}
                title="Draft preview"
                src={previewSrc}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                onLoad={highlight}
                style={{ width: VIEWPORTS[viewport] }}
              />
            ) : null}
          </div>
        </section>

        <aside className="inspector" aria-label="Inspector">
          {readOnlyReason ? <p className="read-only">{readOnlyReason}</p> : null}
          {page ? <Outline page={page} selection={resolved} onSelect={(target) => setSelection(target)} /> : null}
          {resolved ? (
            <Inspector key={`${draft.draft.draftId}:${resolved.kind}:${resolved.id}`} selection={resolved} disabled={disabled} submit={submit} onSelect={setSelection} />
          ) : (
            <p className="muted">Click part of the page, or choose it in the outline, to edit it.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outline — keyboard-accessible selection of the previewed page's semantic objects
// ---------------------------------------------------------------------------

function Outline({ page, selection, onSelect }: { readonly page: EditorPageView; readonly selection: ResolvedSelection | null; readonly onSelect: (target: SelectionTarget) => void }) {
  const current = (kind: string, id: string) => selection?.kind === kind && selection.id === id;
  const heading = (section: EditorSectionView) => String(section.fields.find((f) => f.key === 'heading')?.value ?? 'Section');
  return (
    <nav className="outline" aria-label="Page outline">
      <button type="button" aria-current={current('page', page.pageId)} onClick={() => onSelect({ kind: 'page', id: page.pageId })}>
        Page settings
      </button>
      <ol>
        {page.sections.map((section) => (
          <li key={section.sectionId}>
            <button type="button" aria-current={current('section', section.sectionId)} onClick={() => onSelect({ kind: 'section', id: section.sectionId })}>
              {heading(section)}
              {section.visibility === 'hidden' ? ' (hidden)' : ''}
            </button>
            {section.blocks.length ? (
              <ol>
                {section.blocks.map((block) => (
                  <li key={block.blockId}>
                    <button type="button" aria-current={current('block', block.blockId)} onClick={() => onSelect({ kind: 'block', id: block.blockId })}>
                      {block.kind.replace('_', ' ')}
                      {block.visibility === 'hidden' ? ' (hidden)' : ''}
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

type Submit = (build: (base: ExactModelRef) => unknown) => Promise<void>;

function Inspector({ selection, disabled, submit, onSelect }: { readonly selection: ResolvedSelection; readonly disabled: boolean; readonly submit: Submit; readonly onSelect: (target: SelectionTarget) => void }) {
  switch (selection.kind) {
    case 'page':
      return (
        <div className="panel">
          <h2>Page {selection.page.route}</h2>
          {selection.page.fields.map((field) => (
            <FieldEditor key={field.fieldId} field={field} label={field.key === 'title' ? 'Page title' : 'Page description'} disabled={disabled} submit={submit} />
          ))}
        </div>
      );
    case 'section':
      return <SectionInspector page={selection.page} section={selection.section} index={selection.index} disabled={disabled} submit={submit} onSelect={onSelect} />;
    case 'block':
      return <BlockInspector section={selection.section} block={selection.block} disabled={disabled} submit={submit} />;
    case 'field':
      return (
        <div className="panel">
          <h2>{selection.owner.kind === 'page' ? 'Page' : selection.owner.kind === 'section' ? 'Section heading' : `${selection.owner.block.kind.replace('_', ' ')} block`}</h2>
          <FieldEditor field={selection.field} label={selection.field.key} disabled={disabled} submit={submit} />
        </div>
      );
    case 'asset':
      return (
        <div className="panel">
          <h2>Image slot</h2>
          <p>{selection.asset.filled ? 'This slot has an image.' : 'This slot has no image yet.'}</p>
          <p className="muted">Changing images is not available in the editor yet.</p>
        </div>
      );
  }
}

function SectionInspector({
  page,
  section,
  index,
  disabled,
  submit,
  onSelect,
}: {
  readonly page: EditorPageView;
  readonly section: EditorSectionView;
  readonly index: number;
  readonly disabled: boolean;
  readonly submit: Submit;
  readonly onSelect: (target: SelectionTarget) => void;
}) {
  const [layout, setLayout] = useState<string>(section.layout);
  const heading = section.fields[0];
  return (
    <div className="panel">
      <h2>Section</h2>
      {heading ? <FieldEditor field={heading} label="Heading" disabled={disabled} submit={submit} /> : null}
      <div className="control-row">
        <button type="button" className="button" disabled={disabled} onClick={() => submit((base) => setVisibilityPatch(base, section.sectionId, section.visibility === 'visible' ? 'hidden' : 'visible'))}>
          {section.visibility === 'visible' ? 'Hide section' : 'Show section'}
        </button>
      </div>
      <div className="control-row">
        <button type="button" className="button" disabled={disabled || index === 0} onClick={() => submit((base) => moveSectionPatch(base, page, section.sectionId, 'up'))}>
          Move up
        </button>
        <button type="button" className="button" disabled={disabled || index === page.sections.length - 1} onClick={() => submit((base) => moveSectionPatch(base, page, section.sectionId, 'down'))}>
          Move down
        </button>
      </div>
      <label className="field">
        Layout
        <select value={layout} disabled={disabled} onChange={(e) => setLayout(e.target.value)}>
          {SECTION_LAYOUTS.map((l) => (
            <option key={l} value={l}>
              {l.replace(/-/g, ' ')}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="button" disabled={disabled || layout === section.layout} onClick={() => submit((base) => setSectionLayoutPatch(base, section, layout))}>
        Apply layout
      </button>
      <AddBlock section={section} disabled={disabled} submit={submit} />
      {section.blocks.length ? (
        <ul className="plain">
          {section.blocks.map((block) => (
            <li key={block.blockId}>
              <button type="button" className="link" onClick={() => onSelect({ kind: 'block', id: block.blockId })}>
                Edit {block.kind.replace('_', ' ')} block
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function BlockInspector({ section, block, disabled, submit }: { readonly section: EditorSectionView; readonly block: EditorBlockView; readonly disabled: boolean; readonly submit: Submit }) {
  return (
    <div className="panel">
      <h2>{block.kind.replace('_', ' ')} block</h2>
      <p className="muted">In “{String(section.fields[0]?.value ?? 'section')}”</p>
      {block.fields.map((field) => (
        <FieldEditor key={field.fieldId} field={field} label={field.key} disabled={disabled} submit={submit} />
      ))}
      <div className="control-row">
        <button type="button" className="button" disabled={disabled} onClick={() => submit((base) => setVisibilityPatch(base, block.blockId, block.visibility === 'visible' ? 'hidden' : 'visible'))}>
          {block.visibility === 'visible' ? 'Hide block' : 'Show block'}
        </button>
        <button
          type="button"
          className="button danger"
          disabled={disabled}
          onClick={() => {
            if (window.confirm('Remove this block from the page?')) void submit((base) => removeBlockPatch(base, block.blockId));
          }}
        >
          Remove block
        </button>
      </div>
    </div>
  );
}

function AddBlock({ section, disabled, submit }: { readonly section: EditorSectionView; readonly disabled: boolean; readonly submit: Submit }) {
  const [kind, setKind] = useState<BlockKind | ''>('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const slots = kind ? SUPPORTED_BLOCKS[kind] : [];
  const setSlot = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }));
  return (
    <fieldset className="add-block" disabled={disabled}>
      <legend>Add a block</legend>
      <label className="field">
        Kind
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as BlockKind | '');
            setValues({});
          }}
        >
          <option value="">Choose…</option>
          {ADDABLE_BLOCK_KINDS.map((k) => (
            <option key={k} value={k}>
              {k.replace('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      {slots.map((slot) =>
        slot.type === 'cta' ? (
          <div key={slot.key}>
            <label className="field">
              {slot.key} label
              <input value={String((values[slot.key] as { label?: string } | undefined)?.label ?? '')} onChange={(e) => setSlot(slot.key, { ...(values[slot.key] as object), label: e.target.value })} />
            </label>
            <label className="field">
              {slot.key} link
              <input value={String((values[slot.key] as { href?: string } | undefined)?.href ?? '')} onChange={(e) => setSlot(slot.key, { ...(values[slot.key] as object), href: e.target.value })} />
            </label>
          </div>
        ) : (
          <label key={slot.key} className="field">
            {slot.key}
            <input type={slot.type === 'email' ? 'email' : slot.type === 'phone' ? 'tel' : 'text'} value={String(values[slot.key] ?? '')} onChange={(e) => setSlot(slot.key, e.target.value)} />
          </label>
        ),
      )}
      {kind ? (
        <button type="button" className="button" onClick={() => submit((base) => addBlockPatch(base, section, kind, values))}>
          Add block
        </button>
      ) : null}
    </fieldset>
  );
}

function FieldEditor({ field, label, disabled, submit }: { readonly field: SiteField; readonly label: string; readonly disabled: boolean; readonly submit: Submit }) {
  const [value, setValue] = useState<unknown>(field.value);
  useEffect(() => setValue(field.value), [field.fieldId, field.value]);
  const id = `field-${field.fieldId}`;

  if (field.type === 'asset') {
    return (
      <p className="field">
        <span>{label}</span>
        <span className="muted"> Image slot — changing images is not available yet.</span>
      </p>
    );
  }

  const changed = JSON.stringify(value) !== JSON.stringify(field.value);
  const valid = isValidFieldValue(field, value);
  const save = () => submit((base) => setFieldValuePatch(base, field, value));

  return (
    <div className="field">
      {field.type === 'cta' ? (
        <>
          <label htmlFor={`${id}-label`}>{label} label</label>
          <input id={`${id}-label`} disabled={disabled} value={(value as { label: string }).label} onChange={(e) => setValue({ ...(value as object), label: e.target.value })} />
          <label htmlFor={`${id}-href`}>{label} link</label>
          <input id={`${id}-href`} disabled={disabled} value={(value as { href: string }).href} onChange={(e) => setValue({ ...(value as object), href: e.target.value })} aria-describedby={`${id}-help`} />
          <span id={`${id}-help`} className="muted small">
            A page on your site (like /contact), a phone number (tel:), an email (mailto:) or an https:// link.
          </span>
        </>
      ) : (
        <>
          <label htmlFor={id}>{label}</label>
          {field.type === 'text' ? (
            <textarea id={id} disabled={disabled} rows={3} maxLength={600} value={String(value)} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input id={id} disabled={disabled} type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'} value={String(value)} onChange={(e) => setValue(e.target.value)} />
          )}
        </>
      )}
      {changed && !valid ? <span className="status-error small">Enter a valid {field.type === 'text' ? 'value' : field.type}.</span> : null}
      <button type="button" className="button" disabled={disabled || !changed || !valid} onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}
