import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/tally-payload.json' with { type: 'json' };
import { POST } from '../api/lead.js';
import { background } from '../lib/background.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { signTallyPayload } from '../lib/tally.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };
const request = (body, headers = {}) => new Request('http://localhost/api/lead', { method: 'POST', body, headers });
const leads = () => [...(getConnectors().airtable.tables.get(rules.tables.leads)?.values() ?? [])];

beforeEach(() => {
  process.env.DRY_RUN = 'true';
  delete process.env.TALLY_SIGNING_SECRET;
  delete process.env.AIRTABLE_TOKEN;
  resetMocks();
  background.last = null;
});
afterEach(() => {
  process.env = { ...saved };
});

test('DRY_RUN with no keys: logs the raw payload first, replies 200, then parses', async () => {
  const raw = JSON.stringify(fixture);
  const res = await POST(request(raw));
  assert.equal(res.status, 200);

  const [row] = leads();
  assert.equal(row.fields.raw_payload, raw);
  assert.equal(row.fields.lead_id, 'sub_fixture_1');

  await background.last;
  assert.equal(row.fields.status, 'tier_a');
  assert.equal(row.fields.email, 'dana.reyes@temporal.io');
  assert.equal(row.fields.domain, 'temporal.io');
  assert.equal(row.fields.company, 'Temporal Technologies', 'the company name comes from enrichment, not the form');
  assert.deepEqual([row.fields.employees_reported, row.fields.lead_source, row.fields.in_their_words], ['501-1,000', 'A colleague', 'Our invoicing for usage is manual.']);
  assert.match(row.fields.timeline, /received\n.* parsed\n.* decided\n.* tier_a$/);
  // Qualified, but nothing is booked until the lead picks a time.
  assert.equal(row.fields.booked_slot ?? '', '');
});

test('the pick can arrive before the form: the placeholder row is filled in, not duplicated', async () => {
  const { pickSlot, slotsFor } = await import('../lib/slots.js');
  const connectors = getConnectors();
  const offer = await slotsFor({ sid: 'sub_fixture_1', force: true, connectors });
  const early = await pickSlot({ sid: 'sub_fixture_1', slot: offer.slots[3], tz: 'Europe/London', connectors });
  assert.equal(early.status, 'received');
  assert.equal(leads().length, 1);
  assert.equal(leads()[0].fields.status, 'awaiting_form');

  assert.equal((await POST(request(JSON.stringify(fixture)))).status, 200);
  await background.last;
  assert.equal(leads().length, 1);
  const [row] = leads();
  assert.equal(row.fields.status, 'tier_a');
  assert.equal(row.fields.booked_slot, offer.slots[3], 'scoring finished second, so it booked the time already picked');
  assert.equal(row.fields.buyer_tz, 'Europe/London');
  assert.equal(connectors.google.events.length, 1);
});

test('signing secret set: a valid signature is accepted', async () => {
  process.env.TALLY_SIGNING_SECRET = 'secret';
  const raw = JSON.stringify(fixture);
  const res = await POST(request(raw, { 'Tally-Signature': signTallyPayload(raw, 'secret') }));
  assert.equal(res.status, 200);
  assert.equal(leads().length, 1);
});

test('signing secret set: a bad or missing signature gets 401 and nothing is logged', async () => {
  process.env.TALLY_SIGNING_SECRET = 'secret';
  const raw = JSON.stringify(fixture);
  assert.equal((await POST(request(raw, { 'Tally-Signature': signTallyPayload(raw, 'wrong') }))).status, 401);
  assert.equal((await POST(request(raw))).status, 401);
  assert.equal(leads().length, 0);
});

test('live mode without a signing secret refuses to run', async () => {
  process.env.DRY_RUN = 'false';
  assert.equal((await POST(request(JSON.stringify(fixture)))).status, 500);
});

test('a body that is not JSON gets 400', async () => {
  assert.equal((await POST(request('not json'))).status, 400);
});

test('a payload with missing fields is logged as parse_error with the reason', async () => {
  const payload = structuredClone(fixture);
  payload.data.fields = payload.data.fields.slice(0, 1);
  assert.equal((await POST(request(JSON.stringify(payload)))).status, 200);
  await background.last;
  const [row] = leads();
  assert.equal(row.fields.status, 'parse_error');
  assert.match(row.fields.error, /last_name, email, title/);
});
