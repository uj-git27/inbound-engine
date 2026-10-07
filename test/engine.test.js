import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { samples, samplePayload, runSample, sampleDate } from '../lib/samples.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { runPipeline } from '../lib/pipeline.js';
import { runAction } from '../lib/actions.js';
import { actionUrl, verifyAction } from '../lib/links.js';
import { candidateSlots, firstFree, zonedToUtc } from '../lib/booking.js';
import { classifyNews, classifyPricing, personFromApollo } from '../lib/signals.js';
import { customerStory, showPhone } from '../lib/brief.js';
import { buildSummary } from '../lib/summary.js';
import { signToken } from '../lib/token.js';
import { GET as actionGet, POST as actionPost } from '../api/action.js';
import { POST as clayCallback } from '../api/clay-callback.js';
import { POST as leadPost } from '../api/lead.js';
import { background } from '../lib/background.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };
const sample = (id) => samples.find((s) => s.id.startsWith(id));
const row = (c, id) => [...c.airtable.tables.get(rules.tables.leads).values()].find((r) => r.fields.lead_id === `sample-${sample(id).id}`);
const act = (c, id, action) => runAction({ leadId: `sample-${sample(id).id}`, action, connectors: c });

beforeEach(() => {
  process.env.DRY_RUN = 'true';
  process.env.BASE_URL = 'https://engine.example';
  process.env.TALLY_FORM_URL = 'https://form.example/demo';
  delete process.env.TALLY_SIGNING_SECRET;
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.DEMO_MODE;
  resetMocks();
});
afterEach(() => {
  process.env = { ...saved };
});

// ---------- booking ----------

test('booking: daylight saving is handled when converting ET to UTC', () => {
  assert.equal(new Date(zonedToUtc('2026-10-20', '10:00', 'America/New_York')).toISOString(), '2026-10-20T14:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-12-01', '10:00', 'America/New_York')).toISOString(), '2026-12-01T15:00:00.000Z');
});

test('booking: preferred slot first; weekend, past and too-soon choices roll forward', () => {
  const now = zonedToUtc('2026-10-19', '09:00', 'America/New_York'); // a Monday
  const slot = (preferred) => { const s = candidateSlots(preferred, now)[0]; return `${s.date} ${s.slot}`; };
  assert.equal(slot({ date: '2026-10-21', slot: '13:00' }), '2026-10-21 13:00');
  assert.equal(slot({ date: '2026-10-24', slot: '10:00' }), '2026-10-26 10:00'); // Saturday -> Monday
  assert.equal(slot({ date: '2026-10-01', slot: '10:00' }), '2026-10-19 13:00'); // past -> next slot 2h+ away
  assert.equal(slot({ date: '2026-10-19', slot: '10:00' }), '2026-10-19 13:00'); // less than 2 hours away
  assert.equal(slot(null), '2026-10-19 13:00');
  const all = candidateSlots(null, now);
  assert.equal(new Set(all.map((s) => s.date)).size, 10);
  assert.ok(all.every((s) => ![0, 6].includes(new Date(`${s.date}T00:00:00Z`).getUTCDay())));
});

