import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { samples, samplePayload, runSample } from '../lib/samples.js';
import { getConnectors, resetMocks } from '../lib/connectors/index.js';
import { runPipeline } from '../lib/pipeline.js';
import { slotsFor, pickSlot } from '../lib/slots.js';
import { finalizeBooking } from '../lib/booking-flow.js';
import { sweep } from '../lib/sweep.js';
import { slotGrid, zonedToUtc, zonedDate, book } from '../lib/booking.js';
import { applySelfReported, profileFromApollo, gate } from '../lib/profile.js';
import { GET as slotsGet } from '../api/slots.js';
import { POST as slotPost } from '../api/slot.js';
import { GET as bookPage } from '../api/book.js';
import { GET as sweepGet } from '../api/sweep.js';
import { signToken } from '../lib/token.js';
import { rules } from '../lib/rules.js';

const saved = { ...process.env };
const sample = (id) => samples.find((s) => s.id.startsWith(id));
const sidOf = (id) => `sample-${sample(id).id}`;
const row = (c, id) => [...c.airtable.tables.get(rules.tables.leads).values()].find((r) => r.fields.lead_id === sidOf(id)).fields;
const sent = (c) => c.google.emails.map((e) => e.template);
const MIN = 60_000;
const HOUR = 60 * MIN;
// Mark a slot as taken on the AE's calendar.
const take = (c, iso) => c.google.busy.push({ start: iso, end: new Date(Date.parse(iso) + 30 * MIN).toISOString() });
// The webhook arriving and scoring finishing, without anyone on the booking page.
async function qualify(c, id) {
  const payload = samplePayload(sample(id));
  const record = await c.airtable.createRecord(rules.tables.leads, { lead_id: payload.data.submissionId, status: 'received', received_at: new Date().toISOString(), raw_payload: JSON.stringify(payload) });
  return runPipeline({ recordId: record.id, payload, connectors: c });
}
const post = (body) => slotPost(new Request('http://x/api/slot', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  process.env.DRY_RUN = 'true';
  process.env.BASE_URL = 'https://engine.example';
  process.env.TALLY_FORM_URL = 'https://form.example/demo';
  delete process.env.TALLY_SIGNING_SECRET;
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.DEMO_MODE;
  delete process.env.AE_TZ;
  resetMocks();
});
afterEach(() => {
  process.env = { ...saved };
});

// ---------- the slot grid ----------

test('grid: daylight saving is handled when converting the AE time zone to UTC', () => {
  assert.equal(new Date(zonedToUtc('2026-10-20', '10:00', 'America/New_York')).toISOString(), '2026-10-20T14:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-12-01', '10:00', 'America/New_York')).toISOString(), '2026-12-01T15:00:00.000Z');
});

