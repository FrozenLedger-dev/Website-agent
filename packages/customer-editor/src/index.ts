/**
 * The customer editor, server side: project discovery, the one editor-state
 * loader, the isolated snapshot preview transport, durable edit submission and
 * edit status — and the HTTP handlers the customer app routes call.
 *
 * Browser code imports `@statxai/customer-editor/client` instead.
 */
export * from './client.js';
export * from './creation.js';
export * from './editor-state.js';
export * from './edits.js';
export * from './http.js';
export * from './projects.js';
export * from './preview/bridge.js';
export * from './preview/transport.js';