test('booking: a busy preferred slot falls to the next free one', () => {
  const now = zonedToUtc('2026-10-19', '09:00', 'America/New_York');
  const slots = candidateSlots({ date: '2026-10-21', slot: '10:00' }, now);
  const busy = [{ start: '2026-10-21T14:00:00Z', end: '2026-10-21T15:00:00Z' }];
  const free = firstFree(slots, busy);
  assert.equal(`${free.date} ${free.slot}`, '2026-10-21 13:00');
  assert.equal(firstFree(slots, [{ start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' }]), null);
});

// ---------- signals ----------

const NOW = Date.parse('2026-10-07T00:00:00Z');

test('news: each signal needs a date, a URL, the company name and the 12-month window', () => {
  const results = [
    { title: 'Temporal raises $550M Series E', url: 'https://a.example/1', publishedDate: '2026-09-01T00:00:00Z', highlights: [] },
    { title: 'Temporal appoints Jane Doe as CFO', url: 'https://a.example/2', publishedDate: '2026-05-01T00:00:00Z', highlights: [] },
    { title: 'Temporal acquires a startup', url: 'https://a.example/3', publishedDate: '2024-01-01T00:00:00Z', highlights: [] }, // too old
    { title: 'Rival raises $90M Series C', url: 'https://a.example/4', publishedDate: '2026-08-01T00:00:00Z', highlights: [] }, // other company
    { title: 'Temporal plans IPO', url: '', publishedDate: '2026-08-01T00:00:00Z', highlights: [] }, // no URL
    { title: 'Temporal expands into Europe', url: 'https://a.example/6', highlights: [] }, // no date
    { title: 'Temporal raises $100M', url: 'https://a.example/7', publishedDate: '2026-02-01T00:00:00Z', highlights: [] }, // older duplicate type
  ];
  const signals = classifyNews(results, { company: 'Temporal Technologies', domain: 'temporal.io', now: NOW });
  assert.deepEqual(signals.map((s) => [s.type, s.date, s.url]), [
    ['funding', '2026-09-01', 'https://a.example/1'],
    ['new_finance_leader', '2026-05-01', 'https://a.example/2'],
  ]);
});

test('news: all six signal types are recognised', () => {
  const titles = {
    funding: 'Acme secures $40M in new funding round',
    new_finance_leader: 'Acme names new CFO',
    ipo_prep: 'Acme files for public listing ahead of IPO',
    m_and_a: 'Acme acquires BetaCo',
    revenue_milestone: 'Acme hits $100M in ARR',
    international_expansion: 'Acme opens new office in London',
  };
  for (const [type, title] of Object.entries(titles)) {
    const got = classifyNews([{ title, url: 'https://n.example', publishedDate: '2026-06-01T00:00:00Z' }], { company: 'Acme', domain: 'acme.com', now: NOW });
    assert.ok(got.some((s) => s.type === type), `${type} not found in "${title}"`);
  }
});

test('pricing: usage, hybrid, tiered, contact sales and unknown, with a quoted line that has a number', () => {
  assert.deepEqual(classifyPricing('# Pricing\nSimple usage-based pricing\n$25 per million Actions\n'), { model: 'usage', quote: '$25 per million Actions', url: null });
  assert.equal(classifyPricing('Pro plan\n$20 per user per month\nplus $0.10 per API call').model, 'hybrid');
  const tiered = classifyPricing('Team plan\n**$49 per seat** billed annually');
  assert.deepEqual([tiered.model, tiered.quote], ['tiered', '$49 per seat billed annually']);
  assert.equal(classifyPricing('Enterprise\nContact sales for a quote').model, 'contact_sales');
  assert.deepEqual(classifyPricing('Welcome to our website'), { model: 'unknown', quote: null, url: null });
});

test('person and story helpers', () => {
  const person = personFromApollo({
    title: 'CFO', linkedin_url: 'https://linkedin.com/in/x',
    employment_history: [{ current: true, start_date: '2024-03-01', organization_name: 'Now Co' }, { organization_name: 'Stripe' }, { organization_name: 'Square' }],
  });
  assert.deepEqual(person, { linkedin: 'https://linkedin.com/in/x', title: 'CFO', role_start: '2024-03', previous_companies: ['Stripe', 'Square'], source: 'Apollo' });
  assert.equal(personFromApollo(null), null);
  assert.equal(customerStory({ industry: 'hospital & health care' }, { model: 'usage' }).story, 'Sardine');
  assert.equal(customerStory({ industry: 'hospital & health care' }, { model: 'tiered' }).story, 'Thriva');
  assert.equal(customerStory({ industry: 'logistics & supply chain' }, { model: 'contact_sales' }).story, 'Yembo');
  assert.equal(customerStory({ industry: 'computer software' }, { model: 'tiered' }).story, 'Vertice');
  assert.equal(showPhone('+1 (415) 555-1234', { DEMO_MODE: 'true' }), '•••• 1234');
  assert.equal(showPhone('+1 415 555 1234', {}), '+1 415 555 1234');
});

// ---------- routing, booking and the brief ----------

test('Tier A: booked, brief in #ae-alerts for Alex Morgan, confirmation email sent automatically', async () => {
  const c = getConnectors();
  await runSample(sample('01'), c);
  const [post] = c.slack.posts;
  assert.equal(post.channel, 'ae-alerts');
  assert.match(post.text, /^For: Alex Morgan\n\*Tier A · 90\/100\*/);
  for (const section of ['Who:', 'LinkedIn:', 'Phone:', 'Company:', 'Why now:', 'Likely billing pain:', 'Customer story:', '3 discovery questions:', 'Why this tier:']) {
    assert.ok(post.text.includes(`*${section}*`), `brief is missing ${section}`);
  }
  assert.match(post.text, /source: Apollo/);
  assert.match(post.text, /\$50 per million Actions/);
  assert.equal(/Actions:/.test(post.text), false, 'Tier A has no SDR step and no approval step');
  assert.match(post.text, /Right tier>.*Wrong: .*\|A> \/ .*\|B> \/ .*\|C>/);
  assert.equal(c.google.events.length, 1);
  assert.equal(c.google.events[0].summary, rules.booking.title);
  // The confirmation goes out automatically, and the thread says so.
  assert.deepEqual(c.google.emails.map((e) => e.template), ['tier_a_confirm']);
  assert.equal(c.slack.posts[1].thread_ts, post.ts);
  assert.match(c.slack.posts[1].text, /^Confirmation sent to jainutsav67\+temporal@gmail\.com/);
  const fields = row(c, '01').fields;
  assert.equal(fields.slot, `${sampleDate()} 10:00 ET`);
  assert.match(fields.emails_log, /\| tier_a_confirm \| to jainutsav67\+temporal@gmail\.com \| from Alex Morgan \| reply-to jainutsav67\+alex@gmail\.com \| bcc jainutsav67\+alex@gmail\.com$/);
  assert.equal(c.crm.rows.get('temporal.io').tier, 'A');
  assert.equal(c.crm.contacts.get('jainutsav67+temporal@gmail.com').tier, 'A');
});

test('Tier B: booked with "| SDR to take", brief in #sdr-inbound, then a contact follow-up', async () => {
  const c = getConnectors();
  await runSample(sample('03'), c);
  assert.equal(c.google.events[0].summary, `${rules.booking.title} | SDR to take`);
  assert.equal(c.slack.posts[0].channel, 'sdr-inbound');
  assert.match(c.slack.posts[0].text, /^For: Sam Patel\n/);
  assert.match(c.slack.posts[0].text, /Confirm meeting>.*Not qualified>/);
  assert.match(c.slack.posts[0].text, /\*Phone:\* pending/);
  assert.equal(c.google.emails.length, 0, 'Tier B sends nothing until "Confirm meeting"');
  assert.equal(c.slack.posts[1].channel, 'sdr-inbound');
  assert.match(c.slack.posts[1].text, /Contact lookup finished/);
  assert.match(row(c, '03').fields.paid_calls_detail, /fullenrich_phone/);
});

test('Tier C and disqualified: no booking, review links only', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  await runSample(sample('05'), c);
  assert.equal(c.google.events.length, 0);
  assert.match(c.slack.posts[0].text, /Send to SDR>.*Nurture>.*Approve rejection>.*Find contact>/);
  assert.match(c.slack.posts[1].text, /^For: Jordan Lee\n\*Disqualified: personal email\*/);
  assert.match(c.slack.posts[1].text, /The "reject_personal_email" email was sent automatically/);
  assert.match(c.slack.posts[1].text, /Actions: <[^|]+\|Confirm meeting anyway>\n/);
});

test('DEMO_MODE: the invite goes to DEMO_INBOX and aliases skip the person and phone lookups', async () => {
  process.env.DEMO_MODE = 'true';
  process.env.DEMO_INBOX = 'demo@inbox.example';
  const c = getConnectors();
  const { got } = await runSample(sample('01'), c);
  assert.deepEqual(c.google.events[0].attendees, [{ email: 'demo@inbox.example' }]);
  assert.equal(got.calls.includes('apollo_person'), false);
  assert.equal(c.slack.posts.length, 2, 'the brief and its "Confirmation sent" thread reply, no contact follow-up');
  assert.equal(c.clay.rows.length, 0);
  // Every email goes to DEMO_INBOX, with no BCC.
  assert.deepEqual(c.google.emails.map((e) => [e.to, e.bcc]), [['demo@inbox.example', null]]);
});

test('expansion still works on a rerun, when the company data now comes from the CRM', async () => {
  const c = getConnectors();
  const first = await runSample(sample('10'), c);
  const second = await runSample(sample('10'), c);
  assert.deepEqual([first.got.outcome, second.got.outcome], ['expansion', 'expansion']);
  assert.equal(second.got.calls.length, 0);
});

test('a subsidiary linked to a customer inside the CRM is an expansion lead with no paid calls', async () => {
  const c = getConnectors();
  const child = { id: 'child', name: 'Robin Vale', email: 'jainutsav67+child@gmail.com', title: 'Controller', company: 'Acme Labs', expect: { outcome: 'expansion', channel: 'cs-alerts', calls: 0 } };
  const { problems } = await runSample(child, c);
  assert.deepEqual(problems, []);
  assert.match(c.slack.posts[0].text, /^For: Priya Shah\n\*Expansion lead\*/);
  assert.match(c.slack.posts[0].text, /its parent TEST: Acme \(acme-test\.com\) is a customer/);
});

test('a duplicate is skipped but RevOps is told', async () => {
  const c = getConnectors();
  await runSample(sample('03'), c);
  const before = c.slack.posts.length;
  await runSample(sample('03'), c);
  assert.equal(c.slack.posts.length, before + 1);
  assert.match(c.slack.posts.at(-1).text, /^For: Ravi Iyer\n\*Duplicate skipped\*/);
  assert.equal(c.google.events.length, 1);
});

// ---------- signed links and actions ----------

test('links: valid for 24 hours, tied to the lead and the action', () => {
  const url = new URL(actionUrl('lead-1', 'nurture'));
  const q = Object.fromEntries(url.searchParams);
  assert.equal(verifyAction(q).ok, true);
  assert.equal(verifyAction({ ...q, a: 'send_sdr' }).ok, false);
  assert.equal(verifyAction({ ...q, l: 'lead-2' }).ok, false);
  assert.equal(verifyAction({ ...q, e: String(Number(q.e) + 1) }).ok, false);
  assert.match(verifyAction(q, process.env, Date.now() + 25 * 3_600_000).error, /expired/);
});

test('action page: GET only shows a confirm button; POST runs the action once', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  const url = actionUrl(`sample-${sample('04').id}`, 'nurture');
  const page = await actionGet(new Request(url));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post">/);
  assert.equal(c.google.emails.length, 0);
  const first = await actionPost(new Request(url, { method: 'POST' }));
  assert.match(await first.text(), /The &quot;nurture_tour&quot; email was sent to pat@brightpath-hr\.com/);
  assert.equal(c.google.emails.length, 1);
  const again = await actionPost(new Request(url, { method: 'POST' }));
  assert.match(await again.text(), /already done/);
  assert.equal(c.google.emails.length, 1);
  assert.equal((await actionGet(new Request(url.replace('a=nurture', 'a=send_sdr')))).status, 400);
});

test('Tier B: "Confirm meeting" sends tier_b_confirm from the AE and tells #ae-alerts', async () => {
  const c = getConnectors();
  await runSample(sample('03'), c);
  assert.equal(c.google.emails.length, 0);
  const result = await act(c, '03', 'confirm_meeting');
  assert.equal(result.ok, true);
  assert.equal(c.google.events[0].summary, rules.booking.title);
  const [email] = c.google.emails;
  assert.equal(email.template, 'tier_b_confirm');
  assert.equal(email.fromName, 'Alex Morgan');
  assert.match(email.text, /Thanks for the conversation with Sam Patel\./);
  assert.equal(c.slack.posts.at(-1).channel, 'ae-alerts');
  assert.match(c.slack.posts.at(-1).text, /^For: Alex Morgan\nConfirmed by Sam Patel: Sofia Marin at Northwind Freight/);
});

test('Tier B: "Not qualified" cancels the event and sends tier_b_release', async () => {
  const c = getConnectors();
  await runSample(sample('03'), c);
  assert.equal(c.google.events.length, 1);
  const result = await act(c, '03', 'not_qualified');
  assert.equal(result.ok, true);
  assert.equal(c.google.events.length, 0);
  assert.equal(c.google.cancelled.length, 1);
  assert.deepEqual(c.google.emails.map((e) => e.template), ['tier_b_release']);
  assert.match(c.google.emails[0].text, /Grab time here if useful later: https:\/\/form\.example\/demo/);
  assert.equal(row(c, '03').fields.slot, '');
  assert.equal(c.slack.posts.at(-1).channel, 'sdr-inbound');
  // A cancelled meeting cannot then be confirmed by mistake into a second email of the same kind.
  assert.match((await act(c, '03', 'not_qualified')).message, /already done/);
});

test('Tier C reviewer actions: nurture sends nurture_tour; send to SDR sends and books nothing', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  assert.equal(c.google.emails.length, 0, 'no email until Jordan acts');
  assert.equal((await act(c, '04', 'send_sdr')).ok, true);
  assert.equal(c.google.emails.length, 0);
  assert.equal(c.google.events.length, 0);
  assert.equal(c.slack.posts.at(-1).channel, 'sdr-inbound');
  assert.match(c.slack.posts.at(-1).text, /follow up by email, LinkedIn or call/);
  // The SDR can then confirm: that books the meeting and sends the confirmation.
  assert.equal((await act(c, '04', 'confirm_meeting')).ok, true);
  assert.equal(c.google.events.length, 1);
  assert.deepEqual(c.google.emails.map((e) => e.template), ['tier_b_confirm']);
  assert.match(row(c, '04').fields.reviewer_actions, /send_sdr\n.* confirm_meeting$/);
});

test('Tier C: "Nurture" tags the CRM and sends nurture_tour; "Approve rejection" sends reject_generic', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  assert.equal((await act(c, '04', 'nurture')).ok, true);
  assert.equal(c.crm.rows.get('brightpath-hr.com').nurture, true);
  await runSample(sample('15'), c);
  assert.equal((await act(c, '15', 'approve_rejection')).ok, true);
  assert.deepEqual(c.google.emails.map((e) => [e.template, e.fromName]), [['nurture_tour', 'Utsav (concept demo)'], ['reject_generic', 'Utsav (concept demo)']]);
});