test('grid: next 5 weekdays, 30-minute slots, 9:00 to 17:00 in the AE time zone, at least 2 hours out', () => {
  const zone = 'America/New_York';
  const now = zonedToUtc('2026-10-19', '08:00', zone); // a Monday, 8am
  const grid = slotGrid(now, {});
  const days = [...new Set(grid.map((s) => zonedDate(s.start, zone)))];
  assert.deepEqual(days, ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  assert.equal(new Date(grid[0].start).toISOString(), new Date(zonedToUtc('2026-10-19', '10:00', zone)).toISOString(), 'first slot is 2 hours from now');
  const tuesday = grid.filter((s) => zonedDate(s.start, zone) === '2026-10-20');
  assert.equal(tuesday.length, 16, '9:00 to 16:30');
  assert.equal(tuesday[0].start, zonedToUtc('2026-10-20', '09:00', zone));
  assert.equal(tuesday.at(-1).start, zonedToUtc('2026-10-20', '16:30', zone));
  assert.ok(grid.every((s) => s.end - s.start === 30 * MIN));
});

test('grid: weekends are skipped, and AE_TZ moves the business hours', () => {
  const friday = zonedToUtc('2026-10-23', '18:00', 'America/New_York');
  const days = [...new Set(slotGrid(friday, {}).map((s) => zonedDate(s.start, 'America/New_York')))];
  assert.deepEqual(days, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'], 'Friday evening has no slots left; then Monday to Thursday');
  const la = slotGrid(friday, { AE_TZ: 'America/Los_Angeles' });
  assert.equal(new Date(la.find((s) => zonedDate(s.start, 'America/Los_Angeles') === '2026-10-26').start).toISOString(), '2026-10-26T16:00:00.000Z', '9am Pacific');
});

test('slots API: only free times are offered, as UTC', async () => {
  const c = getConnectors();
  await qualify(c, '01');
  const all = await slotsFor({ sid: sidOf('01'), connectors: c });
  take(c, all.slots[0]);
  take(c, all.slots[2]);
  const res = await slotsGet(new Request(`http://x/api/slots?sid=${sidOf('01')}`));
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.slots.slice(0, 2), [all.slots[1], all.slots[3]]);
  assert.ok(body.slots.every((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(s)));
  assert.equal(body.zone, 'America/New_York');
  assert.equal((await slotsGet(new Request('http://x/api/slots'))).status, 400);
});

// ---------- the eight cases ----------

test('1. slam-dunk sid gets no slots', async () => {
  const c = getConnectors();
  for (const id of ['05', '06', '07']) {
    await qualify(c, id);
    assert.deepEqual(await slotsFor({ sid: sidOf(id), connectors: c }), { status: 'rejected' }, id);
    const res = await post({ sid: sidOf(id), slot: slotGrid()[0] && new Date(slotGrid()[0].start).toISOString(), tz: 'UTC' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).status, 'rejected');
  }
  assert.equal(c.google.events.length, 0);
});

test('1b. a slam-dunk reject is recognised before scoring has even run', async () => {
  const c = getConnectors();
  const payload = samplePayload(sample('05'));
  await c.airtable.createRecord(rules.tables.leads, { lead_id: payload.data.submissionId, status: 'received', received_at: new Date().toISOString(), raw_payload: JSON.stringify(payload) });
  assert.deepEqual(await slotsFor({ sid: sidOf('05'), connectors: c }), { status: 'rejected' });
});

test('1c. a rejection based on looked-up data still gets slots: the lead does not see why', async () => {
  const c = getConnectors();
  await qualify(c, '12');
  const offer = await slotsFor({ sid: sidOf('12'), connectors: c });
  assert.equal(offer.status, 'ok');
  const picked = await pickSlot({ sid: sidOf('12'), slot: offer.slots[0], tz: 'UTC', connectors: c });
  assert.equal(picked.status, 'received');
  assert.equal(c.google.events.length, 0);
});

test('2. pick before the tier is ready: the pick waits, and scoring books it when it finishes', async () => {
  const c = getConnectors();
  const sid = sidOf('01');
  // The form has not reached us yet: the page gets "unknown", then asks for times anyway.
  assert.deepEqual(await slotsFor({ sid, connectors: c }), { status: 'unknown' });
  const offer = await slotsFor({ sid, force: true, connectors: c });
  const picked = await pickSlot({ sid, slot: offer.slots[5], tz: 'America/Chicago', connectors: c });
  assert.equal(picked.status, 'received');
  assert.equal(c.google.events.length, 0, 'not booked: the lead is not qualified yet');

  // Now the form arrives and scoring runs. It finishes second, so it books.
  const [placeholder] = await c.airtable.findByField(rules.tables.leads, 'lead_id', sid);
  const payload = samplePayload(sample('01'));
  await c.airtable.updateRecord(rules.tables.leads, placeholder.id, { status: 'received', raw_payload: JSON.stringify(payload) });
  const result = await runPipeline({ recordId: placeholder.id, payload, connectors: c });
  assert.equal(result.booked.status, 'booked');
  assert.equal(c.google.events.length, 1);
  assert.deepEqual([row(c, '01').requested_slot, row(c, '01').booked_slot, row(c, '01').slot_changed], [offer.slots[5], offer.slots[5], false]);
  assert.ok(row(c, '01').picked_at);
  assert.deepEqual(sent(c), ['tier_a_confirm']);
  assert.match(c.google.emails[0].subject, /CDT$|CST$/, 'the email shows the time in the zone the lead picked from');
  assert.deepEqual(c.scheduled, [], 'no 15-minute fallback is needed once a time is picked');
});

test('3. pick after the tier is ready: the pick books it', async () => {
  const c = getConnectors();
  const result = await qualify(c, '01');
  assert.equal(result.booked.status, 'waiting_for_pick');
  assert.equal(c.google.events.length, 0);
  assert.equal(c.scheduled.length, 1, 'the 15-minute fallback is scheduled');
  assert.ok(Math.abs(c.scheduled[0] - (Date.now() + 15 * MIN)) < 30_000);

  const offer = await slotsFor({ sid: sidOf('01'), connectors: c });
  const res = await post({ sid: sidOf('01'), slot: offer.slots[2], tz: 'America/Los_Angeles' });
  assert.deepEqual(await res.json(), { status: 'booked', slot: offer.slots[2], requested: offer.slots[2], changed: false });
  assert.equal(c.google.events.length, 1);
  assert.equal(c.google.events[0].start.dateTime, offer.slots[2]);
  assert.deepEqual(sent(c), ['tier_a_confirm']);
  assert.match(c.slack.posts.at(-2).text, /^Booked: .* This is the time they picked\./);
  assert.match(c.slack.posts.at(-1).text, /Optional intro email from Alex Morgan/);
});

test('3b. Tier B: the pick books a hold and the page says the team will confirm', async () => {
  const c = getConnectors();
  await qualify(c, '03');
  const offer = await slotsFor({ sid: sidOf('03'), connectors: c });
  const res = await post({ sid: sidOf('03'), slot: offer.slots[0], tz: 'UTC' });
  assert.equal((await res.json()).status, 'hold');
  assert.equal(c.google.events[0].summary, `${rules.booking.title} | SDR to take`);
  assert.deepEqual(sent(c), []);
});

test('3c. Tier C never books, whatever it picks', async () => {
  const c = getConnectors();
  await qualify(c, '04');
  const offer = await slotsFor({ sid: sidOf('04'), connectors: c });
  assert.equal((await pickSlot({ sid: sidOf('04'), slot: offer.slots[0], tz: 'UTC', connectors: c })).status, 'received');
  assert.equal((await sweep({ connectors: c, now: Date.now() + 20 * MIN })).booked, 0);
  assert.equal(c.google.events.length, 0);
});

test('4. taken slot moves to the next free one, and the invite and email say so', async () => {
  const c = getConnectors();
  await qualify(c, '01');
  const offer = await slotsFor({ sid: sidOf('01'), connectors: c });
  // Someone else takes the first two times between the page loading and the click.
  take(c, offer.slots[0]);
  take(c, offer.slots[1]);
  const picked = await pickSlot({ sid: sidOf('01'), slot: offer.slots[0], tz: 'America/New_York', connectors: c });
  assert.deepEqual([picked.status, picked.slot, picked.requested, picked.changed], ['booked', offer.slots[2], offer.slots[0], true]);
  assert.deepEqual([row(c, '01').requested_slot, row(c, '01').booked_slot, row(c, '01').slot_changed], [offer.slots[0], offer.slots[2], true]);
  const note = /Your requested time was taken, so we've booked .+\. Reply to move it\./;
  assert.match(c.google.events[0].description, note);
  assert.match(c.google.emails[0].text, note);
  assert.match(c.slack.posts.at(-2).text, /The time they picked was taken, so this is the next free one\./);
});

test('4b. free/busy is checked again at booking time, not only when the page loads', async () => {
  const c = getConnectors();
  let checks = 0;
  const original = c.google.freeBusy.bind(c.google);
  c.google.freeBusy = async (...args) => { checks += 1; return original(...args); };
  await qualify(c, '01');
  const offer = await slotsFor({ sid: sidOf('01'), connectors: c });
  const before = checks;
  await pickSlot({ sid: sidOf('01'), slot: offer.slots[0], tz: 'UTC', connectors: c });
  assert.ok(checks > before);
});

test('5. no pick in 15 minutes: Tier A and B book the next free slot', async () => {
  const c = getConnectors();
  await qualify(c, '01');
  await qualify(c, '03');
  assert.equal((await sweep({ connectors: c, now: Date.now() + 14 * MIN })).booked, 0, 'not yet');
  assert.equal(c.google.events.length, 0);
  const result = await sweep({ connectors: c, now: Date.now() + 16 * MIN });
  assert.equal(result.booked, 2);
  assert.equal(c.google.events.length, 2);
  assert.notEqual(c.google.events[0].start.dateTime, c.google.events[1].start.dateTime, 'two leads never get the same time');
  assert.deepEqual([row(c, '01').requested_slot ?? '', row(c, '01').slot_changed], ['', false]);
  assert.ok(row(c, '01').booked_slot);
  assert.deepEqual(sent(c), ['tier_a_confirm'], 'Tier A is confirmed; Tier B still waits for the SDR');
  assert.ok(c.slack.posts.some((p) => /No time was picked within 15 minutes, so this is the next free slot\./.test(p.text)));
  assert.equal((await sweep({ connectors: c, now: Date.now() + 30 * MIN })).booked, 0, 'only once');
  assert.equal(c.google.events.length, 2);
});

test('5b. the sweep endpoint can be asked to run later, and refuses callers without the token', async () => {
  const token = signToken('sweep', 'run');
  assert.equal((await sweepGet(new Request('http://x/api/sweep'))).status, 401);
  const now = await sweepGet(new Request(`http://x/api/sweep?t=${token}`));
  assert.equal((await now.json()).ok, true);
  const realFetch = globalThis.fetch;
  const handedOver = [];
  globalThis.fetch = async (url) => { handedOver.push(String(url)); return new Response('{}'); };
  try {
    const later = await sweepGet(new Request(`http://x/api/sweep?t=${token}&at=${Date.now() + 15 * MIN}`));
    assert.ok((await later.json()).waiting_ms > 14 * MIN);
    // After waiting, it hands over to a fresh call of the same URL (which waits again or runs).
    const { background } = await import('../lib/background.js');
    await background.last;
    assert.equal(handedOver.length, 1);
    assert.match(handedOver[0], /\/api\/sweep\?t=.*&at=\d+$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('6. double POST: the second returns the existing booking and books nothing more', async () => {
  const c = getConnectors();
  await qualify(c, '01');
  const offer = await slotsFor({ sid: sidOf('01'), connectors: c });
  const first = await (await post({ sid: sidOf('01'), slot: offer.slots[1], tz: 'UTC' })).json();
  const second = await (await post({ sid: sidOf('01'), slot: offer.slots[1], tz: 'UTC' })).json();
  const different = await (await post({ sid: sidOf('01'), slot: offer.slots[4], tz: 'UTC' })).json();
  assert.deepEqual(second, first);
  assert.deepEqual(different, first, 'a different time on a second POST does not move the booking');
  assert.equal(c.google.events.length, 1);
  assert.deepEqual(sent(c), ['tier_a_confirm']);
  assert.deepEqual(await slotsFor({ sid: sidOf('01'), connectors: c }), { status: 'booked', slot: offer.slots[1] }, 'reloading the page shows the booking');
});

test('6b. two POSTs before scoring keep the first pick', async () => {
  const c = getConnectors();
  const offer = await slotsFor({ sid: 'early', force: true, connectors: c });
  await pickSlot({ sid: 'early', slot: offer.slots[1], tz: 'UTC', connectors: c });
  const again = await pickSlot({ sid: 'early', slot: offer.slots[6], tz: 'UTC', connectors: c });
  assert.equal(again.requested, offer.slots[1]);
  assert.equal(c.airtable.tables.get(rules.tables.leads).size, 1);
});

test('6c. a time that is not on offer is refused', async () => {
  const c = getConnectors();
  await qualify(c, '01');
  for (const slot of ['2020-01-01T15:00:00.000Z', new Date(Date.now() + 10 * MIN).toISOString(), 'tomorrow', '2026-10-24T15:07:00.000Z']) {
    const res = await post({ sid: sidOf('01'), slot, tz: 'UTC' });
    assert.equal(res.status, 400, slot);
  }
  assert.equal((await post({ sid: sidOf('01') })).status, 400);
  assert.equal(c.google.events.length, 0);
});

test('7. headcount fallback: with no enrichment, the range typed on the form drives the size gate', async () => {
  const empty = profileFromApollo(null);
  const inRange = applySelfReported(empty, '201-500');
  assert.deepEqual([inRange.profile.headcount_min, inRange.profile.headcount_max, inRange.profile.headcount_source, inRange.flag], [201, 500, 'self-reported', null]);
  assert.equal(gate(inRange.profile), null);
  assert.equal(gate(applySelfReported(empty, '51-200').profile), null, 'the range touches 200, so it passes');
  assert.equal(gate(applySelfReported(empty, '1,001-5,000').profile), null, 'the range overlaps 200 to 2,000');
  assert.match(gate(applySelfReported(empty, '11-50').profile).reason, /Headcount 11-50 is outside 200 to 2000/);
  assert.match(gate(applySelfReported(empty, '5,001+').profile).reason, /outside 200 to 2000/);
  assert.equal(gate(applySelfReported(empty, null).profile), null, 'no answer and no enrichment: unknown never disqualifies');

  // End to end: an unknown company that says it has 11-50 staff is disqualified on size.
  const c = getConnectors();
  const small = { ...sample('15'), id: 'self-small', email: 'kim@quietharbor-tiny.com', employees: '11-50', expect: { outcome: 'DQ', channel: 'inbound-review' } };
  const { problems, got } = await runSample(small, c);
  assert.deepEqual(problems, []);
  assert.match(got.reason, /Headcount 11-50 is outside/);
  // And one that says 201-500 passes, with the brief saying where the number came from.
  const { got: ok } = await runSample(sample('15'), c);
  assert.equal(ok.outcome, 'C');
  assert.match(c.slack.posts.find((p) => /quietharbor-systems/.test(p.text)).text, /201-500 staff \(self-reported on the form\)/);
});

test('7b. enrichment wins when it has a headcount', () => {
  const apollo = profileFromApollo({ name: 'X', estimated_num_employees: 40, owned_by_organization_id: null });
  const { profile, flag } = applySelfReported(apollo, '201-500');
  assert.deepEqual([profile.headcount_min, profile.headcount_max, profile.headcount_source], [40, 40, undefined]);
  assert.match(gate(profile).reason, /Headcount 40 is outside/, 'the looked-up number is used, not the form');
  assert.ok(flag);
});

test('8. headcount mismatch flag: more than one band apart flags for review and never disqualifies', async () => {
  const at = (n) => profileFromApollo({ name: 'X', estimated_num_employees: n, owned_by_organization_id: null });
  assert.equal(applySelfReported(at(530), '501-1,000').flag, null, 'same band');
  assert.equal(applySelfReported(at(530), '201-500').flag, null, 'one band apart');
  assert.equal(applySelfReported(at(530), '1,001-5,000').flag, null, 'one band apart');
  assert.equal(applySelfReported(at(530), '11-50').flag, 'headcount mismatch (form says 11-50, Apollo says 530)');
  assert.equal(applySelfReported(at(530), '5,001+').flag, 'headcount mismatch (form says 5,001+, Apollo says 530)');

  const c = getConnectors();
  const lead = { ...sample('01'), id: 'mismatch', employees: '11-50', expect: { outcome: 'A', channel: 'ae-alerts' } };
  const { problems, got } = await runSample(lead, c);
  assert.deepEqual(problems, [], 'still Tier A and still booked: the flag is for review only');
  assert.deepEqual(got.flags, ['headcount mismatch (form says 11-50, Apollo says 530)']);
  assert.match(c.slack.posts[0].text, /\*Flags:\* headcount mismatch \(form says 11-50, Apollo says 530\)/);
  const fields = [...c.airtable.tables.get(rules.tables.leads).values()].at(-1).fields;
  assert.equal(fields.flags, 'headcount mismatch (form says 11-50, Apollo says 530)');
  assert.ok(fields.booked_slot);
});

// ---------- booking never happens twice ----------

test('a lead is only ever booked once, however many times booking is triggered', async () => {
  const c = getConnectors();
  await runSample(sample('01'), c);
  for (const trigger of ['qualified', 'picked', 'timeout']) {
    assert.equal((await finalizeBooking({ leadId: sidOf('01'), connectors: c, trigger })).status, 'booked');
  }
  await sweep({ connectors: c, now: Date.now() + HOUR });
  assert.equal(c.google.events.length, 1);
  assert.deepEqual(sent(c), ['tier_a_confirm']);
});

test('no free time at all: the lead is told nothing false, and the owner is warned', async () => {
  const c = getConnectors();
  c.google.busy.push({ start: '2020-01-01T00:00:00Z', end: '2040-01-01T00:00:00Z' });
  await qualify(c, '01');
  assert.deepEqual((await slotsFor({ sid: sidOf('01'), connectors: c })).slots, []);
  const result = await sweep({ connectors: c, now: Date.now() + 16 * MIN });
  assert.equal(result.booked, 0);
  assert.equal(c.google.events.length, 0);
  assert.ok(c.slack.posts.some((p) => /Could not book Dana Reyes: no free slot in the next 5 weekdays/.test(p.text)));
  assert.deepEqual(sent(c), [], 'no confirmation is sent for a meeting that does not exist');
});

test('book(): with nothing requested it takes the first free time', async () => {
  const c = getConnectors();
  const now = zonedToUtc('2026-10-19', '08:00', 'America/New_York');
  const booking = await book({ lead: { email: 'a@b.co' }, google: c.google, now, env: {} });
  assert.equal(booking.start, new Date(zonedToUtc('2026-10-19', '10:00', 'America/New_York')).toISOString());
  assert.equal(booking.slot, 'Mon, Oct 19, 10:00 AM EDT');
  assert.deepEqual([booking.changed, booking.changeNote], [false, null]);
});

// ---------- the page ----------

test('GET /book: one self-contained page, no external scripts, generic footer', async () => {
  const res = await bookPage();
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\//i.test(html), false, 'nothing is loaded from elsewhere');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.ok(html.includes(rules.disclaimer));
  for (const text of ["/api/slots?sid=", "'/api/slot'", 'Invite on its way', 'Our team will confirm shortly', 'in touch by email', "attempt >= 5 ? '&force=1'", 'setTimeout(function () { load(attempt + 1); }, 1000)']) {
    assert.ok(html.includes(text), `page is missing: ${text}`);
  }
});
