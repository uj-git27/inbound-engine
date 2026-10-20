import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { samples, runSample } from '../lib/samples.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { runAction } from '../lib/actions.js';
import { buildEmail, sendTemplate } from '../lib/emails.js';
import { sweep } from '../lib/sweep.js';
import { alertBlocks, tierAlert } from '../lib/alerts.js';
import { verifyAction } from '../lib/links.js';
import { buildRawEmail } from '../lib/connectors/google.js';
import { POST as slackClick, verifySlackSignature } from '../api/slack-actions.js';
import { background } from '../lib/background.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };
const sample = (id) => samples.find((s) => s.id.startsWith(id));
const leadIdOf = (s) => `sample-${s.id}`;
const row = (c, s) => [...c.airtable.tables.get(rules.tables.leads).values()].find((r) => r.fields.lead_id === leadIdOf(s));
const sent = (c) => c.google.emails.map((e) => e.template);
const HOUR = 3_600_000;

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

// ---------- which template each lead type gets ----------

const custom = (id, fields, expect) => ({ id, name: 'Robin Vale', company: 'Realco', title: 'CFO', email: 'robin@realco-systems.com', ...fields, expect });
const DQ = { outcome: 'DQ', channel: 'inbound-review' };
const cases = [
  ['Tier A', sample('01'), ['tier_a_confirm']],
  ['Tier B (nothing until "Confirm meeting")', sample('03'), []],
  ['Tier C (nothing until the reviewer acts)', sample('04'), []],
  ['personal email (nothing until the reviewer acts)', sample('05'), []],
  ['throwaway email', custom('throwaway', { email: 'x@mailinator.com' }, DQ), []],
  ['competitor employee', sample('06'), []],
  ['student', custom('student', { title: 'Student' }, DQ), []],
  ['fake name, real address', custom('fake', { name: 'asdf asdf' }, DQ), []],
  ['fake data with an address that cannot receive mail', sample('07'), []],
  ['recruiter', custom('recruiter', { title: 'Technical Recruiter' }, DQ), []],
  ['consultant', custom('consultant', { title: 'Billing Consultant' }, DQ), []],
  ['investor', custom('investor', { title: 'Investor' }, DQ), []],
  ['press', custom('press', { title: 'Reporter' }, DQ), []],
  ['rejection based on looked-up data (too small)', sample('12'), []],
  ['rejection based on looked-up data (region)', sample('13'), []],
  ['existing customer', sample('08'), []],
  ['open deal', sample('09'), []],
  ['expansion', sample('10'), []],
];
for (const [name, lead, templates] of cases) {
  test(`email on arrival, ${name}: ${templates.join(', ') || 'none'}`, async () => {
    const c = getConnectors();
    const { problems } = await runSample(lead, c);
    assert.deepEqual(problems, []);
    assert.deepEqual(sent(c), templates);
    assert.equal(String(row(c, lead).fields.emails_log ?? '').split('\n').filter(Boolean).length, templates.length, 'every send is logged in Airtable');
  });
}

test('a duplicate within 30 days gets no email', async () => {
  const c = getConnectors();
  await runSample(sample('05'), c);
  const dup = { ...sample('03'), id: 'dup' };
  await runSample(sample('03'), c);
  await runSample({ ...dup, expect: { outcome: 'duplicate', channel: 'revops-engine' } }, c);
  assert.deepEqual(sent(c), []);
});

test('"Approve rejection" sends the template that fits why the lead was rejected', async () => {
  const c = getConnectors();
  const ids = [
    [sample('05'), 'reject_personal_email'], // personal email
    [custom('recruiter', { title: 'Technical Recruiter' }, DQ), 'reject_vendor'],
    [custom('investor', { title: 'Investor' }, DQ), 'not_a_buyer'],
    [custom('student', { title: 'Student' }, DQ), 'reject_generic'],
  ];
  for (const [lead] of ids) await runSample(lead, c);
  assert.deepEqual(sent(c), [], 'nothing goes out before a person acts');
  for (const [lead] of ids) assert.equal((await runAction({ leadId: leadIdOf(lead), action: 'approve_rejection', connectors: c })).ok, true);
  assert.deepEqual(sent(c), ids.map(([, template]) => template));
});

