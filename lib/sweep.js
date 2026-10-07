import { rules, teamMember } from './rules.js';
import { runAction } from './actions.js';
import { finalizeBooking, laneOf } from './booking-flow.js';
import { noteAlert } from './alerts.js';
import { safe } from './brief.js';

const HOUR = 3_600_000;
const has = (actions, name) => actions.split('\n').some((line) => line.split(' ')[1] === name);

// The timed rules. Safe to run as often as you like: every step is recorded, so nothing repeats.
//  - Tier A or B with no time picked 15 minutes after the form: book the next free slot.
//  - Tier B not confirmed 24 hours before the meeting: reminder to #sdr-inbound.
//  - Tier B still not confirmed 4 hours before: release it (cancel, "tier_b_release" email, post).
//  - Tier C, or a rejection based on looked-up data, untouched for 4 hours: default to nurture.
export async function sweep({ connectors, env = process.env, now = Date.now() }) {
  const { airtable, slack } = connectors;
  const e = rules.emails;
  const sdr = teamMember('sdr');
  const reviewer = teamMember('reviewer');
  const done = { booked: 0, reminders: 0, released: 0, nurtured: 0, errors: [] };
  const rows = await airtable.findSince(rules.tables.leads, 'received_at', new Date(now - 30 * 24 * HOUR).toISOString());

  for (const row of rows) {
    let state;
    try {
      state = JSON.parse(row.fields.state_json ?? 'null');
    } catch {
      continue;
    }
    if (!state?.lead) continue;
    const actions = String(row.fields.reviewer_actions ?? '');
    const { lead, outcome, booking } = state;
    const who = `${safe(lead.name)} at ${safe(lead.company || lead.domain)}`;

    try {
      // Tier A or B, qualified but not booked: book the time the lead picked, or, once
      // 15 minutes have passed with no pick, the next free slot.
      const lane = laneOf(state);
      if (['A', 'B'].includes(lane) && !booking?.booked && !booking?.cancelled) {
        const waited = (now - Date.parse(row.fields.received_at)) / 60_000;
        const trigger = row.fields.requested_slot ? 'picked' : waited >= rules.booking.no_pick_minutes ? 'timeout' : null;
        if (trigger) {
          const result = await finalizeBooking({ leadId: lead.lead_id, connectors, env, trigger, now });
          if (result.status === 'booked') done.booked += 1;
          else if (result.status === 'failed') done.errors.push(`${lead.lead_id}: ${result.reason}`);
        }
        continue;
      }

      const withSdr = outcome.kind === 'tiered' && state.channel === sdr.channel && booking?.booked && booking.start;
      if (withSdr && !has(actions, 'confirm_meeting') && !has(actions, 'not_qualified')) {
        const hoursLeft = (Date.parse(booking.start) - now) / HOUR;
        if (hoursLeft <= e.tier_b_release_hours) {
          const result = await runAction({ leadId: lead.lead_id, action: 'not_qualified', connectors, env, auto: true });
          if (result.ok) done.released += 1; else done.errors.push(`${lead.lead_id}: ${result.message}`);
        } else if (hoursLeft <= e.tier_b_reminder_hours && !has(actions, 'reminder_24h')) {
          await slack.postMessage(sdr.channel, noteAlert(sdr.channel, sdr.name, `Reminder: ${who} is booked for ${booking.slot} and is not confirmed yet. If it is still unconfirmed ${e.tier_b_release_hours} hours before, the meeting is released automatically.`).text);
          await airtable.updateRecord(rules.tables.leads, row.id, { reviewer_actions: [actions, `${new Date(now).toISOString()} reminder_24h (automatic)`].filter(Boolean).join('\n') });
          done.reminders += 1;
        }
        continue;
      }

      const waitingOnReviewer = state.channel === reviewer.channel
        && ((outcome.kind === 'tiered' && outcome.tier === 'C') || (outcome.kind === 'disqualified' && !outcome.category));
      const age = (now - Date.parse(row.fields.received_at)) / HOUR;
      if (waitingOnReviewer && !actions.trim() && age >= e.untouched_hours_before_nurture) {
        const result = await runAction({ leadId: lead.lead_id, action: 'nurture', connectors, env, auto: true });
        if (result.ok) done.nurtured += 1; else done.errors.push(`${lead.lead_id}: ${result.message}`);
      }
    } catch (err) {
      done.errors.push(`${lead.lead_id}: ${err.message}`);
    }
  }
  return done;
}
