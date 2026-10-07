import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../api/clay-callback.js';
import { signToken, verifyToken } from '../lib/token.js';
import { clayRow } from '../lib/connectors/clay.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };
const callback = (body) =>
  POST(new Request('http://localhost/api/clay-callback', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const addLead = (lead_id) => getConnectors().airtable.createRecord(rules.tables.leads, { lead_id, status: 'parsed' });

beforeEach(() => {
  process.env.DRY_RUN = 'true';
  process.env.LINK_SECRET = 'test-secret';
  resetMocks();
});
afterEach(() => {
  process.env = { ...saved };
});

test('token: tied to the lead, the purpose and the secret', () => {
  const token = signToken('clay', 'lead-1');
  assert.equal(verifyToken('clay', 'lead-1', token), true);
  assert.equal(verifyToken('clay', 'lead-2', token), false);
  assert.equal(verifyToken('other', 'lead-1', token), false);
  assert.equal(verifyToken('clay', 'lead-1', undefined), false);
  process.env.LINK_SECRET = 'another-secret';
  assert.equal(verifyToken('clay', 'lead-1', token), false);
});

test('token: DRY_RUN works with no LINK_SECRET; live mode refuses', () => {
  delete process.env.LINK_SECRET;
  assert.equal(verifyToken('clay', 'lead-1', signToken('clay', 'lead-1')), true);
  process.env.DRY_RUN = 'false';
  assert.throws(() => signToken('clay', 'lead-1'), /LINK_SECRET/);
});

test('row sent to Clay has exactly the spec fields', () => {
  const row = clayRow({ lead_id: 'lead-1', name: 'Dana Reyes', email: 'dana@temporal.io', domain: 'temporal.io', title: 'CFO', timezone: 'PT' });
  assert.deepEqual(Object.keys(row), ['lead_id', 'token', 'name', 'email', 'domain', 'title']);
  assert.equal(verifyToken('clay', 'lead-1', row.token), true);
});

test('callback: saves the person and phone with their sources, and never stores the token', async () => {
  const record = await addLead('lead-1');
  const res = await callback({
    lead_id: 'lead-1',
    token: signToken('clay', 'lead-1'),
    linkedin: 'https://www.linkedin.com/in/dana-reyes',
    title: 'Chief Financial Officer',
    role_start: '2024-03',
    previous_companies: ['Stripe', 'Square'],
    phone: '+1 415 555 1234',
    phone_source: 'Clay',
  });
  assert.equal(res.status, 200);
  assert.equal(record.fields.linkedin, 'https://www.linkedin.com/in/dana-reyes');
  assert.equal(record.fields.person_title, 'Chief Financial Officer');
  assert.equal(record.fields.role_start, '2024-03');
  assert.equal(record.fields.previous_companies, 'Stripe, Square');
  assert.equal(record.fields.person_source, 'Clay');
  assert.equal(record.fields.phone, '+1 415 555 1234');
  assert.equal(record.fields.phone_source, 'Clay');
  assert.equal(record.fields.clay_payload.includes(signToken('clay', 'lead-1')), false);
});

test('callback: empty enrichment saves the payload but claims no source', async () => {
  const record = await addLead('lead-1');
  const res = await callback({ lead_id: 'lead-1', token: signToken('clay', 'lead-1'), linkedin: '', phone: null });
  assert.equal(res.status, 200);
  assert.ok(record.fields.clay_payload);
  assert.equal(record.fields.person_source, undefined);
  assert.equal(record.fields.phone_source, undefined);
});

test('callback: bad token 401, unknown lead 404, bad body 400; nothing saved', async () => {
  const record = await addLead('lead-1');
  assert.equal((await callback({ lead_id: 'lead-1', token: 'wrong', linkedin: 'x' })).status, 401);
  assert.equal((await callback({ lead_id: 'lead-1', token: signToken('clay', 'lead-2'), linkedin: 'x' })).status, 401);
  assert.equal((await callback({ lead_id: 'ghost', token: signToken('clay', 'ghost') })).status, 404);
  assert.equal((await callback('not json')).status, 400);
  assert.equal(record.fields.linkedin, undefined);
});
