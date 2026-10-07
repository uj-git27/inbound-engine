import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/tally-payload.json' with { type: 'json' };
import { POST } from '../api/lead.js';
import { background } from '../lib/background.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };

async function submit({ email, name, company }) {
  const payload = structuredClone(fixture);
  const set = (label, value) => { payload.data.fields.find((f) => f.label === label).value = value; };
  if (email) set('Work email', email);
  if (name) set('Full name', name);
  if (company) set('Company name', company);
  payload.data.submissionId = `sub-${email}`;
  await POST(new Request('http://localhost/api/lead', { method: 'POST', body: JSON.stringify(payload) }));
  await background.last;
  const { airtable, slack } = getConnectors();
  const row = [...airtable.tables.get(rules.tables.leads).values()].at(-1).fields;
  return { row, posts: slack.posts };
}

beforeEach(() => {
  process.env.DRY_RUN = 'true';
  delete process.env.TALLY_SIGNING_SECRET;
  resetMocks();
});
afterEach(() => {
  process.env = { ...saved };
});

test('customer alias: alert in #cs-alerts for Priya Shah, tagged DEMO, nothing else posted', async () => {
  const { row, posts } = await submit({ email: 'jainutsav67+customer@gmail.com', company: 'Acme' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'cs-alerts');
  assert.match(posts[0].text, /^For: Priya Shah\n/);
  assert.match(posts[0].text, /Existing customer/);
  assert.equal(row.status, 'routed_customer');
  assert.equal(row.domain, 'acme-test.com');
  assert.equal(row.demo, true);
  assert.equal(row.route, '#cs-alerts');
  assert.equal(row.owner, 'Priya Shah');
});

test('open deal alias: alert in #ae-alerts for the deal owner', async () => {
  const { row, posts } = await submit({ email: 'jainutsav67+deal@gmail.com', company: 'Globex' });
  assert.equal(posts[0].channel, 'ae-alerts');
  assert.match(posts[0].text, /^For: Alex Morgan\n/);
  assert.match(posts[0].text, /open deal "TEST: Globex new business"/);
  assert.equal(row.status, 'routed_open_deal');
});

test('closed lost (known, not active): continues, carrying the history', async () => {
  const { row, posts } = await submit({ email: 'jainutsav67+initech@gmail.com', company: 'Initech' });
  assert.equal(posts[0].channel, 'revops-engine');
  assert.match(posts[0].text, /^For: Ravi Iyer\n/);
  assert.match(posts[0].text, /lost: Pricing, last touch 2026-06-15/);
  assert.equal(row.status, 'awaiting_scoring');
});

test('unknown company: logged note in #revops-engine, not tagged DEMO', async () => {
  const { row, posts } = await submit({ email: 'dana@unknown-co.com', company: 'Unknown Co' });
  assert.equal(posts[0].channel, 'revops-engine');
  assert.match(posts[0].text, /no record for this domain/);
  assert.equal(row.demo, false);
  assert.equal(row.status, 'awaiting_scoring');
});

test('form text cannot inject Slack links or mentions', async () => {
  const { posts } = await submit({ email: 'dana@unknown-co.com', name: '<!channel> <https://evil.example|click>' });
  assert.equal(posts[0].text.includes('<!channel>'), false);
  assert.equal(posts[0].text.includes('<https://evil.example'), false);
  assert.match(posts[0].text, /&lt;!channel&gt;/);
});
