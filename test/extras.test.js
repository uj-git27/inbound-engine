import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { samples, runSample } from '../lib/samples.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { runAction } from '../lib/actions.js';
import { classifyNews } from '../lib/signals.js';
import { linkStatus, verifyWebLinks, verifySignalLinks } from '../lib/linkcheck.js';
import { mergeWeb, profileFromApollo } from '../lib/profile.js';
import { buildEmail } from '../lib/emails.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };
const sample = (id) => samples.find((s) => s.id.startsWith(id));
const act = (c, id, action) => runAction({ leadId: `sample-${sample(id).id}`, action, connectors: c });
const buttons = (post) => (post.blocks ?? []).filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.text.text));

beforeEach(() => {
  process.env.DRY_RUN = 'true';
  process.env.BASE_URL = 'https://engine.example';
  process.env.TALLY_FORM_URL = 'https://form.example/demo';
  process.env.SLACK_SIGNING_SECRET = 'slack-secret';
  delete process.env.TALLY_SIGNING_SECRET;
  delete process.env.DEMO_MODE;
  resetMocks();
});
afterEach(() => {
  rules.phone_lookup = false;
  process.env = { ...saved };
});

// ---------- the AE's optional intro email ----------

test('Tier A: the intro email is shown in the thread for review and is not sent until the AE sends it', async () => {
  const c = getConnectors();
  await runSample(sample('01'), c);
  const alert = c.slack.posts[0];
  const [note, draft] = c.slack.posts.filter((p) => p.thread_ts);
  assert.equal(note.thread_ts, alert.ts);
  assert.equal(draft.thread_ts, alert.ts);
  assert.match(draft.text, /^\*Optional intro email from Alex Morgan\* \(not sent; review it, then send it if you want to\):\n\*Subject:\* Introducing myself before our Acme demo\n> Hi Dana,/);
  assert.match(draft.text, /> I'm Alex Morgan, and I'll be running your demo on /);
  assert.match(draft.text, /> 1\. Start with how you bill today \(your pricing page mentions "\$50 per million Actions"\)\./);
  assert.ok(draft.text.includes(rules.emails.productTourUrl));
  assert.deepEqual(buttons(draft), ['Send intro email']);
  assert.deepEqual(c.google.emails.map((e) => e.template), ['tier_a_confirm']);

  assert.match((await act(c, '01', 'send_intro')).message, /The "ae_intro" email was sent to jainutsav67\+temporal@gmail\.com/);
  assert.match((await act(c, '01', 'send_intro')).message, /already done/);
  assert.deepEqual(c.google.emails.map((e) => e.template), ['tier_a_confirm', 'ae_intro']);
  assert.equal(c.google.emails[1].fromName, 'Alex Morgan');
});

test('intro email: the pricing clause appears only when there is a quote to cite', () => {
  const lead = { name: 'Dana Reyes', email: 'dana@acme.com' };
  const without = buildEmail('ae_intro', { lead, outcome: {}, booking: { buyerLocal: 'Tue 10am' }, env: {} });
  assert.match(without.text, /1\. Start with how you bill today\.\n/);
  assert.equal(/\{\w+\}/.test(without.text), false);
});

test('Tier B and Tier C alerts get no intro draft', async () => {
  const c = getConnectors();
  await runSample(sample('03'), c);
  await runSample(sample('04'), c);
  assert.equal(c.slack.posts.some((p) => /Optional intro email/.test(p.text)), false);
});

// ---------- rejection wording ----------

test('rejection emails are warm, never say why, and keep the required lines', () => {
  const lead = { name: 'Riley Chen', email: 'riley@acme.com' };
  const generic = buildEmail('reject_generic', { lead, env: {} }).text;
  assert.match(generic, /Thank you for taking the time to request a demo/);
  assert.match(generic, /a live demo isn't the best fit right now/);
  assert.match(generic, /If we've misjudged this, or things change on your side, just reply to this email\. A real person reads it/);
  for (const template of ['reject_generic', 'reject_personal_email', 'reject_vendor', 'not_a_buyer', 'nurture_tour', 'tier_b_release']) {
    const text = buildEmail(template, { lead, env: { TALLY_FORM_URL: 'https://form.example/demo' } }).text;
    assert.match(text, /^Hi Riley,\n\nThank you/, `${template} opens by thanking them`);
    assert.equal(/too (small|large)|headcount|score|tier|disqualif/i.test(text), false, `${template} never exposes the internal reason`);
  }
});

// ---------- signal summaries and working links ----------

test('each news signal carries a line or two quoted from the article', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const results = [{
    title: 'Temporal raises $550M Series E', url: 'https://a.example/1', publishedDate: '2026-09-23T00:00:00Z',
    highlights: ['Temporal Technologies is a durable execution company based in Bellevue. Temporal raised $550M in a Series E round led by a16z, valuing the company at $12.55B. The funding will go toward AI infrastructure.'],
  }];
  const [signal] = classifyNews(results, { company: 'Temporal Technologies', domain: 'temporal.io', now });
  assert.equal(signal.snippet, 'Temporal raised $550M in a Series E round led by a16z, valuing the company at $12.55B. The funding will go toward AI infrastructure.');
  const [bare] = classifyNews([{ ...results[0], highlights: [] }], { company: 'Temporal', domain: 'temporal.io', now });
  assert.equal(bare.snippet, null);
  const long = classifyNews([{ ...results[0], highlights: [`Temporal raised $550M. ${'x'.repeat(400)}.`] }], { company: 'Temporal', domain: 'temporal.io', now })[0];
  assert.ok(long.snippet.length <= 260);
});

test('the brief shows the quoted line under each signal', async () => {
  const c = getConnectors();
  c.research.news = async (domain, company, { calls }) => {
    calls.push('exa_news');
    return [{ type: 'funding', date: '2026-09-23', url: 'https://a.example/1', title: 'Temporal raises $550M', snippet: 'Temporal raised $550M in a Series E round.' }];
  };
  await runSample(sample('01'), c);
  assert.match(c.slack.posts[0].text, /\*Why now:\* \n {3}• 2026-09-23 · funding · <https:\/\/a\.example\/1\|Temporal raises \$550M>\n {6}_"Temporal raised \$550M in a Series E round\."_/);
});

test('link check: only a link we are sure is dead counts as dead', async () => {
  const reply = (status) => async () => ({ status, body: { cancel: async () => {} } });
  assert.equal(await linkStatus('https://x.example', { fetchImpl: reply(200) }), 'ok');
  assert.equal(await linkStatus('https://x.example', { fetchImpl: reply(404) }), 'dead');
  assert.equal(await linkStatus('https://x.example', { fetchImpl: reply(410) }), 'dead');
  assert.equal(await linkStatus('https://x.example', { fetchImpl: reply(403) }), 'unknown', 'a site that blocks robots may work for a person');
  assert.equal(await linkStatus('https://x.example', { fetchImpl: reply(503) }), 'unknown');
  assert.equal(await linkStatus('https://x.example', { fetchImpl: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); } }), 'dead');
  assert.equal(await linkStatus('https://x.example', { fetchImpl: async () => { throw new Error('timeout'); } }), 'unknown');
});

