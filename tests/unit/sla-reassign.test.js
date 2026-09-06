import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyReassignsOnEscalation, REASSIGN_SAME_ROLE } from '../../src/modules/sla/reassign.js';

test('policyReassignsOnEscalation — the seeded stale-lead policy reassigns', () => {
  assert.equal(
    policyReassignsOnEscalation({ action_json: [{ type: REASSIGN_SAME_ROLE }] }),
    true,
  );
});

test('policyReassignsOnEscalation — finds the action alongside others', () => {
  assert.equal(
    policyReassignsOnEscalation({ action_json: [{ type: 'notify' }, { type: REASSIGN_SAME_ROLE }] }),
    true,
  );
});

test('policyReassignsOnEscalation — a notify-only policy does NOT reassign', () => {
  // The pre-existing escalate-and-notify behaviour must stay opt-in-free: a
  // policy that never asked for a handover must not start moving leads.
  assert.equal(policyReassignsOnEscalation({ action_json: [{ type: 'notify' }] }), false);
  assert.equal(policyReassignsOnEscalation({ action_json: [] }), false);
});

test('policyReassignsOnEscalation — tolerates a malformed or absent action_json', () => {
  assert.equal(policyReassignsOnEscalation({}), false);
  assert.equal(policyReassignsOnEscalation({ action_json: null }), false);
  // action_json is `jsonb` with no shape enforcement, so junk is reachable.
  assert.equal(policyReassignsOnEscalation({ action_json: 'reassign_same_role' }), false);
  assert.equal(policyReassignsOnEscalation({ action_json: [null, 'x', 42] }), false);
  assert.equal(policyReassignsOnEscalation(null), false);
  assert.equal(policyReassignsOnEscalation(undefined), false);
});
