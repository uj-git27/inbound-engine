import { rules, teamMember } from './rules.js';
import { ACTIONS } from './links.js';
import { book } from './booking.js';
import { sendTemplate } from './emails.js';
import { tierAlert, noteAlert, postAlert } from './alerts.js';
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
    const booking = await book({ lead, google, titleSuffix, env });
    if (!booking.booked) throw new Error(`Could not book: ${booking.reason}`);
    state.booking = booking;
    Object.assign(fields, { slot: booking.slot, event_link: booking.eventLink, event_id: booking.eventId });
    return booking;
  };
  // Templates only, and never the same one twice to the same lead.
  const send = (template) => sendTemplate(template, { lead, outcome, booking: state.booking, state, google, env });
  const sentNote = (result, template) => (result.sent ? `The "${template}" email was sent to ${result.email.to}.` : `No email was sent: ${result.why}.`);
  const ctx = (note) => ({ lead, outcome, booking: state.booking, contact: state.contact, env, note });
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
        if (!state.booking?.eventId) throw new Error('There is no booked meeting to cancel.');
        await google.deleteEvent(state.booking.eventId);
        const slot = state.booking.slot;
        state.booking = { booked: false, cancelled: true, reason: 'cancelled: not qualified' };
        Object.assign(fields, { slot: '', event_link: '', event_id: '' });
        const result = await send('tier_b_release');
        const why = auto ? `Not confirmed ${rules.emails.tier_b_release_hours} hours before the meeting, so it was released automatically` : `Marked not qualified by ${sdr.name}`;
        await say(sdr.channel, sdr.name, `${why}: ${who}. The meeting on ${slot} is cancelled. ${sentNote(result, 'tier_b_release')}`);
        message = `Meeting on ${slot} cancelled. ${sentNote(result, 'tier_b_release')}`;
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
        const result = await send('reject_generic');
        await say(state.channel, state.owner, `Rejection approved for ${who}. ${sentNote(result, 'reject_generic')}`);
        message = sentNote(result, 'reject_generic');
        break;
      }
      case 'nurture': {
        await crm.upsertCompany(lead.domain, { name: lead.company, lifecyclestage: 'lead', nurture: 'nurture' });
        const result = await send('nurture_tour');
        const why = auto ? `Untouched for ${rules.emails.untouched_hours_before_nurture} hours, so it moved to nurture automatically` : 'Moved to nurture';
        await say(state.channel, state.owner, `${why}: ${who}. Tagged in the CRM. ${sentNote(result, 'nurture_tour')}`);
        message = `Marked as a nurture lead in the CRM. ${sentNote(result, 'nurture_tour')}`;
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
        // "Not Tier A": the meeting moves to an SDR.
        if (outcome.tier === 'A' && ['verdict_wrong_B', 'verdict_wrong_C'].includes(action) && state.booking?.eventId) {
          await google.patchEvent(state.booking.eventId, { summary: `${rules.booking.title}${rules.booking.sdr_title_suffix}` });
          await say(sdr.channel, sdr.name, `${who} was marked "not Tier A" by the AE. The meeting on ${state.booking.slot} is now yours.`);
          message += ` The meeting moved to ${sdr.name}.`;
        }
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
