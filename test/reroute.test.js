import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { samples, runSample } from '../lib/samples.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { runAction } from '../lib/actions.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };
const sample = (id) => samples.find((s) => s.id.startsWith(id));
const act = (c, id, action) => runAction({ leadId: `sample-${sample(id).id}`, action, connectors: c });
const row = (c, id) => [...c.airtable.tables.get(rules.tables.leads).values()].find((r) => r.fields.lead_id === `sample-${sample(id).id}`).fields;
const sent = (c) => c.google.emails.map((e) => e.template);
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
  process.env = { ...saved };
});

test('customer, open-deal and expansion alerts have no tier verdict, only their own action', async () => {
  const c = getConnectors();
  for (const id of ['08', '09', '10']) await runSample(sample(id), c);
  assert.deepEqual(c.slack.posts.map(buttons), [['Confirm meeting'], ['Confirm meeting'], ['Confirm meeting']]);
  assert.equal(c.slack.posts.some((p) => /Right tier|Wrong:/.test(p.text)), false);
});

test('tier and disqualified alerts carry the verdict buttons', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  await runSample(sample('12'), c);
  for (const post of c.slack.posts) assert.deepEqual(buttons(post).slice(-4), ['Right tier', 'Wrong: A', 'Wrong: B', 'Wrong: C']);
});

test('Tier C marked "Wrong: A" goes to the AE: booked, confirmation sent, brief in #ae-alerts', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  assert.equal(c.google.events.length, 0);
  const result = await act(c, '04', 'verdict_wrong_A');
  assert.equal(result.ok, true);
  assert.match(result.message, /^Recorded: Wrong: A\. Moved to Alex Morgan in #ae-alerts\. Meeting booked for /);
  assert.equal(c.google.events.length, 1);
  assert.equal(c.google.events[0].summary, rules.booking.title);
  assert.deepEqual(sent(c), ['tier_a_confirm']);
  const post = c.slack.posts.at(-2);
  assert.equal(post.channel, 'ae-alerts');
  assert.match(post.text, /^For: Alex Morgan\n\*Tier C · 16\/100\* · now handled as Tier A\n/);
  assert.match(post.text, /Moved to Tier A by Jordan Lee/);
  assert.deepEqual(buttons(post), [], 'the verdict is already given, so the moved alert has no verdict buttons');
  // The AE also gets the optional intro email to review, in the new alert's thread.
  const draft = c.slack.posts.at(-1);
  assert.equal(draft.thread_ts, post.ts);
  assert.deepEqual(buttons(draft), ['Send intro email']);
  assert.deepEqual([row(c, '04').rep_verdict, row(c, '04').route, row(c, '04').owner], ['Wrong: A', '#ae-alerts', 'Alex Morgan']);
  // One verdict per lead: a second click changes nothing.
  assert.match((await act(c, '04', 'verdict_wrong_B')).message, /already recorded: Wrong: A/);
  assert.equal(c.google.events.length, 1);
});

test('Tier C marked "Wrong: B" goes to the SDR: booked for the SDR, no email until confirmed', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  const result = await act(c, '04', 'verdict_wrong_B');
  assert.match(result.message, /Moved to Sam Patel in #sdr-inbound\. Meeting booked for /);
  assert.equal(c.google.events[0].summary, `${rules.booking.title} | SDR to take`);
  assert.deepEqual(sent(c), []);
  const post = c.slack.posts.at(-1);
  assert.equal(post.channel, 'sdr-inbound');
  assert.deepEqual(buttons(post), ['Confirm meeting', 'Not qualified']);
  // The SDR's buttons then work as for any Tier B lead.
  await act(c, '04', 'confirm_meeting');
  assert.deepEqual(sent(c), ['tier_b_confirm']);
});

