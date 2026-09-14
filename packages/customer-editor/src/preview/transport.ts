/**
 * The editor-selection preview: a transport view of one exact page of one exact
 * immutable site-export snapshot — never a new artifact, never the mutable
 * export, never a file on disk.
 *
 * The generated site is untrusted browser content. A browser frame sandboxed
 * without same-origin cannot send the customer session on its subresource
 * requests, and must not be able to reach the network at all. So each preview is
 * one self-contained document:
 *
 * - parsed with a real HTML parser (parse5), never rewritten by pattern;
 * - every generated script, inline handler, `javascript:` or other navigation,
 *   meta refresh, base URL, frame, object, form action and preload removed;
 * - every stylesheet the page links, and every font or image its HTML or CSS
 *   references, read from the exact snapshot manifest and inlined — stylesheets
 *   as `<style>`, fonts and images as `data:` URIs — so root-relative URLs such
 *   as `/_next/static/...` resolve inside the snapshot and can never reach the
 *   customer app's own assets;
 * - anything that does not resolve to a snapshot file of an allowed type is
 *   dropped, and a document whose inlined bytes exceed a bound is refused, never
 *   truncated;
 * - exactly one trusted script, the selection bridge, carrying a per-response
 *   nonce, is injected.
 *
 * The response carries a CSP that admits that nonce and no network, and itself
 * sandboxes the document, so even a direct top-level visit runs without the
 * customer origin's authority.
 */
