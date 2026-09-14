/**
 * The browser-safe half of the customer editor: model view and selection, patch
 * builders, the preview message contract, status words and response types.
 * Nothing here reads a store, a cookie, a file or the network.
 */
export * from './dto.js';
export * from './messages.js';
export * from './model-view.js';
export * from './patches.js';
