import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { companyFactsFromExa } from '../lib/signals.js';
import { mergeWeb, gate, profileFromApollo } from '../lib/profile.js';
import { runSample } from '../lib/samples.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';

const saved = { ...process.env };
beforeEach(() => {
  process.env.DRY_RUN = 'true';
  process.env.BASE_URL = 'https://engine.example';
  delete process.env.TALLY_SIGNING_SECRET;
  resetMocks();
});
afterEach(() => {
  process.env = { ...saved };
});

const cite = (field, url, confidence = 'high') => ({ field, citations: [{ url, title: 't' }], confidence });
const reply = (content, grounding, results = []) => ({ results: results.map((url) => ({ url })), output: { content, grounding } });

const slackReply = reply(
  {
    parent_company: 'Salesforce', parent_domain: 'https://www.salesforce.com/', headcount: '2,935 (as of 2025) / 2,600 (as of 2026)',
    subsidiaries: 'Rimeto (rimeto.com), Slack Fund (slack.com), Woven (woven.com)', hq_country: 'United States',
    latest_funding_stage: 'Secondary Transaction (Jan 28, 2019)', sells_to_businesses: 'yes',
  },
  [
    cite('parent_company', 'https://pitchbook.com/profiles/slack'), cite('parent_domain', 'https://pitchbook.com/profiles/slack', 'medium'),
    cite('subsidiaries', 'https://corpdigest.com/company/slack', 'medium'), cite('headcount', 'https://corpdigest.com/company/slack'),
    cite('hq_country', 'https://slack.com/about'), cite('latest_funding_stage', 'https://pitchbook.com/profiles/slack', 'low'),
    cite('sells_to_businesses', 'https://slack.com/about'),
  ],
);

test('web facts: parent, subsidiaries and facts each carry their source; low confidence is dropped', () => {
  const web = companyFactsFromExa(slackReply, 'slack.com');
  assert.equal(web.verified, true);
  assert.deepEqual(web.parent, { name: 'Salesforce', domain: 'salesforce.com', url: 'https://pitchbook.com/profiles/slack', urls: ['https://pitchbook.com/profiles/slack'], source: 'Exa' });
  assert.deepEqual(web.subsidiaries.map((s) => s.domain), ['rimeto.com', 'woven.com']);
  assert.deepEqual([web.facts.headcount.min, web.facts.headcount.max, web.facts.headcount.url], [2935, 2935, 'https://corpdigest.com/company/slack']);
  assert.equal(web.facts.hq_country.value, 'United States');
  assert.equal(web.facts.latest_funding_stage, undefined);
  assert.equal(web.facts.sells_to_businesses.value, 'yes');
});

test('web facts: ignored unless a page it read is on the company\'s own domain', () => {
  const other = reply({ headcount: '10 to 27 employees', hq_country: 'United States' }, [cite('headcount', 'https://pitchbook.com/x'), cite('hq_country', 'https://linkedin.com/company/sunnie-inc')]);
  assert.deepEqual(companyFactsFromExa(other, 'sunnyside-snacks.com'), { verified: false, facts: {}, parent: null, subsidiaries: [] });
  const own = reply({ headcount: '10 to 27 employees' }, [cite('headcount', 'https://pitchbook.com/x')], ['https://www.sunnyside-snacks.com/about']);
  assert.deepEqual([companyFactsFromExa(own, 'sunnyside-snacks.com').facts.headcount.min, companyFactsFromExa(own, 'sunnyside-snacks.com').facts.headcount.max], [10, 27]);
  assert.equal(companyFactsFromExa({}, 'x.com').verified, false);
  assert.equal(companyFactsFromExa({ output: { content: 'not json' } }, 'x.com').verified, false);
});

test('merge: Apollo values stay, the web fills gaps and adds source links and family', () => {
  const apollo = profileFromApollo({ name: 'Slack', estimated_num_employees: 1800, country: 'United States', industry: 'computer software', owned_by_organization_id: null, suborganizations: [] });
  const merged = mergeWeb(apollo, companyFactsFromExa(slackReply, 'slack.com'));
  assert.equal(merged.headcount_max, 1800, 'Apollo value is kept');
  assert.equal(merged.source, 'Apollo');
  assert.deepEqual(merged.web_sources, { headcount: 'https://corpdigest.com/company/slack', HQ: 'https://slack.com/about' });
  assert.equal(merged.parent.domain, 'salesforce.com');
  assert.equal(merged.family_known, true);

  const unknown = mergeWeb(profileFromApollo(null), companyFactsFromExa(slackReply, 'slack.com'));
  assert.deepEqual([unknown.headcount_min, unknown.country, unknown.source], [2935, 'United States', 'Exa']);
  assert.equal(mergeWeb(apollo, { verified: false }), apollo);
  assert.equal(mergeWeb(apollo, null), apollo);
});

test('gate: a high-confidence web source saying "not B2B" disqualifies; medium does not', () => {
  const base = profileFromApollo(null);
  const high = { ...base, sells_to_businesses: { value: 'no', url: 'https://a.example', confidence: 'high' } };
  assert.match(gate(high).reason, /web source: https:\/\/a\.example/);
  assert.equal(gate({ ...high, sells_to_businesses: { ...high.sells_to_businesses, confidence: 'medium' } }), null);
  assert.equal(gate({ ...high, sells_to_businesses: { ...high.sells_to_businesses, value: 'yes' } }), null);
});

test('a parent found only on the web still routes the lead as an expansion, with the evidence link', async () => {
  const c = getConnectors();
  // Northwind is unknown to the CRM and Apollo lists no parent; the web search finds one that is a customer.
  c.research.companyWeb = async (domain, company, { calls }) => {
    calls.push('exa_company');
    return { verified: true, facts: {}, parent: { name: 'Acme', domain: 'acme-test.com', url: 'https://news.example/acme-buys-northwind', source: 'Exa' }, subsidiaries: [] };
  };
  const sample = { id: 'web-parent', name: 'Sofia Marin', email: 'sofia@northwind-freight.com', title: 'Founder', company: 'Northwind Freight', expect: { outcome: 'expansion', channel: 'cs-alerts' } };
  const { problems, got } = await runSample(sample, c);
  assert.deepEqual(problems, []);
  assert.deepEqual([...got.calls].sort(), ['apollo_company', 'exa_company']);
  assert.match(c.slack.posts[0].text, /its parent Acme \(acme-test\.com\) is a customer _\(family link source: Exa, <https:\/\/news\.example\/acme-buys-northwind\|evidence>\)_/);
  assert.equal(c.crm.rows.get('northwind-freight.com').parent_domain, 'acme-test.com');
});