// ---------- sender, reply-to, BCC, footer ----------

test('sender display name, reply-to and BCC are right for every template', () => {
  const lead = { name: 'Dana Reyes', email: 'dana@acme.com' };
  const expected = {
    tier_a_confirm: ['Alex Morgan', 'jainutsav67+alex@gmail.com', 'jainutsav67+alex@gmail.com'],
    ae_intro: ['Alex Morgan', 'jainutsav67+alex@gmail.com', 'jainutsav67+alex@gmail.com'],
    tier_b_confirm: ['Alex Morgan', 'jainutsav67+alex@gmail.com', 'jainutsav67+alex@gmail.com'],
    tier_b_release: ['Alex Morgan', 'jainutsav67+alex@gmail.com', 'jainutsav67+alex@gmail.com'],
    reject_personal_email: ['Utsav (Acme concept demo)', 'jainutsav67@gmail.com', null],
    reject_generic: ['Utsav (Acme concept demo)', 'jainutsav67@gmail.com', null],
    reject_vendor: ['Utsav (Acme concept demo)', 'jainutsav67@gmail.com', null],
    not_a_buyer: ['Utsav (Acme concept demo)', 'jainutsav67@gmail.com', null],
    nurture_tour: ['Utsav (Acme concept demo)', 'jainutsav67@gmail.com', null],
  };
  assert.deepEqual(Object.keys(rules.emails.templates).sort(), Object.keys(expected).sort());
  for (const [template, [fromName, replyTo, bcc]] of Object.entries(expected)) {
    const email = buildEmail(template, { lead, outcome: {}, booking: { buyerLocal: 'Tue, Oct 20, 10:00 AM EDT' }, env: {} });
    assert.deepEqual([email.fromName, email.replyTo, email.bcc, email.to], [fromName, replyTo, bcc, 'dana@acme.com'], template);
    assert.ok(email.text.endsWith(rules.emails.footer), `${template} ends with the footer`);
    assert.equal(/\{\w+\}/.test(email.subject + email.text), false, `${template} has no unfilled placeholder`);
    const t = rules.emails.templates[template];
    assert.deepEqual([t.approved_by, /^\d{4}-\d{2}-\d{2}$/.test(t.approved_at)], ['Utsav', true], `${template} is approved`);
  }
});

