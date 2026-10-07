import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { samples, runSample } from '../lib/samples.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { persona, industryTier, tierOf } from '../lib/score.js';
import { gate, profileFromApollo, profileFromCrm } from '../lib/profile.js';
import { freeChecks, hasWord } from '../lib/checks.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };
beforeEach(() => {
  process.env.DRY_RUN = 'true';
  delete process.env.TALLY_SIGNING_SECRET;
  resetMocks();
});
afterEach(() => {
  process.env = { ...saved };
});

test('there are 15 sample leads', () => assert.equal(samples.length, 15));

for (const sample of samples) {
  test(`sample ${sample.id} -> ${sample.expect.outcome}`, async () => {
    const { problems } = await runSample(sample, getConnectors());
    assert.deepEqual(problems, []);
  });
}

test('prompt injection in the name changes nothing and is escaped in the alert', async () => {
  const sample = samples.find((s) => s.id === '04-prompt-injection');
  const { got } = await runSample(sample, getConnectors());
  assert.equal(got.outcome, 'C');
  assert.equal(got.score, 16);
});

test('a second request from the same email within 30 days is skipped; aliases are exempt', async () => {
  const connectors = getConnectors();
  const founder = samples.find((s) => s.id === '03-logistics-founder');
  assert.equal((await runSample(founder, connectors)).got.outcome, 'B');
  const again = await runSample(founder, connectors);
  assert.equal(again.got.outcome, 'duplicate');
  assert.equal(again.got.calls.length, 0);
  const alias = samples.find((s) => s.id === '08-customer');
  await runSample(alias, connectors);
  assert.equal((await runSample(alias, connectors)).got.outcome, 'customer');
});

test('the Apollo result is cached by domain: a rerun makes no company call', async () => {
  const connectors = getConnectors();
  const sample = samples.find((s) => s.id === '01-temporal-cfo');
  assert.ok((await runSample(sample, connectors)).got.calls.includes('apollo_company'));
  const rerun = await runSample(sample, connectors);
  assert.equal(rerun.got.calls.includes('apollo_company'), false);
  assert.equal(rerun.got.score, 90);
});

test('persona: whole words, and VP of Engineering is engineering', () => {
  const p = rules.scoring.persona;
  assert.equal(persona('CFO').points, p.finance_leader);
  assert.equal(persona('VP Finance').points, p.finance_leader);
  assert.equal(persona('Head of Finance').points, p.finance_leader);
  assert.equal(persona('Corporate Controller').points, p.finance_leader);
  assert.equal(persona('Vice President of Engineering').points, p.engineering);
  assert.equal(persona('Revenue Operations Manager').points, p.revops_billing_finance_manager);
  assert.equal(persona('Billing Lead').points, p.revops_billing_finance_manager);
  assert.equal(persona('Co-Founder & CEO').points, p.founder_ceo);
  assert.equal(persona('Staff Software Engineer').points, p.engineering);
  assert.equal(persona('Office Manager').points, p.other);
  assert.equal(persona('Scfox').points, p.other);
});

test('industry tiers and tier thresholds', () => {
  assert.equal(industryTier('information technology & services, computer software').points, 20);
  assert.equal(industryTier('logistics & supply chain').points, 12);
  assert.equal(industryTier('human resources').points, 5);
  assert.equal(industryTier(null).points, 0);
  assert.deepEqual([60, 59, 40, 39].map(tierOf), ['A', 'B', 'B', 'C']);
});

test('gates: an unknown fact never disqualifies; a range that overlaps passes', () => {
  const base = profileFromApollo(null);
  assert.equal(gate(base), null);
  assert.equal(gate({ ...base, headcount_min: 150, headcount_max: 250 }), null);
  assert.match(gate({ ...base, headcount_min: 2001, headcount_max: 5000 }).reason, /outside 200 to 2000/);
  assert.match(gate({ ...base, country: 'Germany' }).reason, /outside the Americas/);
  assert.equal(gate({ ...base, country: 'Brazil' }), null);
  assert.equal(gate({ ...base, industry: 'venture capital & private equity' }).label, 'not a buyer');
});

test('CRM facts are used only when all four are present and fresh', () => {
  const fresh = { headcount: 450, country: 'United States', industry: 'software', funding_stage: 'Series B', enriched_at: new Date().toISOString() };
  assert.equal(profileFromCrm({ profile: fresh }).source, 'CRM');
  assert.equal(profileFromCrm({ profile: { ...fresh, funding_stage: null } }), null);
  const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
  assert.equal(profileFromCrm({ profile: { ...fresh, enriched_at: old } }), null);
  assert.equal(profileFromCrm(null), null);
});

test('free checks: any other Gmail address is personal; an alias is not', () => {
  const lead = { name: 'A B', company: 'X Co', title: 'CFO' };
  assert.equal(freeChecks({ ...lead, email: 'someone@gmail.com' }).disqualified.label, 'personal email');
  assert.equal(freeChecks({ ...lead, email: 'jainutsav67+temporal@gmail.com', demo: true }).disqualified, null);
  assert.equal(freeChecks({ ...lead, email: 'a@mailinator.com' }).disqualified.label, 'throwaway email');
  assert.equal(freeChecks({ ...lead, email: 'a@acme.com', title: 'Recruiter' }).disqualified.label, 'not a buyer');
  assert.equal(freeChecks({ ...lead, email: 'a@acme.com', title: 'Director of International Finance' }).disqualified, null);
  assert.equal(hasWord('International Sales', ['intern']), null);
});