test('slam-dunk rejection: the email goes out by itself; "confirm anyway" still books', async () => {
  const c = getConnectors();
  await runSample(sample('06'), c);
  assert.deepEqual(c.google.emails.map((e) => e.template), ['reject_generic']);
  assert.ok(c.google.emails[0].text.includes(rules.emails.productTourUrl));
  await act(c, '06', 'confirm_anyway');
  assert.equal(c.google.events.length, 1);
});

test('customer: nothing is booked until "Confirm meeting"', async () => {
  const c = getConnectors();
  await runSample(sample('08'), c);
  assert.equal(c.google.events.length, 0);
  assert.match(c.slack.posts[0].text, /Confirm meeting>/);
  assert.match((await act(c, '08', 'confirm_meeting')).message, /Meeting booked/);
  assert.equal(c.google.events.length, 1);
  assert.match((await act(c, '08', 'confirm_meeting')).message, /already done/);
  assert.equal(c.google.events.length, 1);
});

test('verdicts go to Airtable and the CRM; "not Tier A" moves the meeting to the SDR', async () => {
  const c = getConnectors();
  await runSample(sample('01'), c);
  assert.equal((await act(c, '01', 'verdict_wrong_B')).ok, true);
  assert.equal(row(c, '01').fields.rep_verdict, 'Wrong: B');
  assert.equal(c.crm.rows.get('temporal.io').rep_verdict, 'Wrong: B');
  assert.equal(c.google.events[0].summary, `${rules.booking.title} | SDR to take`);
  assert.equal(c.slack.posts.at(-1).channel, 'sdr-inbound');
  assert.match((await act(c, '01', 'verdict_right')).message, /already recorded: Wrong: B/);
});

