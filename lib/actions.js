import { rules, teamMember } from './rules.js';
import { ACTIONS } from './links.js';
import { book } from './booking.js';
import { preDemoEmail, rejectionEmail, recipient } from './emails.js';
import { tierAlert, noteAlert } from './alerts.js';
import { enrichContact } from './contact.js';
import { loadLead } from './state.js';
import { safe } from './brief.js';

const stamp = (action) => `${new Date().toISOString()} ${action}`;
const VERDICT = { verdict_right: 'Right tier', verdict_wrong_A: 'Wrong: A', verdict_wrong_B: 'Wrong: B', verdict_wrong_C: 'Wrong: C' };

// Runs one signed-link action. Idempotent: an action that already ran is reported, not repeated.
export async function runAction({ leadId, action, connectors, env = process.env }) {
  const { airtable, slack, google, crm } = connectors;
  const loaded = await loadLead(airtable, leadId);
  if (!loaded?.state) return { ok: false, message: 'This lead could not be found.' };
  const { record, state } = loaded;
  const { lead, outcome } = state;
  const done = String(record.fields.reviewer_actions ?? '').split('\n').filter(Boolean);
  const label = ACTIONS[action];

  if (VERDICT[action] && record.fields.rep_verdict) return { ok: true, message: `A verdict was already recorded: ${record.fields.rep_verdict}.` };
  if (done.some((line) => line.endsWith(` ${action}`))) return { ok: true, message: `"${label}" was already done. Nothing was repeated.` };

  const fields = {};
  const say = (channel, owner, text) => slack.postMessage(channel, noteAlert(channel, owner, text).text);
  const who = `${safe(lead.name)} at ${safe(lead.company || lead.domain)}`;
  const bookNow = async (titleSuffix = '') => {
    if (state.booking?.booked) return state.booking;
    const booking = await book({ lead, google, titleSuffix, env });
    if (!booking.booked) throw new Error(`Could not book: ${booking.reason}`);
    state.booking = booking;
    Object.assign(fields, { slot: booking.slot, event_link: booking.eventLink, event_id: booking.eventId });
    return booking;
  };
  const ctx = () => ({ lead, outcome, booking: state.booking, contact: state.contact, env });
  let message;

  try {
    switch (action) {
      case 'confirm_meeting':
      case 'confirm_anyway': {
        const already = state.booking?.booked;
        const booking = await bookNow();
        message = already ? `Already booked for ${booking.slot}.` : `Meeting booked for ${booking.slot}. The invite has been sent.`;
        if (!already) await say(state.channel, state.owner, `Meeting confirmed for ${who}: ${booking.slot}.`);
        break;
      }
      case 'send_sdr': {
        const booking = await bookNow(rules.booking.sdr_title_suffix);
        const alert = tierAlert(ctx(), 'B');
        await slack.postMessage(alert.channel, `${alert.text}\n_Sent to SDR by the reviewer._`);
        Object.assign(state, { channel: alert.channel, owner: alert.owner });
        message = `Booked for ${booking.slot} and sent to ${alert.owner} in #${alert.channel}.`;
        break;
      }
      case 'promote_ae': {
        if (!state.booking?.eventId) throw new Error('There is no booked meeting to promote.');
        await google.patchEvent(state.booking.eventId, { summary: rules.booking.title });
        state.drafts.pre_demo ??= preDemoEmail(lead, outcome, state.booking);
        const alert = tierAlert(ctx(), 'A');
        await slack.postMessage(alert.channel, `${alert.text}\n_Promoted to AE by the SDR._`);
        Object.assign(state, { channel: alert.channel, owner: alert.owner });
        message = `Promoted. The event was renamed and ${alert.owner} was alerted in #${alert.channel}.`;
        break;
      }
      case 'approve_email': {
        const draft = state.drafts.pre_demo;
        if (!draft) throw new Error('There is no drafted email for this lead.');
        const to = recipient(lead, env);
        await google.sendEmail({ to, ...draft });
        await say(state.channel, state.owner, `Pre-demo email sent to ${to} for ${who}.`);
        message = `Email sent to ${to}.`;
        break;
      }
      case 'approve_rejection': {
        const draft = state.drafts.rejection ?? rejectionEmail(lead);
        const to = recipient(lead, env);
        await google.sendEmail({ to, ...draft });
        await say(state.channel, state.owner, `Rejection email (with the product tour link) sent to ${to} for ${who}.`);
        message = `Rejection email sent to ${to}.`;
        break;
      }
      case 'nurture': {
        await crm.upsertCompany(lead.domain, { name: lead.company, lifecyclestage: 'lead', nurture: 'nurture' });
        await say(state.channel, state.owner, `${who} moved to nurture in the CRM. No email was sent.`);
        message = 'Marked as a nurture lead in the CRM. No email was sent.';
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
          const sdr = teamMember('sdr');
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
    reviewer_actions: [...done, stamp(action)].join('\n'),
    state_json: JSON.stringify(state),
  });
  return { ok: true, message };
}
