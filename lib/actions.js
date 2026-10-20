import { rules, teamMember } from './rules.js';
import { ACTIONS } from './links.js';
import { book } from './booking.js';
import { bookingFields } from './booking-flow.js';
import { sendTemplate } from './emails.js';
import { tierAlert, noteAlert, postAlert, introDraft } from './alerts.js';
import { enrichContact } from './contact.js';
import { loadLead } from './state.js';
import { safe } from './brief.js';

const stamp = (action) => `${new Date().toISOString()} ${action}`;
const VERDICT = { verdict_right: 'Right tier', verdict_wrong_A: 'Wrong: A', verdict_wrong_B: 'Wrong: B', verdict_wrong_C: 'Wrong: C' };

// Runs one action from a button or signed link. Idempotent: an action that already ran is
// reported, not repeated. `auto` marks an action taken by a timer instead of a person.
export async function runAction({ leadId, action, connectors, env = process.env, auto = false }) {
  const { airtable, slack, google, crm } = connectors;
  const loaded = await loadLead(airtable, leadId);
  if (!loaded?.state) return { ok: false, message: 'This lead could not be found.' };
  const { record, state } = loaded;
  const { lead, outcome } = state;
  const done = String(record.fields.reviewer_actions ?? '').split('\n').filter(Boolean);
  const label = ACTIONS[action];

  if (VERDICT[action] && record.fields.rep_verdict) return { ok: true, message: `A verdict was already recorded: ${record.fields.rep_verdict}.` };
  if (done.some((line) => line.split(' ')[1] === action)) return { ok: true, message: `"${label}" was already done. Nothing was repeated.` };

  const fields = {};
  const say = (channel, owner, text) => slack.postMessage(channel, noteAlert(channel, owner, text).text);
  const who = `${safe(lead.name)} at ${safe(lead.company || lead.domain)}`;
  const sdr = teamMember('sdr');
  const ae = teamMember('ae');
  const bookNow = async (titleSuffix = '') => {
    if (state.booking?.booked) return state.booking;
    // The time the lead picked on the booking page, if any; otherwise the next free slot.
    const booking = await book({ lead, google, requested: record.fields.requested_slot || null, buyerZone: record.fields.buyer_tz || null, titleSuffix, env });
    if (!booking.booked) throw new Error(`Could not book: ${booking.reason}`);
    state.booking = booking;
    Object.assign(fields, bookingFields(booking));
    // The CRM record shows the booked demo too; a CRM hiccup never undoes a booking.
    await crm.upsertCompany(lead.domain, { name: lead.company, demo_slot: booking.slot }).catch(() => {});
    return booking;
  };
  // Templates only, and never the same one twice to the same lead.
  const send = (template) => sendTemplate(template, { lead, outcome, booking: state.booking, state, google, env });
  const sentNote = (result, template) => (result.sent ? `The "${template}" email was sent to ${result.email.to}.` : `No email was sent: ${result.why}.`);
  const ctx = (note) => ({ lead, outcome, booking: state.booking, contact: state.contact, env, note });
  // A meeting that should no longer happen is cancelled (and the attendees are told).
  const cancelMeeting = async () => {
    if (!state.booking?.eventId) return null;
    const slot = state.booking.slot;
    await google.deleteEvent(state.booking.eventId);
    state.booking = { booked: false, cancelled: true, reason: 'cancelled' };
    Object.assign(fields, bookingFields(state.booking));
    return slot;
  };
  // Moves the lead to another tier's owner, as that tier's rules say:
  //   A: booked on the AE's calendar, confirmation email sent, brief in #ae-alerts.
  //   B: booked with the SDR as owner, brief in #sdr-inbound with Confirm / Not qualified.
  //   C: back to the review queue. A meeting already booked stays until the reviewer decides.
  const moveTo = async (tier) => {
    const from = state.owner;
    const wasBooked = state.booking?.booked;
    let alert;
    let extra = '';
    if (tier === 'A') {
      const booking = await bookNow();
      if (wasBooked) await google.patchEvent(booking.eventId, { summary: rules.booking.title });
      const result = await send('tier_a_confirm');
      alert = tierAlert(ctx(`Moved to Tier A by ${from}. ${sentNote(result, 'tier_a_confirm')}`), 'A');
      extra = ` Meeting ${wasBooked ? 'kept' : 'booked'} for ${booking.slot}. ${sentNote(result, 'tier_a_confirm')}`;
    } else if (tier === 'B') {
      const booking = await bookNow(rules.booking.sdr_title_suffix);
      if (wasBooked) await google.patchEvent(booking.eventId, { summary: `${rules.booking.title}${rules.booking.sdr_title_suffix}` });
      alert = tierAlert(ctx(`Moved to Tier B by ${from}. Only the calendar invite has gone out. "Confirm meeting" sends the confirmation from the AE; "Not qualified" cancels the meeting.`), 'B');
      extra = ` Meeting ${wasBooked ? 'kept' : 'booked'} for ${booking.slot}.`;
    } else {
      const held = wasBooked ? ` A meeting is still booked for ${state.booking.slot}: "Nurture" or "Approve rejection" cancels it.` : '';
      alert = tierAlert(ctx(`Moved to Tier C by ${from}. No email goes out until you act.${held}`), 'C');
    }
    const posted = await postAlert(slack, alert, env);
    // A lead moved to the AE also gets the optional intro email to review, in the new thread.
    if (tier === 'A' && posted?.ts) await postAlert(slack, introDraft(ctx()), env, { channel: posted.channel, ts: posted.ts });
    Object.assign(state, { channel: alert.channel, owner: alert.owner, lane: tier });
    Object.assign(fields, { route: `#${alert.channel}`, owner: alert.owner });
    return `Moved to ${alert.owner} in #${alert.channel}.${extra}`;
  };
  let message;

  try {
    switch (action) {
      case 'confirm_meeting': {
        const wasBooked = state.booking?.booked;
        if (outcome.kind !== 'tiered') {
          // Customer, open deal or expansion: the owner confirms and the meeting is booked.
          const booking = await bookNow();
          message = wasBooked ? `Already booked for ${booking.slot}.` : `Meeting booked for ${booking.slot}. The invite has been sent.`;
          if (!wasBooked) await say(state.channel, state.owner, `Meeting confirmed for ${who}: ${booking.slot}.`);
          break;
        }
        // Tier B (or a lead the reviewer sent to the SDR): the SDR has spoken to the lead.
        const booking = await bookNow();
        if (wasBooked) await google.patchEvent(booking.eventId, { summary: rules.booking.title });
        const result = await send('tier_b_confirm');
        await say(ae.channel, ae.name, `Confirmed by ${sdr.name}: ${who}, meeting on ${booking.slot}. ${sentNote(result, 'tier_b_confirm')}`);
        message = `Confirmed for ${booking.slot}. ${sentNote(result, 'tier_b_confirm')} ${ae.name} was told in #${ae.channel}.`;
        break;
      }
      case 'confirm_anyway': {
        const wasBooked = state.booking?.booked;
        const booking = await bookNow();
        message = wasBooked ? `Already booked for ${booking.slot}.` : `Meeting booked for ${booking.slot}. The invite has been sent.`;
        if (!wasBooked) await say(state.channel, state.owner, `Meeting confirmed anyway for ${who}: ${booking.slot}.`);
        break;
      }
      case 'not_qualified': {
        // If the meeting is not booked yet (the lead has not picked a time), this also stops it
        // from being booked later.
        const slot = state.booking?.booked ? state.booking.slot : null;
        if (state.booking?.eventId) await google.deleteEvent(state.booking.eventId);
        state.booking = { booked: false, cancelled: true, reason: 'cancelled: not qualified' };
        Object.assign(fields, bookingFields(state.booking));
        const result = await send('tier_b_release');
        const why = auto ? `Not confirmed ${rules.emails.tier_b_release_hours} hours before the meeting, so it was released automatically` : `Marked not qualified by ${sdr.name}`;
        const meeting = slot ? `The meeting on ${slot} is cancelled.` : 'No meeting had been booked yet, and none will be.';
        await say(sdr.channel, sdr.name, `${why}: ${who}. ${meeting} ${sentNote(result, 'tier_b_release')}`);
        message = `${slot ? `Meeting on ${slot} cancelled.` : 'No meeting will be booked.'} ${sentNote(result, 'tier_b_release')}`;
        break;
      }
      case 'send_intro': {
        // The AE reviewed the draft in the thread and chose to send it.
        const result = await send('ae_intro');
        message = sentNote(result, 'ae_intro');
        break;
      }
      case 'send_sdr': {
        // Nothing is sent or booked: the SDR follows up by email, LinkedIn or call.
        const alert = tierAlert(ctx('Sent by the reviewer. No meeting is booked and no email has gone out: follow up by email, LinkedIn or call. "Confirm meeting" books it and sends the confirmation.'), 'B');
        await postAlert(slack, alert, env);
        Object.assign(state, { channel: alert.channel, owner: alert.owner });
        message = `Sent to ${alert.owner} in #${alert.channel}. No email was sent.`;
        break;
      }
      case 'approve_rejection': {
        const cancelled = await cancelMeeting();
        // The template that fits why it was rejected (personal email, vendor, investor or press), else the generic one.
        const template = rules.emails.rejection_templates[outcome.category] ?? 'reject_generic';
        const result = await send(template);
        const meeting = cancelled ? ` The meeting on ${cancelled} was cancelled.` : '';
        await say(state.channel, state.owner, `Rejection approved for ${who}. ${sentNote(result, template)}${meeting}`);
        message = `${sentNote(result, template)}${meeting}`;
        break;
      }
      case 'nurture': {
        const cancelled = await cancelMeeting();
        await crm.upsertCompany(lead.domain, { name: lead.company, lifecyclestage: 'lead', nurture: 'nurture' });
        const result = await send('nurture_tour');
        const meeting = cancelled ? ` The meeting on ${cancelled} was cancelled.` : '';
        const why = auto ? `Untouched for ${rules.emails.untouched_hours_before_nurture} hours, so it moved to nurture automatically` : 'Moved to nurture';
        await say(state.channel, state.owner, `${why}: ${who}. Tagged in the CRM. ${sentNote(result, 'nurture_tour')}${meeting}`);
        message = `Marked as a nurture lead in the CRM. ${sentNote(result, 'nurture_tour')}${meeting}`;
        break;
      }
      case 'find_contact': {
        const result = await enrichContact({ leadId, connectors, env, waitForClay: false });
        message = result.contact?.person?.linkedin || result.contact?.phone ? 'Contact found and posted to the channel.' : 'Lookup finished: no contact details were found.';
        // enrichContact saved its own state; reload so the action log below does not overwrite it.
        Object.assign(state, (await loadLead(airtable, leadId)).state);
        break;
      }
      default: {
        const verdict = VERDICT[action];
        fields.rep_verdict = verdict;
        await crm.upsertCompany(lead.domain, { name: lead.company, rep_verdict: verdict });
        message = `Recorded: ${verdict}.`;
        // A "Wrong" verdict is also a decision: the lead moves to the owner of the tier chosen.
        const target = action.startsWith('verdict_wrong_') ? action.slice(-1) : null;
        const current = state.lane ?? (outcome.kind === 'tiered' ? outcome.tier : null);
        if (target && target !== current) message += ` ${await moveTo(target)}`;
      }
    }
  } catch (err) {
    const reason = /Missing env var (GOOGLE_|SMTP_)/.test(err.message) ? 'calendar and email are not connected yet.' : err.message;
    return { ok: false, message: `"${label}" did not complete: ${reason}` };
  }

  await airtable.updateRecord(rules.tables.leads, record.id, {
    ...fields,
    reviewer_actions: [...done, `${stamp(action)}${auto ? ' (automatic)' : ''}`].join('\n'),
    emails_log: (state.email_log ?? []).join('\n'),
    state_json: JSON.stringify(state),
  });
  return { ok: true, message };
}