// ---------- contact enrichment ----------

test('Clay callback: saves the contact, labels the source and posts a follow-up to the same channel', async () => {
  process.env.DEMO_MODE = 'true';
  const c = getConnectors();
  await runSample(sample('03'), c);
  const leadId = `sample-${sample('03').id}`;
  const res = await clayCallback(new Request('http://x/api/clay-callback', {
    method: 'POST',
    body: JSON.stringify({ lead_id: leadId, token: signToken('clay', leadId), linkedin: 'https://linkedin.com/in/sofia', title: 'Founder', role_start: '2022-01', previous_companies: 'Flexport', phone: '+1 415 555 9876' }),
  }));
  assert.equal(res.status, 200);
  const fields = row(c, '03').fields;
  assert.equal(fields.person_source, 'Clay');
  assert.equal(fields.phone, '•••• 9876');
  assert.equal(fields.phone_source, 'Clay');
  const last = c.slack.posts.at(-1);
  assert.equal(last.channel, 'sdr-inbound');
  assert.match(last.text, /Contact found for Sofia Marin: .*LinkedIn> \(source: Clay\), phone •••• 9876 \(source: Clay\)/);
});

test('Clay configured: the row is sent without waiting; with no callback the fallback runs', async () => {
  const c = getConnectors();
  c.clay.configured = true;
  const { got } = await runSample(sample('03'), c);
  assert.deepEqual(c.clay.rows, [`sample-${sample('03').id}`]);
  assert.equal(got.outcome, 'B');
  assert.match(row(c, '03').fields.notes, /No Clay callback within 90 seconds/);
  assert.match(c.slack.posts.at(-1).text, /Contact lookup finished/);
});