test('template content: sourced line only when there is one; vendor email has no tour link', () => {
  const lead = { name: 'Dana Reyes', email: 'dana@acme.com' };
  const booking = { buyerLocal: 'Tue, Oct 20, 7:00 AM PDT' };
  // Tier A goes out automatically, so it is generic: no signal, no discovery questions.
  const auto = buildEmail('tier_a_confirm', { lead, booking, env: {}, outcome: { signals: [{ type: 'funding', date: '2026-09-01' }], pricing: { model: 'usage' } } });
  assert.equal(/Congrats|usage data/.test(auto.text), false);
  assert.match(auto.text, /Here is what we'll cover on the call:\n1\. How you bill today/);
  assert.match(auto.text, /calendar invite has already been sent/);
  const withSignal = buildEmail('tier_b_confirm', { lead, booking, env: {}, outcome: { signals: [{ type: 'funding', date: '2026-09-01' }], pricing: { model: 'usage' } } });
  assert.equal(withSignal.subject, 'Your Acme demo on Tue, Oct 20, 7:00 AM PDT');
  assert.match(withSignal.text, /Congrats on the funding round announced 2026-09-01\./);
  assert.match(withSignal.text, /1\. How do you get usage data into an invoice today/);
  assert.ok(withSignal.text.includes(rules.emails.productTourUrl));
  assert.match(withSignal.text, /calendar invite has already been sent/);
  const without = buildEmail('tier_b_confirm', { lead, booking, env: {}, outcome: { signals: [{ type: 'ipo_prep', date: '2026-09-01' }] } });
  assert.equal(/Congrats/.test(without.text), false);
  assert.equal(/\n\n\n/.test(without.text), false, 'no empty gap where the line would have been');
  assert.equal(buildEmail('reject_vendor', { lead, env: {} }).text.includes(rules.emails.productTourUrl), false);
  assert.match(buildEmail('reject_personal_email', { lead, env: { TALLY_FORM_URL: 'https://form.example/demo' } }).text, /rebook with your work email so we can prepare properly: https:\/\/form\.example\/demo/);
  assert.match(buildEmail('not_a_buyer', { lead, env: {} }).text, /For partnerships or press, reply to this email/);
});

test('DEMO_MODE: every email goes to DEMO_INBOX and the log says who it was meant for', async () => {
  const state = {};
  const google = { emails: [], async sendEmail(e) { this.emails.push(e); } };
  const env = { DEMO_MODE: 'true', DEMO_INBOX: 'demo@inbox.example' };
  const result = await sendTemplate('reject_generic', { lead: { name: 'A B', email: 'a@acme.com' }, state, google, env });
  assert.deepEqual([google.emails[0].to, google.emails[0].bcc], ['demo@inbox.example', null]);
  assert.match(result.line, /\| reject_generic \| to demo@inbox\.example \(demo mode; lead is a@acme\.com\) \| from Utsav \(Acme concept demo\) \| reply-to jainutsav67@gmail\.com$/);
});

test('the Gmail message carries the display name, reply-to and BCC', () => {
  const raw = Buffer.from(buildRawEmail({ to: 'a@b.co', subject: 'Hi', text: 'Body', fromName: 'Alex Morgan', fromAddress: 'me@gmail.com', replyTo: 'alex@x.co', bcc: 'ae@x.co' }), 'base64url').toString();
  assert.match(raw, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <me@gmail\.com>\r\nTo: a@b\.co\r\nReply-To: alex@x\.co\r\nBcc: ae@x\.co\r\n/);
  assert.equal(Buffer.from(/From: =\?UTF-8\?B\?([^?]+)\?=/.exec(raw)[1], 'base64').toString(), 'Alex Morgan');
});

// ---------- never the same template twice ----------

test('no template is ever sent twice to the same lead', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  const id = leadIdOf(sample('04'));
  await runAction({ leadId: id, action: 'nurture', connectors: c });
  await runAction({ leadId: id, action: 'nurture', connectors: c });
  // A later timer run must not send it again either.
  await sweep({ connectors: c, now: Date.now() + 10 * HOUR });
  // Nor a rejection approved twice.
  await runSample(sample('06'), c);
  await runAction({ leadId: leadIdOf(sample('06')), action: 'approve_rejection', connectors: c });
  const second = await runAction({ leadId: leadIdOf(sample('06')), action: 'approve_rejection', connectors: c });
  assert.match(second.message, /"Approve rejection" was already done. Nothing was repeated/);
  assert.deepEqual(sent(c), ['nurture_tour', 'reject_generic']);
});

// ---------- timers ----------

test('untouched Tier C defaults to nurture after 4 hours, not before, and only once', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  assert.deepEqual(await sweep({ connectors: c, now: Date.now() + 3 * HOUR }), { booked: 0, reminders: 0, released: 0, nurtured: 0, errors: [] });
  assert.deepEqual(sent(c), []);
  assert.equal((await sweep({ connectors: c, now: Date.now() + 4.1 * HOUR })).nurtured, 1);
  assert.deepEqual(sent(c), ['nurture_tour']);
  assert.equal(c.crm.rows.get('brightpath-hr.com').nurture, true);
  assert.match(row(c, sample('04')).fields.reviewer_actions, / nurture \(automatic\)$/);
  assert.match(c.slack.posts.at(-1).text, /^For: Jordan Lee\nUntouched for 4 hours, so it moved to nurture automatically/);
  assert.equal((await sweep({ connectors: c, now: Date.now() + 9 * HOUR })).nurtured, 0);
  assert.deepEqual(sent(c), ['nurture_tour']);
});

