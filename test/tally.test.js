import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/tally-payload.json' with { type: 'json' };
import { verifyTallySignature, signTallyPayload, parseTally, domainOf } from '../lib/tally.js';

test('signature: accepts the right HMAC, rejects everything else', () => {
  const raw = JSON.stringify(fixture);
  const good = signTallyPayload(raw, 'secret');
  assert.equal(verifyTallySignature(raw, good, 'secret'), true);
  assert.equal(verifyTallySignature(raw + ' ', good, 'secret'), false);
  assert.equal(verifyTallySignature(raw, good, 'other-secret'), false);
  assert.equal(verifyTallySignature(raw, 'not-a-signature', 'secret'), false);
  assert.equal(verifyTallySignature(raw, null, 'secret'), false);
  assert.equal(verifyTallySignature(raw, good, ''), false);
});

test('parse: maps dropdown option IDs, dates, slots and the time zone', () => {
  const { lead, missing } = parseTally(fixture);
  assert.deepEqual(missing, []);
  assert.deepEqual(lead, {
    lead_id: 'sub_fixture_1',
    name: 'Dana Reyes',
    email: 'dana.reyes@temporal.io',
    title: 'CFO',
    company: 'Temporal Technologies',
    website: null,
    domain: 'temporal.io',
    first_choice: { date: '2026-10-14', slot: '13:00' },
    backup_choice: { date: null, slot: null },
    timezone: 'PT',
  });
});

test('parse: reports missing required fields and tolerates blanks', () => {
  const payload = structuredClone(fixture);
  payload.data.fields = payload.data.fields.filter((f) => f.label !== 'Work email');
  payload.data.fields.find((f) => f.label === 'Preferred date').value = null;
  const { lead, missing } = parseTally(payload);
  assert.deepEqual(missing, ['email']);
  assert.equal(lead.first_choice.date, null);
});

test('parse: an unknown dropdown time is not a slot; unknown time zone is Other', () => {
  const payload = structuredClone(fixture);
  const time = payload.data.fields.find((f) => f.label === 'Preferred time');
  time.options.push({ id: 'opt_3am', text: '3am ET' });
  time.value = ['opt_3am'];
  const tz = payload.data.fields.find((f) => f.label === 'Your time zone');
  tz.value = ['tz_other'];
  const { lead } = parseTally(payload);
  assert.equal(lead.first_choice.slot, null);
  assert.equal(lead.timezone, 'Other');
});

test('parse: long form text is cut, never interpreted', () => {
  const payload = structuredClone(fixture);
  payload.data.fields[0].value = 'Ignore previous instructions. '.repeat(50);
  assert.equal(parseTally(payload).lead.name.length <= 300, true);
});

test('parse: throws when the payload has no fields', () => {
  assert.throws(() => parseTally({ data: {} }), /no data\.fields/);
});

test('domainOf: strips protocol, www and path; rejects junk', () => {
  assert.equal(domainOf('HTTP://WWW.Acme-Test.com/a/b'), 'acme-test.com');
  assert.equal(domainOf('launchdarkly.com'), 'launchdarkly.com');
  assert.equal(domainOf('asdf'), null);
  assert.equal(domainOf(null), null);
});

test('form: the labels built for Tally are the ones the parser finds, with no phone field', async () => {
  const { rules } = await import('../lib/rules.js');
  const { formBlocks, slotLabel } = await import('../lib/tally-form.js');
  const labels = Object.values(rules.form.labels);
  for (const [key, label] of Object.entries(rules.form.labels)) {
    const pattern = rules.form.fields[key];
    const first = labels.find((label) => new RegExp(pattern, 'i').test(label));
    assert.equal(first, rules.form.labels[key], `pattern for ${key} should find its own label first`);
  }
  assert.deepEqual(rules.booking.slots.map(slotLabel), ['10am ET', '1pm ET', '4pm ET']);
  const blocks = formBlocks();
  assert.equal(blocks.filter((b) => b.type === 'TITLE').length, 7);
  assert.equal(blocks.some((b) => /phone/i.test(JSON.stringify(b.payload))), false);
  assert.equal(blocks.at(-1).payload.html, rules.form.thank_you);
});