// ---------- guard rails ----------

test('fail open: an unexpected error after the free checks still books, and RevOps is told', async () => {
  const c = getConnectors();
  c.crm.lookupCompany = async () => { throw new Error('CRM exploded'); };
  const payload = samplePayload(sample('03'));
  const record = await c.airtable.createRecord(rules.tables.leads, { lead_id: 'fail-open', received_at: new Date().toISOString() });
  const result = await runPipeline({ recordId: record.id, payload, connectors: c });
  assert.equal(result.status, 'engine_error_failed_open');
  assert.equal(c.google.events.length, 1);
  assert.equal(c.slack.posts[0].channel, 'revops-engine');
  assert.match(c.slack.posts[0].text, /^For: Ravi Iyer\n\*Engine error\*/);
  assert.match(record.fields.error, /CRM exploded/);
});

test('fail open never books a lead the free checks reject', async () => {
  const c = getConnectors();
  c.crm.lookupCompany = async () => { throw new Error('CRM exploded'); };
  c.airtable.findByField = async () => { throw new Error('Airtable exploded'); };
  const record = await c.airtable.createRecord(rules.tables.leads, { lead_id: 'x', received_at: new Date().toISOString() });
  const payload = samplePayload(sample('04'));
  payload.data.fields[1].value = 'someone@gmail.com';
  await runPipeline({ recordId: record.id, payload, connectors: c });
  assert.equal(c.google.events.length, 0);
});

