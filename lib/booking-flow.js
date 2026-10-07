import { randomUUID } from 'node:crypto';
import { rules, teamMember } from './rules.js';
import { book } from './booking.js';
import { sendTemplate } from './emails.js';
import { introDraft, postAlert } from './alerts.js';
import { loadLead } from './state.js';

// A booking attempt that can never throw: the reason comes back instead.
export const tryBook = async (args) => {
  try {
    return await book(args);
  } catch (err) {
    const notConnected = /Missing env var (GOOGLE_|SMTP_)/.test(err.message);
    return { booked: false, reason: notConnected ? 'calendar and email are not connected yet' : err.message };
  }
};

// Which tier's rules the lead is under now: where a person moved it, else what the engine scored.
export const laneOf = (state) => state.lane ?? (state.outcome?.kind === 'tiered' ? state.outcome.tier : null);

// Airtable columns for a booking.
export const bookingFields = (booking) => ({
  slot: booking.booked ? booking.slot : '',
  booked_slot: booking.booked ? booking.start : '',
  slot_changed: Boolean(booking.booked && booking.changed),
  event_link: booking.eventLink ?? '',
  event_id: booking.eventId ?? '',
});

// Books the meeting for a Tier A or B lead. Two things have to be true first: the lead is
// qualified, and it has picked a time. Whichever happens second calls this and the meeting is
// booked then. `trigger` says who is calling:
//   'qualified' - scoring just finished      'picked' - the lead just picked a time
//   'timeout'   - no pick within 15 minutes, so the next free slot is booked
// Safe to call any number of times: a lead is only ever booked once.
export async function finalizeBooking({ leadId, connectors, env = process.env, trigger, now = Date.now() }) {
  const { airtable, slack, google, crm, sleep } = connectors;
  const table = rules.tables.leads;
  let loaded = await loadLead(airtable, leadId);
  if (!loaded?.state) return { status: 'not_qualified_yet' };
  if (loaded.state.booking?.booked) return { status: 'booked', booking: loaded.state.booking, lane: laneOf(loaded.state) };
  const lane = laneOf(loaded.state);
  if (!['A', 'B'].includes(lane) || loaded.state.booking?.cancelled) return { status: 'not_bookable', lane };
  const requested = loaded.record.fields.requested_slot || null;
  if (!requested && trigger !== 'timeout') return { status: 'waiting_for_pick', lane };

  // Scoring and the pick can finish at almost the same moment. Each attempt writes its own mark,
  // waits a moment, and only the one whose mark is still there goes on to book.
  const mark = randomUUID();
  await airtable.updateRecord(table, loaded.record.id, { booking_lock: mark });
  await sleep(400 + Math.floor(Math.random() * 400));
  loaded = await loadLead(airtable, leadId);
  if (loaded.record.fields.booking_lock !== mark) return { status: 'in_progress', lane };
  if (loaded.state.booking?.booked) return { status: 'booked', booking: loaded.state.booking, lane };

  const { record, state } = loaded;
  const { lead, outcome } = state;
  const booking = await tryBook({
    lead, google, requested, buyerZone: record.fields.buyer_tz || null,
    titleSuffix: lane === 'B' ? rules.booking.sdr_title_suffix : '', env, now,
  });
  state.booking = booking;
  const reply = (text) => (state.thread ? slack.postMessage(state.channel, text, { thread: state.thread }) : slack.postMessage(state.channel, text));
  const notes = [];

  if (!booking.booked) {
    await reply(`:warning: Could not book ${lead.name}: ${booking.reason}.`).catch(() => {});
    await airtable.updateRecord(table, record.id, { state_json: JSON.stringify(state), error: `Not booked: ${booking.reason}` });
    return { status: 'failed', lane, reason: booking.reason };
  }

  const how = trigger === 'timeout'
    ? ` No time was picked within ${rules.booking.no_pick_minutes} minutes, so this is the next free slot.`
    : booking.changed ? ' The time they picked was taken, so this is the next free one.' : ' This is the time they picked.';
  const link = booking.eventLink ? ` <${booking.eventLink}|Open event>.` : '';
  try {
    if (lane === 'A') {
      // Tier A: the confirmation goes out automatically in the AE's name. No SDR step.
      let sent;
      try {
        sent = await sendTemplate('tier_a_confirm', { lead, outcome, booking, state, google, env });
      } catch (err) {
        sent = { sent: false, why: `sending failed (${err.message})` };
      }
      const mail = sent.sent ? `Confirmation sent to ${sent.email.to} (template "tier_a_confirm", from ${sent.email.fromName}).` : `Confirmation not sent: ${sent.why}.`;
      await reply(`Booked: ${booking.slot}.${how}${link}\n${mail}`);
      if (state.thread) await postAlert(slack, introDraft({ lead, outcome, booking, env }), env, state.thread);
    } else {
      // Tier B: a hold on the AE's calendar with the SDR as owner. Only the invite goes out.
      const sdr = teamMember('sdr');
      await reply(`Booked for ${sdr.name} to take: ${booking.slot}.${how}${link}\nOnly the calendar invite has gone out. "Confirm meeting" sends the confirmation from the AE; "Not qualified" cancels the meeting.`);
    }
  } catch (err) {
    notes.push(`Slack booking note failed: ${err.message}`);
  }
  await crm.upsertCompany(lead.domain, { name: lead.company, demo_slot: booking.slot }).catch((err) => notes.push(`CRM demo slot not saved: ${err.message}`));

  await airtable.updateRecord(table, record.id, {
    ...bookingFields(booking),
    emails_log: (state.email_log ?? []).join('\n'),
    state_json: JSON.stringify(state),
    ...(notes.length ? { notes: [record.fields.notes, ...notes].filter(Boolean).join('\n') } : {}),
  });
  return { status: 'booked', booking, lane };
}
