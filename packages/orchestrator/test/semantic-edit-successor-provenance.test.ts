/**
 * The semantic-edit successor reason, as a contract — offline.
 *
 * Two exact editable-site-model versions, each with its content hash, and
 * nothing else: no customer, session, patch copy, source or time.
 */
import { describe, expect, it } from 'vitest';
import { BuildSuccessorProvenance, SemanticEditSuccessorProvenance, VisualRefinementSuccessorProvenance, ReplanSuccessorProvenance } from '@statxai/contracts';

const model = (version: number, hash = String(version).repeat(64).slice(0, 64)) => ({ name: 'editable-site-model', version, contentHash: hash });
const valid = { kind: 'semantic_edit', baseEditableSiteModel: model(1), editableSiteModel: model(2) };

describe('semantic-edit successor provenance', () => {
  it('parses exactly two exact editable-site-model refs, as a member of the one successor union', () => {
    expect(SemanticEditSuccessorProvenance.parse(valid)).toEqual(valid);
    expect(BuildSuccessorProvenance.parse(valid)).toEqual(valid);
  });

  it.each([
    ['a missing base model', { kind: 'semantic_edit', editableSiteModel: model(2) }],
    ['a missing result model', { kind: 'semantic_edit', baseEditableSiteModel: model(1) }],
    ['a ref naming another artifact', { ...valid, editableSiteModel: { ...model(2), name: 'site-plan' } }],
    ['a base naming another artifact', { ...valid, baseEditableSiteModel: { ...model(1), name: 'visual-quality-review' } }],
    ['a ref with no content hash', { ...valid, editableSiteModel: { name: 'editable-site-model', version: 2 } }],
    ['a malformed content hash', { ...valid, editableSiteModel: model(2, 'not-a-hash') }],
    ['a non-positive version', { ...valid, baseEditableSiteModel: model(0) }],
    ['the same version as base and result', { ...valid, editableSiteModel: model(1, 'f'.repeat(64)) }],
    ['a customer identity riding along', { ...valid, customerUserId: 'cu_0123456789abcdef0123456789abcdef' }],
    ['a session riding along', { ...valid, sessionId: 'x' }],
    ['a copied patch riding along', { ...valid, patch: { op: 'set_field_value' } }],
    ['a timestamp riding along', { ...valid, requestedAt: '2026-09-14T00:00:00Z' }],
  ])('rejects %s', (_label, shape) => {
    expect(BuildSuccessorProvenance.safeParse(shape).success).toBe(false);
  });

  it('rejects an unknown successor kind, and never lets one kind pass as another', () => {
    expect(BuildSuccessorProvenance.safeParse({ ...valid, kind: 'customer_edit' }).success).toBe(false);
    expect(ReplanSuccessorProvenance.safeParse(valid).success).toBe(false);
    expect(VisualRefinementSuccessorProvenance.safeParse(valid).success).toBe(false);
    expect(SemanticEditSuccessorProvenance.safeParse({ kind: 'replan', replanDecision: { name: 'replan-decision', version: 1 } }).success).toBe(false);
  });
});
