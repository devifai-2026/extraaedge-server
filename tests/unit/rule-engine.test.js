import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, materializeActions } from '../../src/services/rule-engine.js';

test('evaluateCondition — all clause matches', () => {
  const ctx = { lead: { stage: 'New', phone: '+9199' } };
  const cond = { all: [{ field: 'lead.stage', op: 'eq', value: 'New' }, { field: 'lead.phone', op: 'exists' }] };
  assert.equal(evaluateCondition(cond, ctx), true);
});

test('evaluateCondition — any clause matches', () => {
  const ctx = { lead: { stage: 'Junk' } };
  const cond = { any: [{ field: 'lead.stage', op: 'eq', value: 'New' }, { field: 'lead.stage', op: 'eq', value: 'Junk' }] };
  assert.equal(evaluateCondition(cond, ctx), true);
});

test('evaluateCondition — missing field with exists', () => {
  assert.equal(evaluateCondition({ all: [{ field: 'lead.email', op: 'not_exists' }] }, { lead: {} }), true);
});

test('materializeActions — substitutes {{...}}', () => {
  const result = materializeActions([{ type: 'assign', user_id: '{{lead.owner_id}}' }], { lead: { owner_id: 'abc-123' } });
  assert.equal(result[0].user_id, 'abc-123');
});
