/**
 * The deterministic policy layer.
 *
 * Models provide intelligence; the harness provides authority — and this is the
 * part of that authority which only decides. It is handed authoritative facts
 * and returns deterministic, explainable results. It calls no model, touches no
 * database, reads no environment, writes no file and deploys nothing.
 *
 * The dependency runs one way: contracts → policy-engine → orchestrator. This
 * package never imports the layer it advises, which is why a defect reaches it
 * as `{ id, severity }` and authorisation returns ids for the caller to resolve.
 */
export * from './types.js';
export * from './severity.js';
export * from './routing.js';
export * from './adjudication.js';
export * from './replanning.js';
export * from './release.js';
