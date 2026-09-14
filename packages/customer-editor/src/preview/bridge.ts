/**
 * The one trusted script an editor preview executes.
 *
 * It runs inside a frame sandboxed without same-origin, under a CSP that admits
 * only its own per-response nonce and no network at all. It holds no credential,
 * reads no cookie (an opaque origin has none) and cannot call any API. It does
 * exactly the editor interaction: outline the marked object under the pointer,
 * stop the site's own navigation and actions, and tell the parent which
 * `data-statx-*-id` markers surround a click — the nearest of each kind, never a
 * position, a text or a selector. The parent decides what, if anything, that
 * selects.
 */
import { SITE_MODEL_MARKERS } from '@statxai/contracts/editable-site-model';
import { PREVIEW_CHANNEL, PREVIEW_MESSAGE_TYPE } from '../messages.js';

export const EDITOR_PREVIEW_STYLE = `
[data-statx-editor-hover]{outline:2px dashed #2563eb!important;outline-offset:2px!important;cursor:pointer!important}
[data-statx-editor-selected]{outline:3px solid #2563eb!important;outline-offset:2px!important}
`;

/** The bridge's source for one preview document. `channel` is validated before it is embedded. */
export function editorBridgeSource(channel: string): string {
  if (!PREVIEW_CHANNEL.test(channel)) throw new TypeError('invalid preview channel');
  const config = JSON.stringify({ channel, type: PREVIEW_MESSAGE_TYPE, markers: SITE_MODEL_MARKERS });
  return `(() => {
  'use strict';
  const C = ${config};
  const KINDS = Object.keys(C.markers);
  const post = (message) => window.parent.postMessage(Object.assign({ type: C.type, version: 1, channel: C.channel }, message), '*');
  const elementOf = (target) => (target instanceof Element ? target : target && target.parentElement) || null;
  const chain = (element) => {
    const markers = {};
    for (let node = element; node; node = node.parentElement) {
      for (const kind of KINDS) {
        if (markers[kind] === undefined && node.hasAttribute(C.markers[kind])) markers[kind] = node.getAttribute(C.markers[kind]);
      }
    }
    return markers;
  };
  const nearestMarked = (element) => {
    for (let node = element; node; node = node.parentElement) {
      if (KINDS.some((kind) => node.hasAttribute(C.markers[kind]))) return node;
    }
    return null;
  };
  const halt = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  let hovered = null;
  document.addEventListener('mouseover', (event) => {
    const marked = nearestMarked(elementOf(event.target));
    if (hovered && hovered !== marked) hovered.removeAttribute('data-statx-editor-hover');
    hovered = marked;
    if (marked) marked.setAttribute('data-statx-editor-hover', '');
  }, true);
  document.addEventListener('click', (event) => {
    halt(event);
    const element = elementOf(event.target);
    post({ event: 'select', markers: element ? chain(element) : {} });
  }, true);
  for (const type of ['submit', 'auxclick', 'dragstart']) document.addEventListener(type, halt, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') halt(event); }, true);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== C.type || data.version !== 1 || data.channel !== C.channel || data.event !== 'highlight') return;
    for (const node of document.querySelectorAll('[data-statx-editor-selected]')) node.removeAttribute('data-statx-editor-selected');
    if (typeof data.kind !== 'string' || typeof data.id !== 'string' || !KINDS.includes(data.kind) || !/^(pg|sec|blk|fld|ast)_[a-f0-9]{16}$/.test(data.id)) return;
    const found = document.querySelector('[' + C.markers[data.kind] + '="' + data.id + '"]');
    if (found) { found.setAttribute('data-statx-editor-selected', ''); found.scrollIntoView({ block: 'nearest' }); }
  });
  post({ event: 'ready' });
})();`;
}
