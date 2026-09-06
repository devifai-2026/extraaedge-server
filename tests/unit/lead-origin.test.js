import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOrigin, originSqlPredicate, LEAD_ORIGINS } from '../../src/lib/leadOrigin.js';

test('classifyOrigin — whatsapp inbox lead', () => {
  assert.equal(classifyOrigin({ first_touch_source: 'whatsapp' }), 'whatsapp');
  assert.equal(classifyOrigin({ first_touch_channel: 'WhatsApp' }), 'whatsapp');
});

test('classifyOrigin — whatsapp is an EXACT match, not a substring', () => {
  // A campaign merely named after the channel is not a WhatsApp-inbox lead.
  assert.equal(classifyOrigin({ first_touch_source: 'whatsapp-march-campaign' }), null);
});

test('classifyOrigin — facebook lead ads', () => {
  assert.equal(
    classifyOrigin({ first_touch_source: 'Facebook Lead Ads', first_touch_channel: 'Facebook' }),
    'facebook',
  );
});

test('classifyOrigin — instagram wins over facebook on a Meta leadgen lead', () => {
  // Meta delivers Instagram lead ads on the SAME webhook as Facebook, so the
  // source can stay facebook-ish while the channel says Instagram. The more
  // specific origin has to win or Instagram leads route as Facebook.
  assert.equal(
    classifyOrigin({ first_touch_source: 'Facebook Lead Ads', first_touch_channel: 'Instagram' }),
    'instagram',
  );
});

test('classifyOrigin — website form (domain lives in the source)', () => {
  assert.equal(
    classifyOrigin({ first_touch_channel: 'Website', first_touch_source: 'speedupinfotech.com' }),
    'website',
  );
  // The domain alone must NOT classify as website — only the channel does.
  assert.equal(classifyOrigin({ first_touch_source: 'speedupinfotech.com' }), null);
});

test('classifyOrigin — justdial', () => {
  assert.equal(classifyOrigin({ first_touch_source: 'Justdial' }), 'justdial');
});

test('classifyOrigin — plain manual / bulk-import lead has no origin', () => {
  assert.equal(classifyOrigin({ first_touch_source: 'Referral' }), null);
  assert.equal(classifyOrigin({}), null);
  assert.equal(classifyOrigin(null), null);
  assert.equal(classifyOrigin({ first_touch_source: null, first_touch_channel: undefined }), null);
});

test('originSqlPredicate — aliased and unaliased forms', () => {
  assert.equal(
    originSqlPredicate('whatsapp', ''),
    "(first_touch_source ILIKE 'whatsapp' OR first_touch_channel ILIKE 'whatsapp')",
  );
  assert.equal(
    originSqlPredicate('instagram', 'l'),
    "(l.first_touch_source ILIKE '%instagram%' OR l.first_touch_channel ILIKE '%instagram%')",
  );
  // website keys off the channel only
  assert.equal(originSqlPredicate('website', 'l'), "(l.first_touch_channel ILIKE '%website%')");
});

test('originSqlPredicate — unknown origin returns null so callers skip the clause', () => {
  assert.equal(originSqlPredicate('tiktok', 'l'), null);
});

test('every declared origin has a predicate', () => {
  for (const o of LEAD_ORIGINS) {
    assert.ok(originSqlPredicate(o, 'l'), `missing predicate for ${o}`);
  }
});
