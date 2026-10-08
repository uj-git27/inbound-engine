import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../lib/rules.js';
import { tableDefinitions } from '../lib/airtable-schema.js';
import { seed } from '../lib/seed.js';
import { buildRawEmail } from '../lib/connectors/google.js';

test('rules: 5 team roles, each with a name and its own channel', () => {
  const members = Object.values(rules.team);
  assert.equal(members.length, 5);
  for (const m of members) assert.ok(m.name && m.channel && m.gets);
  assert.equal(new Set(members.map((m) => m.channel)).size, 5);
});

test('rules: scoring adds up to 100 and tiers match the spec', () => {
  const s = rules.scoring;
  assert.equal(s.fit.max + s.persona.max + s.billing_model.max + s.why_now.max, 100);
  assert.equal(s.fit.industry.core.points + s.fit.funded, s.fit.max);
  assert.deepEqual(rules.tiers, { A: 60, B: 40 });
  assert.deepEqual(rules.signals.points, {
    funding: 10, new_finance_leader: 10, ipo_prep: 10, m_and_a: 8, revenue_milestone: 6, international_expansion: 6,
  });
});

test('rules: demo aliases map to the 6 spec domains, plus the ones added for the demo', () => {
  assert.deepEqual(Object.values(rules.demo_aliases), [
    'temporal.io', 'launchdarkly.com', 'acme-test.com', 'globex-test.com', 'initech-test.com', 'slack.com', 'acme-labs-test.com', 'newrelic.com', 'northwind-test.com',
  ]);
});

test('schema: Leads, Cache and CRM tables with unique field names', () => {
  assert.deepEqual(tableDefinitions.map((t) => t.name), ['Leads', 'Cache', 'CRM']);
  for (const t of tableDefinitions) assert.equal(new Set(t.fields.map((f) => f.name)).size, t.fields.length);
});

test('seed: the TEST records, owned by real team roles', () => {
  assert.deepEqual(seed.map((r) => r.domain), ['acme-test.com', 'globex-test.com', 'initech-test.com', 'acme-labs-test.com', 'salesforce.com', 'northwind-test.com']);
  for (const r of seed) assert.ok(rules.team[r.owner_role]);
});

test('gmail: raw message is base64url RFC 2822', () => {
  const decoded = Buffer.from(buildRawEmail({ to: 'a@b.co', subject: 'Hi', text: 'Body' }), 'base64url').toString();
  assert.match(decoded, /^To: a@b\.co\r\nSubject: =\?UTF-8\?B\?SGk=\?=\r\n/);
  assert.match(decoded, /\r\n\r\nBody$/);
});