test('a fact keeps the first cited page that works; with none, it keeps its value and loses the link', async () => {
  const status = { 'https://dead.example': 'dead', 'https://blocked.example': 'unknown', 'https://ok.example': 'ok' };
  const check = async (url) => status[url];
  const web = {
    verified: true,
    facts: {
      headcount: { value: '500', min: 500, max: 500, url: 'https://dead.example', urls: ['https://dead.example', 'https://blocked.example', 'https://ok.example'], confidence: 'high' },
      hq_country: { value: 'United States', url: 'https://dead.example', urls: ['https://dead.example', 'https://blocked.example'], confidence: 'high' },
      latest_funding_stage: { value: 'Series B', url: 'https://dead.example', urls: ['https://dead.example'], confidence: 'high' },
    },
    parent: null, subsidiaries: [],
  };
  await verifyWebLinks(web, check);
  assert.deepEqual([web.facts.headcount.url, web.facts.hq_country.url, web.facts.latest_funding_stage.url], ['https://ok.example', 'https://blocked.example', null]);
  const merged = mergeWeb(profileFromApollo(null), web);
  assert.deepEqual(merged.web_sources, { headcount: 'https://ok.example', HQ: 'https://blocked.example' });
  assert.equal(merged.funding_stage, 'Series B', 'the value stays even without a link');
  const signals = await verifySignalLinks([{ type: 'funding', url: 'https://dead.example' }, { type: 'm_and_a', url: 'https://ok.example' }], check);
  assert.deepEqual(signals.map((s) => s.type), ['m_and_a']);
});

// ---------- a new company is written to the CRM ----------

test('a new company that books is saved to the CRM with its details, and the contact is linked to it', async () => {
  const c = getConnectors();
  assert.equal(c.crm.rows.has('northwind-freight.com'), false);
  await runSample(sample('03'), c);
  const company = c.crm.rows.get('northwind-freight.com');
  assert.deepEqual(
    [company.name, company.headcount, company.country, company.industry, company.funding_stage, company.tier, company.score],
    ['Northwind Freight', 800, 'United States', 'logistics & supply chain', 'Series A', 'B', 42],
  );
  assert.match(company.demo_slot, /\d{1,2}:\d{2} (AM|PM)/);
  assert.match(company.reasons, /persona 15\/30 \(founder ceo\)/);
  assert.ok(company.enriched_at);
  const contact = c.crm.contacts.get('sofia@northwind-freight.com');
  assert.deepEqual([contact.name, contact.title, contact.tier, contact.domain], ['Sofia Marin', 'Founder', 'B', 'northwind-freight.com']);
});

test('a meeting booked later by a person also reaches the CRM record', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  assert.equal(c.crm.rows.get('brightpath-hr.com').demo_slot, undefined);
  await act(c, '04', 'verdict_wrong_A');
  assert.match(c.crm.rows.get('brightpath-hr.com').demo_slot, /\d{1,2}:\d{2} (AM|PM)/);
});

test('contact details found later are added to the CRM contact without losing the earlier ones', async () => {
  rules.phone_lookup = true;
  const c = getConnectors();
  c.fullenrich.findPhone = async () => '+1 415 555 0199';
  await runSample(sample('03'), c);
  const contact = c.crm.contacts.get('sofia@northwind-freight.com');
  assert.deepEqual([contact.phone, contact.name, contact.tier], ['+1 415 555 0199', 'Sofia Marin', 'B']);
});

test('a made-up company (a -test.com demo domain) has no news, and no news search is paid for', async () => {
  const { createResearch } = await import('../lib/research.js');
  const { createCache } = await import('../lib/cache.js');
  const { createMockAirtable } = await import('../lib/connectors/mock/airtable.js');
  let searched = 0;
  const exa = { async searchNews() { searched += 1; return { results: [] }; } };
  const research = createResearch({ exa, cache: createCache(createMockAirtable()) });
  const calls = [];
  assert.deepEqual(await research.news('vandelay-test.com', 'Vandelay', { calls, notes: [] }), []);
  assert.equal(searched, 0);
  assert.deepEqual(calls, []);
  await research.news('vandelay.com', 'Vandelay', { calls, notes: [] });
  assert.equal(searched, 1, 'a real-looking domain is still searched');
});
