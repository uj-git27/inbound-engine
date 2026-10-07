import { rules } from './rules.js';
import { parseTally, choiceText } from './tally.js';
import { freeChecks } from './checks.js';
import { decide } from './engine.js';
import { book } from './booking.js';
import { sendTemplate } from './emails.js';
import { packState } from './state.js';
import { enrichContact } from './contact.js';
import {
  customerAlert, openDealAlert, closedLostAlert, expansionAlert, disqualifiedAlert, tierAlert, lowConfidenceAlert, rateLimitedAlert,
  engineErrorAlert, duplicateAlert, postAlert,
} from './alerts.js';

const stamp = (status) => `${new Date().toISOString()} ${status}`;
const STATUS = {
  customer: ['routed_customer', 'Existing customer'],
  open_deal: ['routed_open_deal', 'Open deal'],
  closed_lost: ['routed_closed_lost', 'Returning (closed lost)'],
  expansion: ['routed_expansion', 'Expansion'],
  disqualified: ['disqualified', 'Disqualified'],
  duplicate: ['duplicate_skipped', 'Duplicate'],
  rate_limited: ['rate_limited', 'Rate limited'],
};

// "jainutsav67+newrelic.com@gmail.com" stands in for newrelic.com: any company, without adding
// it to rules.json first. The mailbox it belongs to is set in rules.json (demo_alias_mailbox).
export function aliasDomain(email) {
  const [user, host] = rules.demo_alias_mailbox.split('@');
  const m = new RegExp(`^${user}\\+([a-z0-9-]+(?:\\.[a-z0-9-]+)+)@${host.replace(/\./g, '\\.')}$`).exec(email ?? '');
  return m ? m[1] : null;
}

export const tryBook = async (args) => {
  try {
    return await book(args);
  } catch (err) {
    const notConnected = /Missing env var (GOOGLE_|SMTP_)/.test(err.message);
    return { booked: false, reason: notConnected ? 'calendar and email are not connected yet' : err.message };
  }
};

// Step 8: book and route. Returns the alerts to post, what was booked, and any message to add
// in the main alert's thread. `mail` collects which templates were sent.
async function route({ lead, outcome, connectors, env, mail, notes }) {
  const ctx = { lead, outcome, env };
  const { google } = connectors;
  // Templates only, sent at most once each; a failed send is logged and never blocks the alert.
  const send = async (template, booking) => {
    try {
      return await sendTemplate(template, { lead, outcome, booking, state: mail, google, env });
    } catch (err) {
      notes.push(`Email "${template}" failed: ${err.message}`);
      return { sent: false, why: `sending failed (${err.message})` };
    }
  };
  const hours = rules.emails.untouched_hours_before_nurture;

  switch (outcome.kind) {
    case 'customer': return { alerts: [customerAlert(ctx)] };
    case 'open_deal': return { alerts: [openDealAlert(ctx)] };
    case 'closed_lost': return { alerts: [closedLostAlert(ctx)] };
    case 'expansion': return { alerts: [expansionAlert(ctx)] };
    case 'rate_limited': return { alerts: [rateLimitedAlert(ctx)] };
    // Skipped, with no email, but RevOps is told so that no request ever disappears silently.
    case 'duplicate': return { alerts: [duplicateAlert(ctx)] };
    case 'disqualified': {
      // A slam-dunk rejection rests only on what the lead typed, so its email goes out by itself.
      // One based on looked-up data (headcount, region, B2B) waits for the reviewer.
      const template = rules.emails.auto_rejections[outcome.category];
      let emailNote = `This rejection rests on looked-up data, so no email goes out until you act. Untouched for ${hours} hours, the lead moves to nurture.`;
      if (template) {
        const result = await send(template);
        emailNote = result.sent ? `The "${template}" email was sent automatically.` : `No email: ${result.why}.`;
      }
      return { alerts: [disqualifiedAlert({ ...ctx, emailNote })] };
    }
    default: {
      const low = outcome.lowConfidence ? [lowConfidenceAlert(ctx)] : [];
      // Contact enrichment runs after the invite and brief, for A and B, never for demo aliases.
      const contact = { pending: outcome.tier !== 'C' && !lead.demo, skipped: Boolean(lead.demo) };
      if (outcome.tier === 'C') {
        const note = `No email is sent until you act. Untouched for ${hours} hours, this lead defaults to nurture.`;
        return { alerts: [tierAlert({ ...ctx, contact, note }), ...low], contact };
      }
      if (outcome.tier === 'B') {
        // Booked on the AE's calendar with the SDR as task owner. Only the invite goes out now.
        const booking = await tryBook({ lead, google, titleSuffix: rules.booking.sdr_title_suffix, env });
        const note = booking.booked ? 'Only the calendar invite has gone out. "Confirm meeting" sends the confirmation from the AE; "Not qualified" cancels the meeting.' : null;
        return { alerts: [tierAlert({ ...ctx, booking, contact, note }), ...low], booking, contact };
      }
      // Tier A: booked, then the confirmation goes out automatically. No SDR step.
      const booking = await tryBook({ lead, google, env });
      const result = booking.booked ? await send('tier_a_confirm', booking) : { sent: false };
      const threadNote = result.sent ? `Confirmation sent to ${result.email.to} (template "tier_a_confirm", from ${result.email.fromName}).` : booking.booked ? `Confirmation not sent: ${result.why}.` : null;
      return { alerts: [tierAlert({ ...ctx, booking, contact }), ...low], booking, contact, threadNote };
    }
  }
}

