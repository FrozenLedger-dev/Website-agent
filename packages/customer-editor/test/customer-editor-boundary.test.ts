/**
 * The customer editor's authority, structurally.
 *
 * Customer routes authenticate customers only and authorise every project from
 * persisted tenancy; the one editor-state loader reads exact canonical draft
 * authority and never "latest"; the preview reads the exact snapshot and never a
 * file; the frame cannot run generated code with customer-origin authority;
 * selection is semantic markers only; edits are the existing semantic patch
 * contract submitted durably — never executed, resumed or released by a request.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDIT_STATUS_POLL_MS } from '../src/messages.js';
import { editorPreviewContentSecurityPolicy } from '../src/preview/transport.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = async (path: string) => strip(await readFile(join(REPO, path), 'utf8'));
const raw = async (path: string) => readFile(join(REPO, path), 'utf8');

async function filesUnder(dir: string, pattern = /\.(ts|tsx)$/): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', '.next', 'test'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path, pattern)));
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}
function body(code: string, start: string, end = '\n}\n'): string {
  const from = code.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = code.indexOf(end, from + start.length);
  expect(to, `missing end of ${start}`).toBeGreaterThan(from);
  return code.slice(from, to);
}

const EDITOR_SRC = 'packages/customer-editor/src';
const APP = 'apps/customer';
const EDITOR_UI = 'apps/customer/app/projects/[projectId]/editor/editor.tsx';

const serverSide = async () => [
  ...(await filesUnder(EDITOR_SRC)).filter((f) => !f.endsWith('/client.ts')),
  ...(await filesUnder(`${APP}/app/api`)),
  ...(await filesUnder(`${APP}/lib`)),
  `${APP}/app/projects/page.tsx`,
  `${APP}/app/projects/[projectId]/editor/page.tsx`,
];
const allCustomerCode = async () => [...(await filesUnder(EDITOR_SRC)), ...(await filesUnder(`${APP}/app`)), ...(await filesUnder(`${APP}/lib`))];

describe('customer identity and project authority', () => {
  it('editor routes call only the editor handlers through customer deps — no operator authority, no Authorization header', async () => {
    for (const file of await filesUnder(`${APP}/app/api/projects`)) {
      const code = await src(file);
      const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.every((i) => i === '@statxai/customer-editor' || /\/lib\/deps$/.test(i!)), file).toBe(true);
      expect(code, file).toMatch(/handleCustomer(Projects|ProjectCreate|CreateAccounts|EditorState|EditorPreview|EditSubmit|EditStatus|GenerationStatus)\(request, deps/);
    }
    for (const file of await allCustomerCode()) {
      const code = await src(file);
      expect(code, file).not.toMatch(/console\/lib\/auth|requireConsoleOperator|authenticateConsoleOperator|CONSOLE_OPERATOR/);
      expect(code, file).not.toMatch(/headers\.get\('authorization'\)/i);
    }
  });

  it('every project handler authenticates the customer session, then authorises the exact project from persisted tenancy', async () => {
    const http = await src(`${EDITOR_SRC}/http.ts`);
    expect(body(http, 'async function principalOf(')).toMatch(/requireCustomerPrincipal\(request, deps\)/);
    for (const name of ['handleCustomerProjects', 'handleCustomerEditorState', 'handleCustomerEditorPreview', 'handleCustomerEditSubmit', 'handleCustomerEditStatus']) {
      const handler = body(http, `export async function ${name}(`);
      expect(handler.indexOf('await principalOf(request, deps)'), name).toBeGreaterThan(-1);
      expect(handler.indexOf('customerUnauthenticatedResponse()'), name).toBeGreaterThan(handler.indexOf('await principalOf(request, deps)'));
    }
    expect(body(http, 'export async function handleCustomerEditorState(')).toMatch(/loadCustomerEditorState\(deps\.store, principal, projectId\)[\s\S]*if \(!load\.ok\) return customerProjectDenialResponse\(\)/);
    expect(body(http, 'export async function handleCustomerEditorPreview(')).toMatch(/loadCustomerEditorState\(deps\.store, principal, params\.projectId\)[\s\S]*authority\.draft\._id !== params\.draftId/);
    expect(body(http, 'export async function handleCustomerEditStatus(')).toMatch(/authorizeCustomerProjectView\(deps\.store, principal, params\.projectId\)[\s\S]*readCustomerEditStatus\(deps\.store, params\.projectId, params\.intentId\)/);
    const loader = body(await src(`${EDITOR_SRC}/editor-state.ts`), 'export async function loadCustomerEditorState(');
    expect(loader.indexOf('authorizeCustomerProjectView(store, principal, projectId)')).toBeGreaterThan(-1);
    expect(loader.indexOf('authorizeCustomerProjectView(')).toBeLessThan(loader.indexOf('resolveAuthority('));
    const list = body(await src(`${EDITOR_SRC}/projects.ts`), 'export async function listCustomerProjects(');
    expect(list).toMatch(/customerMemberships\.find\(\{ customerUserId: user\._id, status: 'active' \}\)/);
    expect(list).toMatch(/projectAccountBindings[\s\S]*\.find\(\{ accountId: \{ \$in: accounts\.map\(\(a\) => a\._id\) \} \}\)/);
    expect(list).toMatch(/authorizeCustomerProjectView\(store, principal, binding\._id\)[\s\S]*if \(!authorization\.allowed\) continue/);
    expect(list).not.toMatch(/store\.projects\.find\(/);
  });

  it('pages resolve the customer only through the same session boundary', async () => {
    expect(await src(`${APP}/lib/session.ts`)).toMatch(/requireCustomerPrincipal\(request, deps\)/);
    for (const page of [`${APP}/app/projects/page.tsx`, `${APP}/app/projects/[projectId]/editor/page.tsx`]) {
      expect(await src(page), page).toMatch(/currentCustomerPrincipal\(deps\)[\s\S]*if \(!principal\) redirect\(loginPathFor/);
    }
    expect(await src(`${APP}/app/projects/[projectId]/editor/page.tsx`)).toMatch(/loadCustomerEditorState\(deps\.store, principal, projectId\)[\s\S]*if \(!load\.ok\) notFound\(\)/);
  });
});

describe('exact draft, model and snapshot — never latest', () => {
  it('the one loader proves canonical draft authority and reads only the exact refs it names', async () => {
    const state = await src(`${EDITOR_SRC}/editor-state.ts`);
    const resolve = body(state, 'async function resolveAuthority(');
    expect(resolve).toMatch(/resolveCanonicalDraftAuthority\(store, projectId\)/);
    expect(resolve).toMatch(/frontendBackendBuildBindings\.findOne\(\{ _id: draft\.canonicalBindingId, projectId \}\)/);
    expect(resolve).toMatch(/build\.jobSpec\.inputs\[FRONTEND_BACKEND_INPUT\.editableSiteModel\]/);
    expect(resolve).toMatch(/resolveEditableSiteModel\(registry, projectId, modelRef\)/);
    expect(resolve).toMatch(/const snapshotRef = draft\.siteExportSnapshot;/);
    expect(resolve).toMatch(/readSiteExportSnapshot\(registry, projectId, snapshotRef\)/);
    expect(resolve).toMatch(/authority\.buildBindingId !== draft\.canonicalBindingId/);
    expect(resolve).toMatch(/!sameExactRef\(snapshot\.subject\.editableSiteModel, modelRef\)/);
    expect(state.match(/export async function loadCustomerEditorState\(/g)).toHaveLength(1);
    for (const file of await serverSide()) {
      const code = await src(file);
      expect(code, file).not.toMatch(/artifacts\.find|registry\.get\(|registry\.list|lineageSeq|latest|loadCurrentCanonicalDraft|canonicalDrafts\.find\(\{ projectId \}\)/i);
    }
  });

  it('there is one editor-state authority: routes and pages call the loader, nothing else resolves a draft', async () => {
    for (const file of await serverSide()) {
      if (file.endsWith('editor-state.ts') || file.endsWith('projects.ts')) continue;
      expect(await src(file), file).not.toMatch(/resolveCanonicalDraftAuthority|resolveEditableSiteModel|readSiteExportSnapshot\(/);
    }
  });
});

describe('the preview transport', () => {
  it('reads bytes only through the exact snapshot manifest and blob store — never a file, the workspace or app/out', async () => {
    const http = body(await src(`${EDITOR_SRC}/http.ts`), 'export async function handleCustomerEditorPreview(');
    expect(http).toMatch(/resolveSiteExportRequest\(authority\.snapshot, params\.route\)/);
    expect(http).toMatch(/read: \(path\) => readSiteExportFile\(blobs, authority\.snapshot, path\)/);
    expect(http).not.toMatch(/workspacesRoot|ProjectWorkspace|app\/out|readFile/);
    for (const file of [`${EDITOR_SRC}/http.ts`, `${EDITOR_SRC}/preview/transport.ts`, `${EDITOR_SRC}/preview/bridge.ts`, `${EDITOR_SRC}/editor-state.ts`]) {
      const code = await src(file);
      expect(code, file).not.toMatch(/from 'node:fs|from 'fs'|readFileSync|createReadStream|app\/out|'out'|ProjectWorkspace/);
    }
  });

  it('parses HTML and CSS with real parsers, removes every generated script and handler, and injects one nonce-bearing bridge', async () => {
    const transport = await src(`${EDITOR_SRC}/preview/transport.ts`);
    expect(transport).toMatch(/from 'parse5'/);
    expect(transport).toMatch(/from 'postcss'/);
    expect(transport).toMatch(/from 'postcss-value-parser'/);
    expect(transport).toMatch(/const REMOVED_ELEMENTS = new Set\(\['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'portal', 'template'/);
    expect(transport).toMatch(/const REMOVED_ATTRIBUTE = \/\^\(on\.\*\|formaction\|action\|target\|/);
    expect(transport.match(/createElement\('script'/g)).toHaveLength(1);
    expect(transport).toMatch(/createElement\('script', \[\{ name: 'nonce', value: nonce \}\], editorBridgeSource\(input\.channel\)\)/);
    expect(transport).not.toMatch(/\.replace\(\/<script|innerHTML/);
    const csp = editorPreviewContentSecurityPolicy('N');
    expect(csp.split('; ')).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'nonce-N'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", 'sandbox allow-scripts']));
    expect(csp).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-top-navigation|allow-modals|allow-downloads|unsafe-eval|https?:|'self'(?!; sandbox)/);
  });

  it('the editor frames it sandboxed with scripts only — nowhere in customer code is same-origin granted', async () => {
    const ui = await raw(EDITOR_UI);
    expect(ui.match(/<iframe/g)).toHaveLength(1);
    expect(ui).toMatch(/sandbox="allow-scripts"\n/);
    expect(ui).toMatch(/referrerPolicy="no-referrer"/);
    for (const file of await allCustomerCode()) expect(await raw(file), file).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-top-navigation|srcDoc|srcdoc=/);
  });
});

describe('selection is semantic identity only', () => {
  it('the bridge reports data-statx markers — never position, text or a selector — and messages are accepted only from the frame window on its channel', async () => {
    const bridge = await src(`${EDITOR_SRC}/preview/bridge.ts`);
    expect(bridge).toMatch(/markers: SITE_MODEL_MARKERS/);
    expect(bridge).not.toMatch(/nth-child|nth-of-type|textContent|innerText|innerHTML|childNodes|children\[|indexOf\(|getBoundingClientRect|fetch\(|XMLHttpRequest|WebSocket|document\.cookie|localStorage/);
    const ui = await src(EDITOR_UI);
    expect(ui).toMatch(/if \(!frame\.current \|\| event\.source !== frame\.current\.contentWindow\) return;\n\s*const message = parsePreviewMessage\(event\.data, channel\);/);
    expect(ui).toMatch(/selectFromMarkers\(draft\.model, route, message\.markers\)/);
    expect(ui).not.toMatch(/event\.origin/);
    const view = await src(`${EDITOR_SRC}/model-view.ts`);
    expect(body(view, 'export function resolveSelection(')).toMatch(/ID_SCHEMA\[target\.kind\]\.safeParse\(target\.id\)\.success/);
    expect(await src(`${EDITOR_SRC}/messages.ts`)).toMatch(/const Marker = z\.string\(\)\.regex\(\/\^\(pg\|sec\|blk\|fld\|ast\)_\[a-f0-9\]\{16\}\$\/\)/);
  });
});

describe('edits are the existing semantic patch, submitted durably', () => {
  it('every browser control builds a SemanticPatch through the contract; the UI names no operation of its own', async () => {
    const patches = await src(`${EDITOR_SRC}/patches.ts`);
    expect(body(patches, 'function patch(')).toMatch(/SemanticPatch\.safeParse\(/);
    for (const name of ['setFieldValuePatch', 'setVisibilityPatch', 'setSectionLayoutPatch', 'moveSectionPatch', 'addBlockPatch', 'removeBlockPatch']) {
      expect(body(patches, `export function ${name}(`), name).toMatch(/return patch\(baseModel, \{ op: '/);
    }
    expect(patches).not.toMatch(/set_design_token|set_asset/);
    // The browser mints no identity: no builder carries or constructs a semantic ID.
    expect(patches).not.toMatch(/\b(pg|sec|blk|fld|ast)_[a-f0-9]{16}\b|`(pg|sec|blk|fld|ast)_\$\{/);
    expect(body(patches, 'export function addBlockPatch(')).not.toMatch(/blockId|fieldId/);
    const ui = await src(EDITOR_UI);
    expect(ui).not.toMatch(/\bop: '/);
    expect(ui).toMatch(/body: JSON\.stringify\(\{ expectedDraftId: draft\.draft\.draftId, baseModel: draft\.draft\.editableSiteModel, patch \}\)/);
  });

  it('the submission route submits only: no apply, resume, worker, lifecycle, promotion, release or background execution on the server', async () => {
    const edits = await src(`${EDITOR_SRC}/edits.ts`);
    expect(edits.match(/submitSemanticEdit\(/g)).toHaveLength(1);
    const submit = body(await src(`${EDITOR_SRC}/http.ts`), 'export async function handleCustomerEditSubmit(');
    const order = ['await principalOf(request, deps)', 'isSameOriginCustomerMutation(request, deps.config)', 'authorizeCustomerProjectEdit(deps.store, principal, projectId)', 'loadCustomerEditorState(deps.store, principal, projectId)', 'CustomerEditRequest.safeParse(', 'submitCustomerSemanticEdit({'];
    const positions = order.map((needle) => submit.indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(submit).toMatch(/status: 202/);
    // Exact concurrency against the loaded authority, before submission — and submission names only server-resolved authority.
    const submitEdit = body(edits, 'export async function submitCustomerSemanticEdit(');
    expect(submitEdit).toMatch(/if \(request\.expectedDraftId !== authority\.draft\._id \|\| !sameExactRef\(request\.baseModel, authority\.modelRef\)\) return \{ ok: false, error: 'stale_revision' \};/);
    expect(submitEdit).toMatch(/expectedDraftId: authority\.draft\._id,\n\s*expectedCanonicalBindingId: authority\.canonicalBindingId,\n\s*baseEditableSiteModel: authority\.modelRef,/);
    expect(submitEdit.indexOf("error: 'stale_revision'")).toBeLessThan(submitEdit.indexOf('submitSemanticEdit({'));
    for (const file of await serverSide()) {
      const code = await src(file);
      expect(code, file).not.toMatch(/applySemanticEdit|resumeSemanticEdit|continueSemanticEdit|SemanticEditWorker|claimSemanticEditExecution|createFrontendBackendLifecycleCoordinator|editSiteSemantically|evaluateSite|concludeCanonicalDraft/);
      expect(code, file).not.toMatch(/setTimeout|setImmediate|queueMicrotask|new Promise\(|void (submit|resume|apply)/);
      expect(code, file).not.toMatch(/promoteAccepted|finalizeBindingPromoted|publishRelease|seekRelease|recommendApproval|deploySite|releasePublications|release-publication|phases\/(publish|release)/);
    }
  });

  it('the customer app never starts the worker and imports no release or provider authority', async () => {
    for (const file of await allCustomerCode()) {
      const code = await src(file);
      expect(code, file).not.toMatch(/SemanticEditWorker|worker:semantic-edit|semantic-edit-worker/);
      expect(code, file).not.toMatch(/@statxai\/agents|@vercel\/sdk|release\.js|publish/);
    }
    const pkg = JSON.parse(await raw(`${APP}/package.json`)) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@statxai/contracts', '@statxai/customer-auth', '@statxai/customer-editor', '@statxai/state', 'next', 'react', 'react-dom']);
  });

  it('the status a browser sees is exactly the five customer-safe fields', async () => {
    expect(body(await src(`${EDITOR_SRC}/editor-state.ts`), 'export function customerEditStatusView(')).toMatch(
      /return \{ intentId: status\.intentId, state: status\.state, failure: status\.failure, baseDraftId: status\.sourceDraftId, resultDraftId: status\.resultDraftId \};/,
    );
  });
});

describe('the editor UI', () => {
  it('polls a running edit at a bounded interval, stops at a terminal state or unmount, and takes authority from a fresh editor state', async () => {
    expect(EDIT_STATUS_POLL_MS).toBeGreaterThanOrEqual(1_000);
    expect(EDIT_STATUS_POLL_MS).toBeLessThanOrEqual(3_000);
    const ui = await src(EDITOR_UI);
    const poll = body(ui, '  useEffect(() => {\n    if (!edit || isTerminalEditState(edit.state)) return;', '  }, [edit, projectId, refreshState]);');
    expect(poll).toMatch(/setTimeout\(async \(\) => \{/);
    expect(poll).toMatch(/\}, EDIT_STATUS_POLL_MS\);/);
    expect(poll).toMatch(/cancelled = true;\n\s*clearTimeout\(timer\);/);
    expect(poll).toMatch(/if \(status\.state === 'completed'\) \{[\s\S]*await refreshState\(\{ resultDraftId: status\.resultDraftId \}\)/);
    expect(poll).not.toMatch(/setInterval|setState\(|model/);
    expect(ui).not.toMatch(/setInterval|while \(true\)/);
    // Only the refreshed server state replaces the draft the editor shows.
    expect(ui.match(/setState\(/g)).toHaveLength(1);
    expect(body(ui, '  const refreshState = useCallback(', '    [projectId, route],')).toMatch(/fetch\(`\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/editor`[\s\S]*setState\(next\)/);
  });

  it('offers no publish, approval, chat, prompt, source or CSS editing', async () => {
    for (const file of await filesUnder(`${APP}/app`)) {
      const code = (await raw(file)).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code, file).not.toMatch(/publish|approve|approval|chat|prompt|contentEditable|monaco|codemirror|<textarea[^>]*css|design token|className=\{`?\$\{/i);
    }
    const labels = await src(`${EDITOR_SRC}/messages.ts`);
    expect(labels).not.toMatch(/approved|ready to publish|live/i);
  });

  it('the browser half imports nothing server-side', async () => {
    const browserFiles = [`${EDITOR_SRC}/client.ts`, `${EDITOR_SRC}/dto.ts`, `${EDITOR_SRC}/messages.ts`, `${EDITOR_SRC}/model-view.ts`, `${EDITOR_SRC}/patches.ts`, EDITOR_UI];
    for (const file of browserFiles) {
      const code = await src(file);
      for (const m of code.matchAll(/^import (type )?[^;]*from '([^']+)';/gm)) {
        const [, typeOnly, specifier] = m;
        if (typeOnly) continue;
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^(\.\/[a-z-]+\.js|zod\/v4|@statxai\/contracts\/editable-site-model|@statxai\/customer-editor\/client|react|next\/link)$/);
      }
    }
  });
});