test('Tier A marked "Wrong: B" moves the meeting to the SDR', async () => {
  const c = getConnectors();
  await runSample(sample('01'), c);
  const result = await act(c, '01', 'verdict_wrong_B');
  assert.match(result.message, /Moved to Sam Patel in #sdr-inbound\. Meeting kept for /);
  assert.equal(c.google.events.length, 1);
  assert.equal(c.google.events[0].summary, `${rules.booking.title} | SDR to take`);
  assert.equal(c.slack.posts.at(-1).channel, 'sdr-inbound');
});

test('Tier A marked "Wrong: C" goes to review; nurture there cancels the meeting', async () => {
  const c = getConnectors();
  await runSample(sample('01'), c);
  await act(c, '01', 'verdict_wrong_C');
  const post = c.slack.posts.at(-1);
  assert.equal(post.channel, 'inbound-review');
  assert.match(post.text, /A meeting is still booked for .*: "Nurture" or "Approve rejection" cancels it/);
  assert.deepEqual(buttons(post), ['Send to SDR', 'Nurture', 'Approve rejection', 'Find contact']);
  assert.equal(c.google.events.length, 1);
  const result = await act(c, '01', 'nurture');
  assert.match(result.message, /The meeting on .* was cancelled\.$/);
  assert.equal(c.google.events.length, 0);
  assert.deepEqual(sent(c), ['tier_a_confirm', 'nurture_tour']);
  assert.equal(row(c, '01').slot, '');
});

test('a disqualified lead marked "Wrong: A" is rescued to the AE', async () => {
  const c = getConnectors();
  await runSample(sample('12'), c);
  const result = await act(c, '12', 'verdict_wrong_A');
  assert.equal(result.ok, true);
  const post = c.slack.posts.at(-2);
  assert.equal(post.channel, 'ae-alerts');
  assert.match(post.text, /^For: Alex Morgan\n\*Not scored \(the engine disqualified it: headcount out of range\)\* · now handled as Tier A\n/);
  assert.match(post.text, /\*Why this tier:\* not scored\. The engine's reason: Headcount 40 is outside 200 to 2000/);
  assert.equal(c.google.events.length, 1);
  assert.deepEqual(sent(c), ['tier_a_confirm']);
});

test('general alias: you+<company domain>@gmail.com stands in for that company', async () => {
  const { aliasDomain } = await import('../lib/pipeline.js');
  assert.equal(aliasDomain('jainutsav67+newrelic.com@gmail.com'), 'newrelic.com');
  assert.equal(aliasDomain('jainutsav67+launchdarkly.com@gmail.com'), 'launchdarkly.com');
  assert.equal(aliasDomain('jainutsav67+newrelic@gmail.com'), null, 'needs a full domain');
  assert.equal(aliasDomain('someoneelse+newrelic.com@gmail.com'), null, 'only the configured mailbox');
  assert.equal(aliasDomain('jainutsav67@gmail.com'), null);
  const c = getConnectors();
  const lead = { id: 'general-alias', name: 'Morgan Blake', email: 'jainutsav67+launchdarkly.com@gmail.com', title: 'Head of Revenue Operations', company: 'LaunchDarkly', expect: { outcome: 'A', channel: 'ae-alerts' } };
  const { problems } = await runSample(lead, c);
  assert.deepEqual(problems, []);
  assert.match(c.slack.posts[0].text, /`DEMO`/);
});

test('"Right tier" only records the verdict and moves nothing', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  const before = c.slack.posts.length;
  assert.equal((await act(c, '04', 'verdict_right')).message, 'Recorded: Right tier.');
  assert.equal(c.slack.posts.length, before);
  assert.equal(c.google.events.length, 0);
  assert.equal(row(c, '04').route, '#inbound-review');
});

test('choosing the tier the lead already has moves nothing', async () => {
  const c = getConnectors();
  await runSample(sample('04'), c);
  const before = c.slack.posts.length;
  assert.equal((await act(c, '04', 'verdict_wrong_C')).message, 'Recorded: Wrong: C.');
  assert.equal(c.slack.posts.length, before);
});
