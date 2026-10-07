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
  assert.equal(row.fields.status, 'awaiting_scoring');
  assert.equal(row.fields.email, 'dana.reyes@temporal.io');
  assert.equal(row.fields.domain, 'temporal.io');
  assert.equal(row.fields.first_choice, '2026-10-14 13:00 ET');
  assert.equal(row.fields.time_zone, 'PT');
  assert.match(row.fields.timeline, /received\n.* parsed\n.* awaiting_scoring$/);
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
  assert.match(row.fields.error, /email, company/);
});