// Step 9: save to the CRM. Failures are logged, never fatal.
async function saveToCrm({ lead, outcome, crm, notes }) {
  if (outcome.kind !== 'tiered') return;
  try {
    await crm.upsertCompany(lead.domain, {
      name: outcome.company?.name || outcome.profile?.name || lead.company,
      score: outcome.score, tier: outcome.tier, reasons: outcome.reason,
      signal_links: (outcome.signals ?? []).map((s) => `${s.date} ${s.type}: ${s.url}`).join('\n'),
      parent_domain: outcome.profile?.parent?.domain, funding_stage: outcome.profile?.funding_stage,
    });
    await crm.upsertContact({ email: lead.email, name: lead.name, title: lead.title, tier: outcome.tier });
  } catch (err) {
    notes.push(`CRM save failed: ${err.message}`);
  }
}

// Runs after the webhook has replied 200. The Airtable status column updates after every step.
export async function runPipeline({ recordId, payload, connectors, env = process.env }) {
  const { airtable, slack, crm, google } = connectors;
  const table = rules.tables.leads;
  const timeline = [stamp('received')];
  const setStatus = (status, fields = {}) => {
    timeline.push(stamp(status));
    return airtable.updateRecord(table, recordId, { status, timeline: timeline.join('\n'), ...fields });
  };
  // Posts every alert; returns Slack's reply to the first one, used for thread replies.
  const post = async (alerts, errors) => {
    let first = null;
    for (const alert of alerts) {
      try {
        const reply = await postAlert(slack, alert, env);
        first ??= reply?.ts ? { channel: reply.channel, ts: reply.ts } : null;
      } catch (err) {
        errors.push(`Slack post to #${alert.channel} failed: ${err.message}`);
      }
    }
    return first;
  };

  let parsed;
  try {
    parsed = parseTally(payload);
  } catch (err) {
    await setStatus('parse_error', { error: err.message });
    return { status: 'parse_error' };
  }
  const { lead, missing } = parsed;
  // Demo aliases map an email to a company domain and tag the row DEMO.
  // A fixed alias from rules.json, or the general form you+<company domain>@gmail.com.
  const alias = rules.demo_aliases[lead.email] ?? aliasDomain(lead.email);
  if (alias) Object.assign(lead, { domain: alias, demo: true });

  const fields = {
    name: lead.name ?? '', email: lead.email ?? '', title: lead.title ?? '', company: lead.company ?? '',
    website: lead.website ?? '', domain: lead.domain ?? '', first_choice: choiceText(lead.first_choice),
    backup_choice: choiceText(lead.backup_choice), time_zone: lead.timezone ?? '', demo: Boolean(lead.demo),
  };
  if (missing.length) {
    await setStatus('parse_error', { ...fields, error: `Missing form fields: ${missing.join(', ')}` });
    return { status: 'parse_error', lead };
  }
  await setStatus('parsed', fields);

  const errors = [];
  const mail = { sent: {}, email_log: [] };
  let outcome;
  let routed;
  try {
    outcome = await decide(lead, { recordId, connectors });
    await setStatus('decided', { decision: outcome.kind === 'tiered' ? `Tier ${outcome.tier}` : STATUS[outcome.kind][1], reason: outcome.reason ?? '' });
    routed = await route({ lead, outcome, connectors, env, mail, notes: outcome.notes });
  } catch (err) {
    // Fail open: an unexpected error after the free checks still books the meeting.
    if (freeChecks(lead).disqualified) {
      await setStatus('engine_error', { error: err.message });
      return { status: 'engine_error', lead };
    }
    const booking = await tryBook({ lead, google, env });
    await post([engineErrorAlert({ lead, error: err.message, booking })], errors);
    await setStatus('engine_error_failed_open', {
      decision: 'Engine error (fail open)', route: `#${rules.team.revops.channel}`, owner: rules.team.revops.name,
      slot: booking.booked ? booking.slot : '', event_link: booking.eventLink ?? '', event_id: booking.eventId ?? '',
      error: [err.message, ...errors].join('\n'),
    });
    return { status: 'engine_error_failed_open', lead, booking };
  }

  const { alerts, booking, contact, threadNote } = routed;
  const thread = await post(alerts, errors);
  if (threadNote && thread) {
    try {
      await slack.postMessage(alerts[0].channel, threadNote, { thread });
    } catch (err) {
      errors.push(`Slack thread reply failed: ${err.message}`);
    }
  }
  await saveToCrm({ lead, outcome, crm, notes: outcome.notes });

  const [status, decision] = outcome.kind === 'tiered' ? [`tier_${outcome.tier.toLowerCase()}`, `Tier ${outcome.tier}`] : STATUS[outcome.kind];
  const main = alerts[0];
  if (booking && !booking.booked) errors.push(`Not booked: ${booking.reason}`);
  await setStatus(status, {
    decision,
    reason: outcome.reason ?? '',
    tier: outcome.tier ?? '',
    ...(outcome.score === undefined ? {} : { score: outcome.score }),
    route: [...new Set(alerts.map((a) => `#${a.channel}`))].join(', '),
    owner: main?.owner ?? '',
    flags: [...outcome.flags, ...(outcome.lowConfidence ? ['low confidence'] : [])].join('\n'),
    paid_calls: outcome.calls.length,
    paid_calls_detail: outcome.calls.join(', '),
    slot: booking?.booked ? booking.slot : '',
    event_link: booking?.eventLink ?? '',
    event_id: booking?.eventId ?? '',
    brief: main?.body ?? '',
    emails_log: mail.email_log.join('\n'),
    notes: outcome.notes.join('\n'),
    evidence_json: JSON.stringify({ profile: outcome.profile, pricing: outcome.pricing, signals: outcome.signals, person: outcome.person, breakdown: outcome.breakdown, unknown: outcome.unknown }),
    state_json: packState({ lead, outcome, channel: main?.channel, owner: main?.owner, booking, contact, thread, mail }),
    ...(errors.length ? { error: errors.join('\n') } : {}),
  });

  // Step 6b, after the invite and brief: A and B only, and never for demo aliases.
  if (contact?.pending) {
    try {
      await enrichContact({ leadId: lead.lead_id, connectors, env, waitForClay: Boolean(outcome.personPending) });
    } catch (err) {
      await airtable.updateRecord(table, recordId, { error: [...errors, `Contact enrichment failed: ${err.message}`].join('\n') });
    }
  }
  return { status, lead, outcome, alerts, booking, mail };
}
