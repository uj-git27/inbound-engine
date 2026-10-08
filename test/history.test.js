import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHistory, getHistory } from '../lib/history.js';
import { createCache } from '../lib/cache.js';
import { createMockAirtable } from '../lib/connectors/mock/airtable.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { samples, runSample } from '../lib/samples.js';

const now = Date.parse('2026-10-08T12:00:00Z');
const touch = (type, date, extra = {}) => ({ type, date, owner: 'Alex Morgan', ...extra });

test('no history: one line, net new account', () => {
  assert.deepEqual(summarizeHistory({ touches: [], notes: [], deals: [] }), ['No prior activity. Net new account.']);
});

test('unavailable: says so', () => {
  assert.deepEqual(summarizeHistory({ unavailable: true }), ['CRM history unavailable']);
  assert.deepEqual(summarizeHistory(null), ['CRM history unavailable']);
});

test('touches only: count, first date, last touch with its owner and outcome', () => {
  const emails = ['2026-07-08', '2026-07-15', '2026-07-22'].map((d) => touch('email', d, { owner: 'Sam Patel', status: 'OPENED' }));
  assert.deepEqual(summarizeHistory({ touches: emails, notes: [], deals: [] }), ['3 touches since 2026-07-08. Last: email by Sam Patel, 2026-07-22 (no reply).']);
  assert.deepEqual(summarizeHistory({ touches: [touch('call', '2026-09-24T15:00:00Z', { status: 'COMPLETED' })] }), ['1 touch since 2026-09-24. Last: call by Alex Morgan, 2026-09-24 (held).']);
});

test('outcomes: replied, no reply, held, no-show', () => {
  const last = (touches) => /\(([^)]*)\)\.$/.exec(summarizeHistory({ touches })[0])[1];
  assert.equal(last([touch('email', '2026-05-01'), touch('email', '2026-05-02', { incoming: true })]), 'replied');
  assert.equal(last([touch('email', '2026-05-01', { incoming: true }), touch('email', '2026-05-03')]), 'no reply');
  assert.equal(last([touch('meeting', '2026-05-01', { status: 'COMPLETED' })]), 'held');
  assert.equal(last([touch('meeting', '2026-05-01', { status: 'NO_SHOW' })]), 'no-show');
  assert.equal(last([touch('call', '2026-05-01', { status: 'NO_ANSWER' })]), 'no reply');
});

test('deal line: lost with reason and date, open with days in stage; omitted with no deal', () => {
  const lost = { name: 'Initech', stage: 'Closed lost', lost: true, reason: 'Pricing', closed_at: '2026-06-15T00:00:00Z' };
  const open = { name: 'Globex new business', stage: 'Presentation scheduled', entered_stage_at: '2026-10-03T12:00:00Z' };
  assert.deepEqual(summarizeHistory({ deals: [lost] }, now), ['"Initech" Closed lost, Pricing, 2026-06-15.']);
  assert.deepEqual(summarizeHistory({ deals: [lost, open] }, now), ['"Globex new business" Presentation scheduled, 5 days in stage.']);
  assert.equal(summarizeHistory({ touches: [touch('call', '2026-01-01')] }).some((l) => /stage/.test(l)), false);
});

test('note line: latest note, verbatim, first 140 characters, with date and author', () => {
  const long = 'x'.repeat(200);
  const lines = summarizeHistory({ notes: [{ date: '2026-01-01', author: 'Priya Shah', body: 'Older note' }, { date: '2026-08-18', author: 'Priya Shah', body: long }] });
  assert.deepEqual(lines, [`"${'x'.repeat(140)}…" (note, 2026-08-18, Priya Shah)`]);
  assert.deepEqual(summarizeHistory({ notes: [{ date: '2026-08-18', author: '', body: 'Short <b>note</b>' }] }), ['"Short <b>note</b>" (note, 2026-08-18, author unknown)']);
});

