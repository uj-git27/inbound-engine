import { rules } from './rules.js';
import { parseTally } from './tally.js';
import { applyAlias } from './alias.js';
import { freeChecks } from './checks.js';
import { slotGrid, openSlots, aeZone } from './booking.js';
import { finalizeBooking, laneOf } from './booking-flow.js';

const table = rules.tables.leads;
const findRow = async (airtable, sid) => (await airtable.findByField(table, 'lead_id', sid))[0] ?? null;

// A slam-dunk reject (failed the free checks) or a skipped duplicate gets no calendar.
// The free checks only need what the lead typed, so this works before scoring has finished.
function isRejected(row) {
  const f = row.fields;
  if (f.status === 'duplicate_skipped') return true;
  try {
    const state = JSON.parse(f.state_json ?? 'null');
    if (state?.outcome) return state.outcome.kind === 'disqualified' && Boolean(state.outcome.category);
  } catch {
    // fall through to the payload
  }
  try {
    const { lead } = parseTally(JSON.parse(f.raw_payload));
    return Boolean(freeChecks(applyAlias(lead)).disqualified);
  } catch {
    return false;
  }
}

const validZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
};

// What the booking page shows for one submission.
//   unknown  - the form has not reached us yet (the page retries, then asks with force)
//   rejected - no calendar: "Thanks, we'll be in touch by email."
//   booked / picked - this submission already has a time
//   ok       - the open slots, as UTC times
export async function slotsFor({ sid, force = false, connectors, env = process.env, now = Date.now() }) {
  const row = await findRow(connectors.airtable, sid);
  if (!row && !force) return { status: 'unknown' };
  if (row) {
    if (isRejected(row)) return { status: 'rejected' };
    if (row.fields.booked_slot) return { status: 'booked', slot: row.fields.booked_slot };
    if (row.fields.requested_slot) return { status: 'picked', slot: row.fields.requested_slot };
  }
  return openTimes({ connectors, env, now });
}

// The open slots alone, for the picker shown next to the form before anything is submitted.
export async function openTimes({ connectors, env = process.env, now = Date.now() }) {
  const open = await openSlots({ google: connectors.google, now, env });
  return { status: 'ok', zone: aeZone(env), minutes: rules.booking.duration_minutes, slots: open.map((s) => new Date(s.start).toISOString()) };
}

// The lead picked a time. The pick is stored once; a second call for the same submission
// returns what already exists. If the lead is already qualified, the meeting is booked now;
// otherwise it is booked when scoring finishes.
//   booked   - Tier A: "Booked for <time>. Invite on its way."
//   hold     - Tier B: "Our team will confirm shortly."
//   received - not decided yet, or a lead that is not booked automatically
export async function pickSlot({ sid, slot, tz, connectors, env = process.env, now = Date.now() }) {
  const { airtable } = connectors;
  let row = await findRow(airtable, sid);
  if (row && isRejected(row)) return { http: 409, status: 'rejected' };

  const answer = (result, requested) => {
    if (result.status === 'booked') {
      const { booking } = result;
      return { http: 200, status: result.lane === 'B' ? 'hold' : 'booked', slot: booking.start, requested, changed: Boolean(booking.changed) };
    }
    return { http: 200, status: 'received', requested };
  };

  // Idempotent: an existing booking or pick is returned as it is.
  if (row?.fields.booked_slot) {
    let lane = null;
    try { lane = laneOf(JSON.parse(row.fields.state_json)); } catch { /* no state */ }
    return { http: 200, status: lane === 'B' ? 'hold' : 'booked', slot: row.fields.booked_slot, requested: row.fields.requested_slot || null, changed: Boolean(row.fields.slot_changed) };
  }
  if (!row?.fields.requested_slot) {
    const start = Date.parse(slot);
    if (Number.isNaN(start) || !slotGrid(now, env).some((s) => s.start === start)) return { http: 400, status: 'invalid', error: 'That time is not on offer. Please pick another.' };
    const pick = { requested_slot: new Date(start).toISOString(), picked_at: new Date(now).toISOString(), buyer_tz: validZone(tz) ?? '' };
    // The pick can arrive before the form does: keep it on a placeholder row the form then fills in.
    if (row) await airtable.updateRecord(table, row.id, pick);
    else await airtable.createRecord(table, { lead_id: sid, status: 'awaiting_form', received_at: new Date(now).toISOString(), ...pick });
    row = await findRow(airtable, sid);
  }
  const result = await finalizeBooking({ leadId: sid, connectors, env, trigger: 'picked', now });
  return answer(result, row.fields.requested_slot);
}