import { randomBytes } from 'node:crypto';
import { defaultTreeAdapter as tree, html as parse5Html, parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import postcss, { type ChildNode as CssChildNode, type Root as CssRoot } from 'postcss';
import valueParser from 'postcss-value-parser';
import { normalizeSiteExportRequest } from '@statxai/workspace';
import { EDITOR_PREVIEW_STYLE, editorBridgeSource } from './bridge.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

/** Decoded bytes one preview document may inline, together with its own HTML. */
export const MAX_PREVIEW_DOCUMENT_BYTES = 24 * 1024 * 1024;
/** How deep `@import` is followed. */
const MAX_IMPORT_DEPTH = 4;

export class EditorPreviewTooLarge extends Error {
  constructor() {
    super('the preview document exceeds its inlining bound');
    this.name = 'EditorPreviewTooLarge';
  }
}

/** Exact snapshot files by exact manifest path — the only source of preview bytes. */
export interface EditorPreviewFiles {
  read(path: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon']);
const FONT_TYPES = new Set(['font/woff', 'font/woff2', 'font/ttf', 'font/otf']);
const DATA_URI = /^data:(image\/(png|jpeg|gif|webp|avif|svg\+xml)|font\/(woff2?|ttf|otf))[;,]/i;
const SNAPSHOT_BASE = 'https://snapshot.statx.invalid/';

const baseType = (contentType: string) => contentType.split(';')[0]!.trim().toLowerCase();

class Inliner {
  private spent: number;
  private readonly cache = new Map<string, string | null>();

  constructor(
    private readonly files: EditorPreviewFiles,
    htmlBytes: number,
  ) {
    this.spent = htmlBytes;
  }

  private charge(bytes: number): void {
    this.spent += bytes;
    if (this.spent > MAX_PREVIEW_DOCUMENT_BYTES) throw new EditorPreviewTooLarge();
  }

  /**
   * The exact snapshot path a URL written in `fromPath` names, or `null`. Only
   * relative and root-relative references resolve; any scheme, a network path, a
   * path that normalises to nothing or fails the snapshot path rules resolves to
   * nothing. Resolution never leaves the snapshot: it is a manifest lookup.
   */
  static localPath(raw: string, fromPath: string): string | null {
    const value = raw.trim();
    if (value === '' || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes('\\')) return null;
    let url: URL;
    try {
      url = new URL(value, SNAPSHOT_BASE + fromPath);
    } catch {
      return null;
    }
    if (url.origin !== new URL(SNAPSHOT_BASE).origin) return null;
    try {
      const path = normalizeSiteExportRequest(url.pathname);
      return path === '' ? null : path;
    } catch {
      return null;
    }
  }

  /** A `data:` URI for a snapshot font or image a URL names, or `null` when it names none. */
  async media(raw: string, fromPath: string, allow: 'image' | 'image_or_font'): Promise<string | null> {
    const value = raw.trim();
    if (/^data:/i.test(value)) {
      if (!DATA_URI.test(value)) return null;
      if (allow === 'image' && !/^data:image\//i.test(value)) return null;
      this.charge(value.length);
      return value;
    }
    const path = Inliner.localPath(value, fromPath);
    if (!path) return null;
    const key = `${allow}:${path}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const file = await this.files.read(path);
    const type = file ? baseType(file.contentType) : '';
    let uri: string | null = null;
    if (file && (IMAGE_TYPES.has(type) || (allow === 'image_or_font' && FONT_TYPES.has(type)))) {
      this.charge(file.bytes.length);
      uri = `data:${type};base64,${Buffer.from(file.bytes).toString('base64')}`;
    }
    this.cache.set(key, uri);
    return uri;
  }

  /** A snapshot stylesheet's text, by the URL naming it, or `null`. */
  async stylesheet(raw: string, fromPath: string): Promise<{ path: string; css: string } | null> {
    const path = Inliner.localPath(raw, fromPath);
    if (!path) return null;
    const file = await this.files.read(path);
    if (!file || baseType(file.contentType) !== 'text/css') return null;
    this.charge(file.bytes.length);
    return { path, css: Buffer.from(file.bytes).toString('utf8') };
  }
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

async function rewriteValue(value: string, fromPath: string, inliner: Inliner): Promise<string> {
  if (!/url\(|image-set\(/i.test(value)) return value;
  const parsed = valueParser(value);
  const pending: Promise<void>[] = [];
  parsed.walk((node) => {
    if (node.type !== 'function') return;
    const name = node.value.toLowerCase();
    if (name === 'url') {
      const arg = node.nodes[0];
      const raw = arg && (arg.type === 'string' || arg.type === 'word') ? arg.value : '';
      pending.push(
        (async () => {
          const uri = raw.includes('\\') ? null : await inliner.media(raw, fromPath, 'image_or_font');
          (node as unknown as { type: string }).type = 'word';
          node.value = uri ? `url("${uri}")` : 'none';
          node.nodes = [];
        })(),
      );
      return false;
    }
    if (name === 'image-set' || name === '-webkit-image-set') {
      for (const inner of node.nodes) {
        if (inner.type !== 'string') continue;
        pending.push(
          (async () => {
            const uri = inner.value.includes('\\') ? null : await inliner.media(inner.value, fromPath, 'image');
            inner.value = uri ?? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
          })(),
        );
      }
    }
    return undefined;
  });
  await Promise.all(pending);
  return parsed.toString();
}

async function rewriteCssRoot(root: CssRoot, fromPath: string, inliner: Inliner, depth: number): Promise<void> {
  const imports: postcss.AtRule[] = [];
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() === 'import') imports.push(rule);
  });
  for (const rule of imports) {
    const params = valueParser(rule.params).nodes.filter((n) => n.type !== 'space');
    const first = params[0];
    const target = first?.type === 'string' ? first.value : first?.type === 'function' && first.value.toLowerCase() === 'url' ? (first.nodes[0]?.value ?? '') : null;
    const inlined = params.length === 1 && target !== null && depth < MAX_IMPORT_DEPTH ? await inliner.stylesheet(target, fromPath) : null;
    if (!inlined) {
      rule.remove();
      continue;
    }
    const nested = parseCss(inlined.css);
    if (!nested) {
      rule.remove();
      continue;
    }
    await rewriteCssRoot(nested, inlined.path, inliner, depth + 1);
    rule.replaceWith(...(nested.nodes as CssChildNode[]));
  }
  const decls: postcss.Declaration[] = [];
  root.walkDecls((decl) => {
    decls.push(decl);
  });
  for (const decl of decls) decl.value = await rewriteValue(decl.value, fromPath, inliner);
}

function parseCss(css: string): CssRoot | null {
  try {
    return postcss.parse(css);
  } catch {
    return null;
  }
}

/** A stylesheet with every URL inlined from the snapshot or removed — or `null` when it cannot be parsed or safely embedded. */
async function rewriteStylesheet(css: string, fromPath: string, inliner: Inliner): Promise<string | null> {
  const root = parseCss(css);
  if (!root) return null;
  await rewriteCssRoot(root, fromPath, inliner, 0);
  const out = root.toString();
  // Serialised inside <style>: text that could close the element is never embedded.
  return /<\/style/i.test(out) ? null : out;
}

/** A `style` attribute's declarations, rewritten the same way — or `null` when unparseable. */
async function rewriteDeclarations(style: string, fromPath: string, inliner: Inliner): Promise<string | null> {
  const root = parseCss(`x{${style}}`);
  const rule = root?.first;
  if (!root || root.nodes.length !== 1 || rule?.type !== 'rule') return null;
  for (const node of rule.nodes) {
    if (node.type !== 'decl') return null;
    node.value = await rewriteValue(node.value, fromPath, inliner);
  }
  return rule.nodes.map((n) => n.toString()).join(';');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const NS = parse5Html.NS;
/** Elements whose presence alone is behaviour: removed with everything inside them. */
const REMOVED_ELEMENTS = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'portal', 'template', 'track', 'set']);
const NEUTRAL_LINK_ELEMENTS = new Set(['a', 'area']);
const IMAGE_SRC_ELEMENTS = new Set(['img', 'source', 'input']);
/** Attributes removed from every element. */
const REMOVED_ATTRIBUTE = /^(on.*|formaction|action|target|ping|srcdoc|nonce|integrity|http-equiv|download|manifest|background|lowsrc|dynsrc|longdesc|cite|data|codebase|archive|classid)$/i;

const attr = (element: Element, name: string) => element.attrs.find((a) => a.name === name && !a.prefix)?.value ?? null;
const setAttr = (element: Element, name: string, value: string) => {
  const existing = element.attrs.find((a) => a.name === name && !a.prefix);
  if (existing) existing.value = value;
  else element.attrs.push({ name, value });
};
const removeAttrs = (element: Element, predicate: (a: Element['attrs'][number]) => boolean) => {
  element.attrs = element.attrs.filter((a) => !predicate(a));
};

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function createElement(tagName: string, attrs: { name: string; value: string }[], text: string | null): Element {
  const element = tree.createElement(tagName, NS.HTML, attrs);
  if (text !== null) tree.insertText(element, text);
  return element;
}

function findFirst(node: ParentNode, tagName: string): Element | null {
  for (const child of node.childNodes) {
    if (isElement(child)) {
      if (child.tagName === tagName && child.namespaceURI === NS.HTML) return child;
      const found = findFirst(child, tagName);
      if (found) return found;
    }
  }
  return null;
}

async function rewriteSrcset(value: string, fromPath: string, inliner: Inliner): Promise<string | null> {
  const candidates: string[] = [];
  for (const part of value.split(',')) {
    const [url, ...descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const uri = await inliner.media(url, fromPath, 'image');
    if (uri) candidates.push([uri, ...descriptor].join(' '));
  }
  return candidates.length ? candidates.join(', ') : null;
}

async function rewriteElement(element: Element, fromPath: string, inliner: Inliner): Promise<'keep' | 'remove' | { replace: Element }> {
  const tag = element.tagName.toLowerCase();
  if (REMOVED_ELEMENTS.has(tag)) return 'remove';
  if (tag === 'meta' && element.attrs.some((a) => a.name.toLowerCase() === 'http-equiv')) return 'remove';
  if ((tag === 'animate' || tag === 'animatetransform' || tag === 'animatemotion') && /href/i.test(attr(element, 'attributeName') ?? attr(element, 'attributename') ?? '')) return 'remove';

  if (tag === 'link' && element.namespaceURI === NS.HTML) {
    const rel = (attr(element, 'rel') ?? '').toLowerCase().split(/\s+/);
    const href = attr(element, 'href');
    if (!rel.includes('stylesheet') || href === null) return 'remove';
    const sheet = await inliner.stylesheet(href, fromPath);
    const css = sheet ? await rewriteStylesheet(sheet.css, sheet.path, inliner) : null;
    if (css === null) return 'remove';
    const media = attr(element, 'media');
    return { replace: createElement('style', media ? [{ name: 'media', value: media }] : [], css) };
  }

  removeAttrs(element, (a) => REMOVED_ATTRIBUTE.test(a.name));

  // Links keep their look and lose their destination; the bridge also stops every click.
  if (NEUTRAL_LINK_ELEMENTS.has(tag)) {
    const hadHref = element.attrs.some((a) => a.name === 'href');
    removeAttrs(element, (a) => a.name === 'href');
    if (hadHref) setAttr(element, 'href', '#');
  } else {
    const hrefs = element.attrs.filter((a) => a.name === 'href');
    for (const href of hrefs) {
      if (href.value.trim().startsWith('#')) continue;
      const uri = tag === 'image' || tag === 'feimage' ? await inliner.media(href.value, fromPath, 'image') : null;
      if (uri) href.value = uri;
      else removeAttrs(element, (a) => a === href);
    }
  }

  const src = attr(element, 'src');
  if (src !== null) {
    const uri = IMAGE_SRC_ELEMENTS.has(tag) ? await inliner.media(src, fromPath, 'image') : null;
    removeAttrs(element, (a) => a.name === 'src');
    if (uri) setAttr(element, 'src', uri);
  }
  for (const name of ['srcset', 'imagesrcset']) {
    const value = attr(element, name);
    if (value === null) continue;
    const rewritten = IMAGE_SRC_ELEMENTS.has(tag) ? await rewriteSrcset(value, fromPath, inliner) : null;
    removeAttrs(element, (a) => a.name === name);
    if (rewritten) setAttr(element, name, rewritten);
  }
  const poster = attr(element, 'poster');
  if (poster !== null) {
    const uri = await inliner.media(poster, fromPath, 'image');
    removeAttrs(element, (a) => a.name === 'poster');
    if (uri) setAttr(element, 'poster', uri);
  }
  const style = attr(element, 'style');
  if (style !== null) {
    const rewritten = await rewriteDeclarations(style, fromPath, inliner);
    removeAttrs(element, (a) => a.name === 'style');
    if (rewritten) setAttr(element, 'style', rewritten);
  }
  if (tag === 'style') {
    const text = element.childNodes.map((c) => ('value' in c ? c.value : '')).join('');
    const css = await rewriteStylesheet(text, fromPath, inliner);
    if (css === null) return 'remove';
    for (const child of [...element.childNodes]) tree.detachNode(child);
    tree.insertText(element, css);
  }
  return 'keep';
}

async function rewriteTree(parent: ParentNode, fromPath: string, inliner: Inliner): Promise<void> {
  for (const child of [...parent.childNodes]) {
    if (child.nodeName === '#comment') {
      tree.detachNode(child);
      continue;
    }
    if (!isElement(child)) continue;
    const outcome = await rewriteElement(child, fromPath, inliner);
    if (outcome === 'remove') {
      tree.detachNode(child);
      continue;
    }
    if (outcome !== 'keep') {
      tree.insertBefore(parent, outcome.replace, child);
      tree.detachNode(child);
      continue;
    }
    await rewriteTree(child, fromPath, inliner);
  }
}

export interface EditorPreviewDocument {
  readonly html: string;
  readonly nonce: string;
  /** The response Content-Security-Policy: this nonce, no network, sandboxed. */
  readonly contentSecurityPolicy: string;
}

export function editorPreviewContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-scripts',
  ].join('; ');
}

/**
 * The editor-selection transport view of one exact HTML document of an exact
 * snapshot. `documentPath` is the manifest path the request resolved to; the
 * caller has already proven the snapshot is the exact draft's.
 */
export async function renderEditorPreviewDocument(input: {
  readonly files: EditorPreviewFiles;
  readonly documentPath: string;
  readonly channel: string;
}): Promise<EditorPreviewDocument> {
  const file = await input.files.read(input.documentPath);
  if (!file || baseType(file.contentType) !== 'text/html') throw new TypeError('not an HTML document of the snapshot');
  const inliner = new Inliner(input.files, file.bytes.length);
  const document = parse(Buffer.from(file.bytes).toString('utf8'));
  await rewriteTree(document, input.documentPath, inliner);

  const nonce = randomBytes(18).toString('base64url');
  const head = findFirst(document, 'head');
  const body = findFirst(document, 'body');
  if (!head || !body) throw new TypeError('the parsed document has no head or body');
  tree.appendChild(head, createElement('style', [], EDITOR_PREVIEW_STYLE));
  tree.appendChild(body, createElement('script', [{ name: 'nonce', value: nonce }], editorBridgeSource(input.channel)));
  return { html: serialize(document), nonce, contentSecurityPolicy: editorPreviewContentSecurityPolicy(nonce) };
}