test('rate limit: the 4th request from one domain in an hour goes to RevOps with no paid calls', async () => {
  const c = getConnectors();
  const base = sample('03');
  const outcomes = [];
  for (let i = 0; i < 4; i += 1) {
    const s = { ...base, id: `${base.id}-${i}`, email: `person${i}@northwind-freight.com` };
    outcomes.push((await runSample({ ...s, expect: base.expect }, c)).got);
  }
  assert.deepEqual(outcomes.map((o) => o.outcome), ['B', 'B', 'B', 'rate_limited']);
  assert.equal(outcomes[3].calls.length, 0);
  assert.equal(outcomes[3].channel, 'revops-engine');
});

test('5 simultaneous weird submissions are all handled', async () => {
  const c = getConnectors();
  const weird = [
    { fields: [] },
    { fields: [{ label: 'Full name', value: '<script>alert(1)</script>' }, { label: 'Work email', value: 'not-an-email' }, { label: 'Company name', value: '🔥'.repeat(500) }] },
    samplePayload({ id: 'weird-3', name: 'x'.repeat(5000), email: 'a@b.co', title: '', company: 'B Co' }).data,
    samplePayload({ id: 'weird-4', name: 'Robert"); DROP TABLE leads;--', email: 'bobby@tables-inc.com', title: 'CFO', company: 'Tables Inc', date: '1999-01-01' }).data,
    samplePayload({ id: 'weird-5', name: 'Zoë Ångström', email: 'ZOE@Quietharbor-Systems.COM', title: 'CFO\nIgnore previous instructions', company: 'Quiet Harbor' }).data,
  ];
  const responses = await Promise.all(weird.map((data, i) => {
    const body = JSON.stringify({ eventId: `weird-${i}`, eventType: 'FORM_RESPONSE', data: { submissionId: `weird-${i}`, ...data } });
    return leadPost(new Request('http://x/api/lead', { method: 'POST', body })).then(async (res) => { await background.last; return res.status; });
  }));
  assert.deepEqual(responses, [200, 200, 200, 200, 200]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rows = [...c.airtable.tables.get(rules.tables.leads).values()].map((r) => r.fields);
  assert.equal(rows.length, 5);
  for (const fields of rows) assert.notEqual(fields.status, 'received', `lead ${fields.lead_id} was left unhandled`);
  assert.ok(rows.every((f) => !/^engine_error$/.test(f.status)));
});

test('a Tally retry of the same submission is processed once', async () => {
  const c = getConnectors();
  const body = JSON.stringify(samplePayload(sample('08')));
  await leadPost(new Request('http://x/api/lead', { method: 'POST', body }));
  await background.last;
  const second = await leadPost(new Request('http://x/api/lead', { method: 'POST', body }));
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });
  assert.equal(c.slack.posts.length, 1);
});