test('all three lines, never more', () => {
  const lines = summarizeHistory({
    touches: [touch('meeting', '2026-03-12', { status: 'COMPLETED' }), touch('email', '2026-08-20')],
    deals: [{ name: 'D', stage: 'Closed lost', lost: true, reason: '', closed_at: null }],
    notes: [{ date: '2026-06-15', author: 'Alex Morgan', body: 'Revisit in Q4.' }],
  }, now);
  assert.deepEqual(lines, [
    '2 touches since 2026-03-12. Last: email by Alex Morgan, 2026-08-20 (no reply).',
    '"D" Closed lost, no reason recorded, close date unknown.',
    '"Revisit in Q4." (note, 2026-06-15, Alex Morgan)',
  ]);
});

test('getHistory: saved copy is reused; a failure falls back to it, or to unavailable', async () => {
  const cache = createCache(createMockAirtable());
  let calls = 0;
  const crm = { async history() { calls += 1; return { touches: [touch('call', '2026-01-01')], notes: [], deals: [] }; } };
  const first = await getHistory({ crm, cache, domain: 'a.com' });
  const second = await getHistory({ crm, cache, domain: 'a.com' });
  assert.deepEqual([calls, second], [1, first]);

  const notes = [];
  const broken = { async history() { throw new Error('HTTP 403'); } };
  assert.deepEqual(await getHistory({ crm: broken, cache, domain: 'b.com', notes }), { unavailable: true });
  assert.match(notes[0], /CRM history failed: HTTP 403/);
  assert.deepEqual(await getHistory({ crm: {}, cache, domain: 'c.com' }), { unavailable: true });
  // A company the CRM does not know has an empty history.
  assert.deepEqual(await getHistory({ crm: { history: async () => null }, cache, domain: 'd.com' }), { touches: [], notes: [], deals: [] });
});

// ---------- the cards ----------

const saved = { ...process.env };
beforeEach(() => { process.env.DRY_RUN = 'true'; resetMocks(); });
afterEach(() => { process.env = { ...saved }; });

async function card(email) {
  const c = getConnectors();
  await runSample({ id: `h-${email}`, name: 'Dana Reyes', email, title: 'CFO', expect: {} }, c, { pick: null });
  return c.slack.posts[0].text;
}

test('cards: customer, open deal, expansion and tier brief each carry the history', async () => {
  assert.ok((await card('jainutsav67+customer@gmail.com')).includes('*CRM history:*\n   1 touch since 2026-08-18. Last: meeting by Priya Shah, 2026-08-18 (held).\n   "TEST: Renewal 30 Nov. Asked about a usage-billing add-on." (note, 2026-08-18, Priya Shah)'));
  resetMocks();
  const deal = await card('jainutsav67+deal@gmail.com');
  assert.match(deal, /\*CRM history:\*\n {3}2 touches since 2026-09-24\. Last: meeting by Alex Morgan, 2026-10-03 \(held\)\.\n {3}"TEST: Globex new business" Presentation scheduled, \d+ days? in stage\.\n {3}"TEST: Strong fit\. Waiting on CFO sign-off\." \(note, 2026-10-03, Alex Morgan\)/);
  resetMocks();
  assert.match(await card('jainutsav67+child@gmail.com'), /\*CRM history of TEST: Acme:\*\n {3}1 touch since 2026-08-18/);
  resetMocks();
  const northwind = await card('jainutsav67+northwind@gmail.com');
  assert.match(northwind, /^For: .*\n\*Tier [ABC]/);
  assert.ok(northwind.includes('*CRM history:*\n   3 touches since 2026-07-08. Last: email by Sam Patel, 2026-07-22 (no reply).\n   "TEST: Cold sequence finished, no response." (note, 2026-07-23, Sam Patel)'));
});

test('cards: a company that is not in the CRM gets no history block', async () => {
  const c = getConnectors();
  await runSample(samples.find((s) => s.id.startsWith('01')), c, { pick: null });
  assert.equal(c.slack.posts[0].text.includes('CRM history'), false);
});