test('a rejection based on looked-up data also defaults to nurture after 4 hours; a touched lead does not', async () => {
  const c = getConnectors();
  await runSample(sample('12'), c);
  await runSample(sample('15'), c);
  await runAction({ leadId: leadIdOf(sample('15')), action: 'send_sdr', connectors: c });
  const result = await sweep({ connectors: c, now: Date.now() + 5 * HOUR });
  assert.equal(result.nurtured, 1);
  assert.deepEqual(c.google.emails.map((e) => [e.template, e.intendedFor]), [['nurture_tour', 'sam@tinyco-labs.com']]);
});

test('a rejection from the free checks also defaults to nurture after 4 hours, and not before', async () => {
  const c = getConnectors();
  await runSample(sample('05'), c);
  assert.equal((await sweep({ connectors: c, now: Date.now() + 3 * HOUR })).nurtured, 0);
  assert.deepEqual(sent(c), []);
  assert.equal((await sweep({ connectors: c, now: Date.now() + 5 * HOUR })).nurtured, 1);
  assert.deepEqual(sent(c), ['nurture_tour']);
});

test('Tier B: reminder 24 hours before, automatic release 4 hours before', async () => {
  const c = getConnectors();
  await runSample(sample('03'), c);
  const record = row(c, sample('03'));
  const state = JSON.parse(record.fields.state_json);
  const start = Date.parse(state.booking.start);
  const bookedAt = (hoursBefore) => {
    state.booking.bookedAt = new Date(start - hoursBefore * HOUR).toISOString();
    return c.airtable.updateRecord(rules.tables.leads, record.id, { state_json: JSON.stringify(state) });
  };
  // Booked at short notice (inside the 4-hour window): the timers leave the meeting alone.
  await bookedAt(3);
  assert.deepEqual(await sweep({ connectors: c, now: start - 2 * HOUR }), { booked: 0, reminders: 0, released: 0, nurtured: 0, errors: [] });
  assert.equal(c.google.events.length, 1);

  // Booked well ahead: reminder, then release.
  await bookedAt(48);
  assert.deepEqual(await sweep({ connectors: c, now: start - 30 * HOUR }), { booked: 0, reminders: 0, released: 0, nurtured: 0, errors: [] });

  assert.equal((await sweep({ connectors: c, now: start - 23 * HOUR })).reminders, 1);
  assert.equal(c.slack.posts.at(-1).channel, 'sdr-inbound');
  assert.match(c.slack.posts.at(-1).text, /^For: Sam Patel\nReminder: Sofia Marin at Northwind Freight is booked for .* and is not confirmed yet/);
  assert.equal((await sweep({ connectors: c, now: start - 20 * HOUR })).reminders, 0, 'the reminder is sent once');
  assert.deepEqual(sent(c), []);

  assert.equal((await sweep({ connectors: c, now: start - 3.5 * HOUR })).released, 1);
  assert.deepEqual(sent(c), ['tier_b_release']);
  assert.equal(c.google.events.length, 0, 'the event is cancelled');
  assert.match(c.slack.posts.at(-1).text, /^For: Sam Patel\nNot confirmed 4 hours before the meeting, so it was released automatically/);
  assert.equal((await sweep({ connectors: c, now: start - 1 * HOUR })).released, 0);
});

test('Tier B confirmed in time is neither reminded nor released', async () => {
  const c = getConnectors();
  await runSample(sample('03'), c);
  await runAction({ leadId: leadIdOf(sample('03')), action: 'confirm_meeting', connectors: c });
  const start = Date.parse(JSON.parse(row(c, sample('03')).fields.state_json).booking.start);
  assert.deepEqual(await sweep({ connectors: c, now: start - 2 * HOUR }), { booked: 0, reminders: 0, released: 0, nurtured: 0, errors: [] });
  assert.deepEqual(sent(c), ['tier_b_confirm']);
  assert.equal(c.google.events.length, 1);
});

// ---------- Slack buttons ----------

