import test from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../lib/rules.js';
import { parseTally } from '../lib/tally.js';
import { applySelfReported, gate } from '../lib/profile.js';
import { growthSummary, templateSummary } from '../lib/growth.js';
import { classifyNews } from '../lib/signals.js';
import { buildBrief } from '../lib/brief.js';
import { samplePayload } from '../lib/samples.js';

const sample = { id: 'x', name: 'Dana Reyes', email: 'dana@acme-new.io', title: 'CFO', employees: '201-500' };
const empty = { headcount_min: null, headcount_max: null, country: null, industry: null, funding_stage: null, subsidiaries: [], source: 'unknown' };
const signals = [
  { type: 'funding', date: '2026-06-02', url: 'https://news.example/a', title: 'Acme raises $40M Series B', snippet: 'Acme raised $40M to expand.' },
  { type: 'partnership', date: '2026-03-11', url: 'https://news.example/b', title: 'Acme partners with Globex', snippet: null },
];
const reply = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test('form: industry and country come from their dropdowns; "Other" stays unknown', () => {
  const { lead, missing } = parseTally(samplePayload({ ...sample, industry: 'Fintech / Payments', country: 'Canada' }));
  assert.deepEqual([lead.industry, lead.country, lead.employees, missing.length], ['Fintech / Payments', 'Canada', '201-500', 0]);
  const other = parseTally(samplePayload({ ...sample, industry: 'Other', country: 'Other' })).lead;
  assert.deepEqual([other.industry, other.country], [null, null]);
  const none = parseTally(samplePayload(sample)).lead;
  assert.deepEqual([none.industry, none.country], [null, null]);
});

test('form answers fill only what enrichment left unknown, and are labelled', () => {
  const filled = applySelfReported(empty, null, { industry: 'Fintech / Payments', country: 'Canada' }).profile;
  assert.deepEqual([filled.industry, filled.industry_source, filled.country, filled.country_source], ['Fintech / Payments', 'self-reported', 'Canada', 'self-reported']);
  const kept = applySelfReported({ ...empty, industry: 'software', country: 'United States', source: 'Apollo' }, null, { industry: 'Healthcare', country: 'India' }).profile;
  assert.deepEqual([kept.industry, kept.country, kept.industry_source], ['software', 'United States', undefined]);
});

test('form answers drive the gates when enrichment has nothing', () => {
  const g = (form) => gate(applySelfReported(empty, null, form).profile);
  assert.match(g({ country: 'India' }).reason, /outside the Americas/);
  assert.match(g({ industry: 'Retail / Consumer goods' }).reason, /per the form/);
  assert.match(g({ industry: 'Venture capital / Private equity' }).reason, /Not a buyer/);
  assert.equal(g({ industry: 'Software / SaaS', country: 'United States' }), null);
});

test('every country on the form in the Americas list passes the region gate', () => {
  const americas = rules.form.countries.filter((c) => rules.gates.americas_countries.includes(c.toLowerCase()));
  assert.ok(americas.length >= 8);
});

test('signals older than the window are dropped; partnerships and layoffs are found; a product release is not a signal', () => {
  const now = Date.parse('2026-10-08');
  const found = classifyNews([
    { url: 'https://n.example/1', publishedDate: '2026-05-01', title: 'Acme partners with Globex on billing', highlights: [] },
    { url: 'https://n.example/3', publishedDate: '2026-07-01', title: 'Acme lays off 10% of staff', highlights: [] },
    { url: 'https://n.example/4', publishedDate: '2026-08-01', title: 'Acme launches a new invoicing feature', highlights: [] },
    { url: 'https://n.example/2', publishedDate: '2025-09-01', title: 'Acme raises $10M Series A', highlights: [] },
  ], { company: 'Acme', domain: 'acme.io', now });
  assert.deepEqual(found.map((s) => s.type), ['layoffs', 'partnership']);
});

test('growth summary: none without signals, template without a model', async () => {
  assert.equal(await growthSummary({ signals: [], company: 'Acme', gemini: null }), null);
  const s = await growthSummary({ signals, company: 'Acme', gemini: null });
  assert.equal(s.by, 'template');
  assert.equal(s.text, templateSummary(signals, 'Acme'));
  assert.match(s.text, /2 dated business signals in the last 12 months: funding \(2026-06\), partnership \(2026-03\)/);
});

test('growth summary: Gemini text is used, cut to 3 sentences, without search', async () => {
  let seen = null;
  const gemini = { async generate(prompt, options) { seen = { prompt, options }; return reply('Acme raised $40M in a Series B. It also partnered with Globex. Billing will get harder. A fourth sentence.'); } };
  const s = await growthSummary({ signals, company: 'Acme', gemini });
  assert.equal(s.by, 'Gemini');
  assert.equal(s.text, 'Acme raised $40M in a Series B. It also partnered with Globex. Billing will get harder.');
  assert.equal(seen.options.search, false);
  assert.ok(seen.prompt.includes('2026-06-02 | funding | Acme raises $40M Series B'));
});

test('growth summary: falls back to the template on an added number, an empty reply or an error', async () => {
  for (const generate of [async () => reply('Acme raised $75M.'), async () => reply(''), async () => { throw new Error('HTTP 429'); }]) {
    const notes = [];
    const s = await growthSummary({ signals, company: 'Acme', gemini: { generate }, notes });
    assert.equal(s.by, 'template');
    assert.equal(notes.length, 1);
  }
});

test('brief: shows the summary above the signals and marks form answers', () => {
  const profile = applySelfReported(empty, '201-500', { industry: 'Software / SaaS', country: 'Canada' }).profile;
  const outcome = { profile, pricing: { model: 'unknown' }, signals, growth: { text: 'Acme is growing.', by: 'Gemini' }, tier: 'A', score: 70, breakdown: {} };
  const brief = buildBrief({ lead: { name: 'Dana Reyes', title: 'CFO' }, outcome });
  assert.ok(brief.indexOf('Business changes in the last 12 months') < brief.indexOf('*Why now:*'));
  assert.match(brief, /Acme is growing\. _\(summary written by Gemini from the sources below\)_/);
  assert.match(brief, /HQ Canada \(self-reported on the form\) · Software \/ SaaS \(self-reported on the form\)/);
  assert.equal(buildBrief({ lead: { name: 'Dana Reyes', title: 'CFO' }, outcome: { ...outcome, signals: [], growth: null } }).includes('Business changes in the last'), false);
});
