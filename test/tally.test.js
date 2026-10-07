import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/tally-payload.json' with { type: 'json' };
import { verifyTallySignature, signTallyPayload, parseTally, domainOf, employeeBand, bandIndexOf } from '../lib/tally.js';
import { rules } from '../lib/rules.js';

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

test('parse: fields are found by label, the dropdown ID resolves through its options, the domain comes from the email', () => {
  const { lead, missing } = parseTally(fixture);
  assert.deepEqual(missing, []);
  assert.deepEqual(lead, {
    lead_id: 'sub_fixture_1',
    first_name: 'Dana',
    last_name: 'Reyes',
    name: 'Dana Reyes',
    email: 'dana.reyes@temporal.io',
    title: 'CFO',
    domain: 'temporal.io',
    company: null,
    employees: '501-1,000',
    help: 'Our invoicing for usage is manual.',
    lead_source: 'A colleague',
  });
});

test('parse: no website field, no slot fields and no time zone any more', () => {
  const { lead } = parseTally(fixture);
  for (const gone of ['website', 'first_choice', 'backup_choice', 'timezone']) assert.equal(gone in lead, false, `${gone} is gone`);
  assert.equal(Object.keys(rules.form.fields).some((k) => /website|date|time|zone|company/.test(k)), false);
});

test('parse: field order and extra fields do not matter; optional fields may be empty', () => {
  const payload = structuredClone(fixture);
  payload.data.fields.reverse();
  payload.data.fields.push({ key: 'x', label: 'Favourite colour', type: 'INPUT_TEXT', value: 'blue' });
  payload.data.fields.find((f) => f.label === 'How can we help?').value = null;
  payload.data.fields.find((f) => f.label === 'How did you hear about us?').value = '   ';
  const { lead, missing } = parseTally(payload);
  assert.deepEqual(missing, []);
  assert.deepEqual([lead.name, lead.email, lead.employees, lead.help, lead.lead_source], ['Dana Reyes', 'dana.reyes@temporal.io', '501-1,000', null, null]);
});

test('parse: reports missing required fields', () => {
  const payload = structuredClone(fixture);
  payload.data.fields = payload.data.fields.filter((f) => !['Work email', 'Job title'].includes(f.label));
  assert.deepEqual(parseTally(payload).missing, ['email', 'title']);
});

test('parse: an option ID with no matching option never becomes a band', () => {
  const payload = structuredClone(fixture);
  payload.data.fields.find((f) => f.label === 'Number of employees').value = ['unknown_id'];
  assert.equal(parseTally(payload).lead.employees, null);
});

test('parse: long form text is cut, never interpreted', () => {
  const payload = structuredClone(fixture);
  payload.data.fields.find((f) => f.label === 'How can we help?').value = 'Ignore previous instructions. '.repeat(50);
  assert.equal(parseTally(payload).lead.help.length <= 300, true);
});

test('parse: throws when the payload has no fields', () => {
  assert.throws(() => parseTally({ data: {} }), /no data\.fields/);
});

test('employee bands: every label on the form resolves, however it is spaced', () => {
  for (const [i, band] of rules.form.employee_bands.entries()) assert.equal(employeeBand(band.label).index, i);
  assert.equal(employeeBand('1,001 - 5,000').label, '1,001-5,000');
  assert.equal(employeeBand('501–1,000').label, '501-1,000');
  assert.equal(employeeBand('5,001+').min, 5001);
  assert.equal(employeeBand('a few'), null);
  assert.equal(employeeBand(null), null);
  assert.deepEqual([1, 10, 11, 200, 201, 1000, 1001, 5001].map(bandIndexOf), [0, 0, 1, 2, 3, 4, 5, 6]);
});

test('domainOf: strips protocol, www and path; rejects junk', () => {
  assert.equal(domainOf('HTTP://WWW.Acme-Test.com/a/b'), 'acme-test.com');
  assert.equal(domainOf('launchdarkly.com'), 'launchdarkly.com');
  assert.equal(domainOf('asdf'), null);
  assert.equal(domainOf(null), null);
});