const slackRequest = (payload, secret, { ts = Math.floor(Date.now() / 1000), tamper = false } = {}) => {
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
  return new Request('http://x/api/slack-actions', { method: 'POST', body: tamper ? `${raw}&x=1` : raw, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': signature } });
};

test('Slack buttons: each alert carries its actions and the verdict as buttons with a confirm step', async () => {
  process.env.SLACK_SIGNING_SECRET = 'slack-secret';
  const c = getConnectors();
  await runSample(sample('03'), c);
  const post = c.slack.posts[0];
  assert.equal(/api\/action\?/.test(post.text), false, 'no raw links when buttons are on');
  const [actions, verdict] = post.blocks.filter((b) => b.type === 'actions');
  assert.deepEqual(actions.elements.map((b) => b.text.text), ['Confirm meeting', 'Not qualified']);
  assert.deepEqual(verdict.elements.map((b) => b.text.text), ['Right tier', 'Wrong: A', 'Wrong: B', 'Wrong: C']);
  for (const b of [...actions.elements, ...verdict.elements]) {
    assert.ok(b.confirm.text.text.length > 10);
    assert.equal(verifyAction(JSON.parse(b.value)).ok, true);
  }
  assert.ok(post.blocks.filter((b) => b.type === 'section').every((b) => b.text.text.length <= 3000));
});

test('Slack buttons: a very long brief is split into blocks Slack accepts', () => {
  const lead = { lead_id: 'x', name: 'N'.repeat(300), title: 'CFO', company: 'C'.repeat(300), domain: 'c.com' };
  const outcome = { tier: 'C', score: 3, flags: ['f'.repeat(2950), 'g'.repeat(4000)], breakdown: {}, profile: null, signals: [] };
  const blocks = alertBlocks(tierAlert({ lead, outcome, env: process.env }));
  assert.ok(blocks.filter((b) => b.type === 'section').length > 1);
  assert.ok(blocks.every((b) => b.type !== 'section' || b.text.text.length <= 3000));
});

test('Slack buttons: a signed click runs the action once and reports in the thread', async () => {
  process.env.SLACK_SIGNING_SECRET = 'slack-secret';
  const c = getConnectors();
  await runSample(sample('03'), c);
  const post = c.slack.posts[0];
  const button = post.blocks.find((b) => b.type === 'actions').elements[0];
  const payload = { type: 'block_actions', user: { name: 'sam' }, channel: { id: 'C123' }, message: { ts: post.ts }, actions: [button] };

  const res = await slackClick(slackRequest(payload, 'slack-secret'));
  assert.equal(res.status, 200);
  await background.last;
  assert.deepEqual(sent(c), ['tier_b_confirm']);
  const reply = c.slack.posts.at(-1);
  assert.equal(reply.thread_ts, post.ts);
  assert.match(reply.text, /^:white_check_mark: \*Confirm meeting\* \(clicked by sam\): Confirmed for /);

  await slackClick(slackRequest(payload, 'slack-secret'));
  await background.last;
  assert.deepEqual(sent(c), ['tier_b_confirm'], 'a second click repeats nothing');
  assert.match(c.slack.posts.at(-1).text, /already done/);
});

test('Slack buttons: bad signature, tampered body and replayed requests are refused', async () => {
  process.env.SLACK_SIGNING_SECRET = 'slack-secret';
  const c = getConnectors();
  await runSample(sample('03'), c);
  const button = c.slack.posts[0].blocks.find((b) => b.type === 'actions').elements[0];
  const payload = { type: 'block_actions', user: { name: 'sam' }, channel: { id: 'C123' }, message: { ts: '1' }, actions: [button] };
  assert.equal((await slackClick(slackRequest(payload, 'wrong-secret'))).status, 401);
  assert.equal((await slackClick(slackRequest(payload, 'slack-secret', { tamper: true }))).status, 401);
  assert.equal((await slackClick(slackRequest(payload, 'slack-secret', { ts: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
  assert.equal(verifySlackSignature('body', '1', 'v0=x', ''), false);
  assert.deepEqual(sent(c), []);

  // A validly signed request whose button value was altered runs nothing.
  const forged = { ...payload, actions: [{ ...button, value: JSON.stringify({ ...JSON.parse(button.value), a: 'not_qualified' }) }] };
  await slackClick(slackRequest(forged, 'slack-secret'));
  await background.last;
  assert.equal(c.google.events.length, 1, 'the meeting is still there');
  assert.match(c.slack.posts.at(-1).text, /^:warning:/);
});
