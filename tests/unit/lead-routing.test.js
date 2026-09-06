import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRoundRobin } from '../../src/modules/lead-routing/service.js';
import { createPoolSchema } from '../../src/modules/lead-routing/schema.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('pickRoundRobin — no cursor starts at the first member', () => {
  assert.equal(pickRoundRobin([A, B, C], null), A);
});

test('pickRoundRobin — advances through the pool in the admin-chosen order', () => {
  assert.equal(pickRoundRobin([A, B, C], A), B);
  assert.equal(pickRoundRobin([A, B, C], B), C);
});

test('pickRoundRobin — wraps around at the end', () => {
  assert.equal(pickRoundRobin([A, B, C], C), A);
});

test('pickRoundRobin — a cursor no longer in the pool restarts, it does not stall', () => {
  // B was switched to a manager role, so eligibleMembers dropped them. The
  // stored cursor still points at B; indexOf is -1 and we must restart at the
  // first member rather than returning undefined.
  const stale = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  assert.equal(pickRoundRobin([A, C], stale), A);
});

test('pickRoundRobin — single-member pool always returns that member', () => {
  assert.equal(pickRoundRobin([A], A), A);
  assert.equal(pickRoundRobin([A], null), A);
});

test('createPoolSchema — the "WhatsApp + Facebook + Instagram -> Z + B" shape validates', () => {
  const parsed = createPoolSchema.parse({
    name: 'Social leads',
    origins: ['whatsapp', 'facebook', 'instagram'],
    member_ids: [A, B],
  });
  assert.deepEqual(parsed.origins, ['whatsapp', 'facebook', 'instagram']);
  assert.deepEqual(parsed.member_ids, [A, B]);
  assert.equal(parsed.strategy, 'load_balanced');
  assert.equal(parsed.priority, 100);
  assert.equal(parsed.is_active, true);
});

test('createPoolSchema — a single name is valid (the "WhatsApp -> Person X" case)', () => {
  const parsed = createPoolSchema.parse({ name: 'WA only', origins: ['whatsapp'], member_ids: [A] });
  assert.deepEqual(parsed.member_ids, [A]);
});

test('createPoolSchema — members may be empty (configure names later)', () => {
  const parsed = createPoolSchema.parse({ name: 'Draft', origins: ['website'] });
  assert.deepEqual(parsed.member_ids, []);
});

test('createPoolSchema — a pool claiming no origin is rejected (can never match)', () => {
  assert.throws(() => createPoolSchema.parse({ name: 'Nope', origins: [] }));
});

test('createPoolSchema — an unknown origin is rejected', () => {
  assert.throws(() => createPoolSchema.parse({ name: 'Nope', origins: ['tiktok'] }));
});

test('createPoolSchema — an unknown strategy is rejected', () => {
  assert.throws(() => createPoolSchema.parse({
    name: 'Nope', origins: ['whatsapp'], strategy: 'by_vibes',
  }));
});