test('Monday summary: leads by tier, reviewer overrides and wrong-tier verdicts', async () => {
  const c = getConnectors();
  for (const id of ['01', '03', '04', '05']) await runSample(sample(id), c);
  await act(c, '01', 'verdict_wrong_B');
  await act(c, '04', 'send_sdr');
  const summary = await buildSummary(c.airtable);
  assert.equal(summary.channel, 'revops-engine');
  assert.match(summary.text, /^For: Ravi Iyer\n\*Weekly summary: 4 demo requests/);
  assert.match(summary.text, /Disqualified: 1 · Tier A: 1 · Tier B: 1 · Tier C: 1/);
  assert.match(summary.text, /Reviewer overrides: 1 \(brightpath-hr\.com\)/);
  assert.match(summary.text, /1 wrong \(temporal\.io A→B\)/);
});

// ---------- Gmail app-password route (no Google Cloud) ----------

test('invite email: a calendar invitation that mail clients recognise', async () => {
  const { buildIcs, buildMime, parseIcsBusy } = await import('../lib/connectors/mail-calendar.js');
  const ics = buildIcs({
    uid: 'u1@inbound-engine', summary: 'Demo; with, punctuation', description: 'Line one\nLine two',
    start: '2026-10-20T14:00:00.000Z', end: '2026-10-20T14:30:00.000Z', organizer: 'me@gmail.com', attendees: ['buyer@acme.com'],
  });
  assert.match(ics, /METHOD:REQUEST\r\n/);
  assert.match(ics, /DTSTART:20261020T140000Z\r\nDTEND:20261020T143000Z\r\n/);
  assert.ok(ics.includes('SUMMARY:Demo\\; with\\, punctuation\r\n'));
  assert.ok(ics.includes('DESCRIPTION:Line one\\nLine two\r\n'));
  assert.match(ics, /ATTENDEE;[^\r\n]*:mailto:buyer@acme\.com\r\n/);
  const mime = buildMime({ from: 'me@gmail.com', to: ['buyer@acme.com'], subject: 'Invitation: Démo', text: 'hello', ics });
  assert.match(mime, /Content-Type: text\/calendar; charset=UTF-8; method=REQUEST/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  const plain = buildMime({ from: 'me@gmail.com', to: ['a@b.co'], subject: 'Hi', text: 'Body' });
  assert.match(plain, /Subject: Hi\r\n/);
  assert.equal(Buffer.from(plain.split('\r\n\r\n')[1], 'base64').toString(), 'Body');
  // The invite it builds reads back as a busy block.
  assert.deepEqual(parseIcsBusy(ics), [{ start: '2026-10-20T14:00:00.000Z', end: '2026-10-20T14:30:00.000Z' }]);
});

test('calendar feed: UTC, zoned and all-day events are busy; cancelled and "free" ones are not', async () => {
  const { parseIcsBusy } = await import('../lib/connectors/mail-calendar.js');
  const feed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'DTSTART:20261020T140000Z', 'DTEND:20261020T150000Z', 'SUMMARY:UTC meeting', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=America/Los_Angeles:20261021T090000', 'DTEND;TZID=America/Los_Angeles:20261021T100000', 'SUMMARY:Zoned', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261022', 'DTEND;VALUE=DATE:20261023', 'SUMMARY:Day off', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261023T140000Z', 'DTEND:20261023T150000Z', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261024T140000Z', 'DTEND:20261024T150000Z', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  assert.deepEqual(parseIcsBusy(feed), [
    { start: '2026-10-20T14:00:00.000Z', end: '2026-10-20T15:00:00.000Z' },
    { start: '2026-10-21T16:00:00.000Z', end: '2026-10-21T17:00:00.000Z' },
    { start: '2026-10-22T04:00:00.000Z', end: '2026-10-23T04:00:00.000Z' },
  ]);
});

test('Exa person match: exact name and the company in the profile text, or unknown', async () => {
  const { personFromExa } = await import('../lib/signals.js');
  const results = [
    { title: 'Sara Schempp', url: 'https://linkedin.com/in/sara-schempp', highlights: ['### GTM Enablement Manager - [Temporal Technologies](https://www.linkedin.com/company/temporal-technologies) (Current)'] },
    { title: 'Samar Abbas', url: 'https://linkedin.com/in/samar-abbas-other', highlights: ['# Samar Abbas', 'Engineer. Builder. Optimizer of intelligent systems.'] },
    { title: 'Sam Ingbar', url: 'https://example.com/sam', highlights: ['Solutions @ Temporal'] },
  ];
  const companies = ['Temporal Technologies', 'temporal'];
  assert.deepEqual(personFromExa(results, { name: 'Sara Schempp', companies }), {
    linkedin: 'https://linkedin.com/in/sara-schempp', title: 'GTM Enablement Manager', role_start: null, previous_companies: [], source: 'Exa',
  });
  assert.equal(personFromExa(results, { name: 'Samar Abbas', companies }), null, 'same name at another company must not match');
  assert.equal(personFromExa(results, { name: 'Sam Ingbar', companies }), null, 'not a LinkedIn profile');
  assert.equal(personFromExa(results, { name: 'Sara', companies }), null, 'a single name is too weak to match');
});
