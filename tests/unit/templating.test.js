import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, extractVariables, buildContext } from '../../src/lib/templating.js';

test('render — mustache + percent styles', () => {
  const ctx = buildContext({ lead: { name: 'Rahul', email: '[email protected]' }, tenant: { name: 'Demo' }, counsellor: { name: 'Priya' } });
  const { rendered, missing } = render('Hi {{Lead.FullName}} from %Tenant.Name%', ctx);
  assert.equal(rendered, 'Hi Rahul from Demo');
  assert.deepEqual(missing, []);
});

test('render — reports missing vars', () => {
  const { missing } = render('{{Lead.Phone}} — {{NotAThing}}', buildContext({ lead: { phone: null } }));
  assert.ok(missing.includes('Lead.Phone'));
  assert.ok(missing.includes('NotAThing'));
});

test('extractVariables — dedupes', () => {
  const vars = extractVariables('{{A.b}} {{A.b}} %C.d%');
  assert.deepEqual(vars.sort(), ['A.b', 'C.d']);
});
