import { rules } from './rules.js';
import { parseTally } from './tally.js';
import { applyAlias } from './alias.js';
import { freeChecks } from './checks.js';
import { decide } from './engine.js';
import { sendTemplate } from './emails.js';
import { packState } from './state.js';
import { getHistory } from './history.js';
import { createCache } from './cache.js';
import { enrichContact } from './contact.js';
import { tryBook, finalizeBooking, bookingFields } from './booking-flow.js';
import {
  customerAlert, openDealAlert, closedLostAlert, expansionAlert, disqualifiedAlert, tierAlert, lowConfidenceAlert, rateLimitedAlert,
  engineErrorAlert, duplicateAlert, postAlert,
} from './alerts.js';

export { aliasDomain } from './alias.js';

const HISTORY_KINDS = ['tiered', 'customer', 'open_deal', 'closed_lost', 'expansion'];
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

// Step 8: route. Returns the alerts to post. Booking is separate: a Tier A or B meeting is booked
// once the lead is qualified AND has picked a time, whichever comes second (see booking-flow.js).
// `mail` collects which email templates were sent.
async function route({ lead, outcome, connectors, env, mail, notes }) {
  const ctx = { lead, outcome, env };
  const { google } = connectors;
  // Templates only, sent at most once each; a failed send is logged and never blocks the alert.
  const send = async (template) => {
    try {
      return await sendTemplate(template, { lead, outcome, state: mail, google, env });
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
      // Contact enrichment runs after the brief, for A and B, never for demo aliases.
      const contact = { pending: outcome.tier !== 'C' && !lead.demo, skipped: Boolean(lead.demo) };
      const note = outcome.tier === 'C' ? `No email is sent until you act. Untouched for ${hours} hours, this lead defaults to nurture.` : null;
      return { alerts: [tierAlert({ ...ctx, contact, note }), ...low], contact };
    }
  }
}

// Step 9: save to the CRM. A company that was not in the CRM is created with what the engine
// learned (profile, score, tier, reasons, signal links), and the person is saved as a contact
// linked to it, with how they heard about us. Failures are logged, never fatal.
async function saveToCrm({ lead, outcome, crm, notes }) {
  if (outcome.kind !== 'tiered') return;
  try {
    const p = outcome.profile ?? {};
    await crm.upsertCompany(lead.domain, {
      name: outcome.company?.name || p.name || lead.company,
      headcount: p.headcount_source ? undefined : p.headcount_max, country: p.country_source ? undefined : p.country, industry: p.industry_source ? undefined : p.industry,
      score: outcome.score, tier: outcome.tier, reasons: outcome.reason,
      signal_links: (outcome.signals ?? []).map((s) => `${s.date} ${s.type}: ${s.url}`).join('\n'),
      parent_domain: p.parent?.domain, funding_stage: p.funding_stage,
    });
    await crm.upsertContact({ email: lead.email, name: lead.name, title: lead.title, tier: outcome.tier, lead_source: lead.lead_source, domain: lead.domain });
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
  const { missing } = parsed;
  const lead = applyAlias(parsed.lead);

  const fields = {
    name: lead.name ?? '', email: lead.email ?? '', title: lead.title ?? '', domain: lead.domain ?? '',
    employees_reported: lead.employees ?? '', industry_reported: lead.industry ?? '', country_reported: lead.country ?? '', in_their_words: lead.help ?? '', lead_source: lead.lead_source ?? '',
    demo: Boolean(lead.demo),
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
    await setStatus('decided', { decision: outcome.kind === 'tiered' ? `Tier ${outcome.tier}` : STATUS[outcome.kind][1], reason: outcome.reason ?? '', company: lead.company ?? '' });
    // CRM history for every card about a company the CRM knows; for an expansion lead, the parent's.
    const known = outcome.kind === 'expansion' ? outcome.expansion?.domain : outcome.company ? lead.domain : null;
    if (known && HISTORY_KINDS.includes(outcome.kind)) {
      outcome.history = await getHistory({ crm: connectors.crm, cache: createCache(connectors.airtable), domain: known, notes: outcome.notes });
    }
    routed = await route({ lead, outcome, connectors, env, mail, notes: outcome.notes });
  } catch (err) {
    // Fail open: an unexpected error after the free checks still books the meeting.
    if (freeChecks(lead).disqualified) {
      await setStatus('engine_error', { error: err.message });
      return { status: 'engine_error', lead };
    }
    const [row] = await airtable.findByField(table, 'lead_id', lead.lead_id).catch(() => []);
    const booking = await tryBook({ lead, google, requested: row?.fields.requested_slot || null, buyerZone: row?.fields.buyer_tz || null, env });
    await post([engineErrorAlert({ lead, error: err.message, booking })], errors);
    await setStatus('engine_error_failed_open', {
      decision: 'Engine error (fail open)', route: `#${rules.team.revops.channel}`, owner: rules.team.revops.name,
      ...bookingFields(booking), error: [err.message, ...errors].join('\n'),
    });
    return { status: 'engine_error_failed_open', lead, booking };
  }

  const { alerts, contact } = routed;
  const thread = await post(alerts, errors);
  await saveToCrm({ lead, outcome, crm, notes: outcome.notes });

  const [status, decision] = outcome.kind === 'tiered' ? [`tier_${outcome.tier.toLowerCase()}`, `Tier ${outcome.tier}`] : STATUS[outcome.kind];
  const main = alerts[0];
  await setStatus(status, {
    decision,
    company: lead.company ?? '',
    reason: outcome.reason ?? '',
    tier: outcome.tier ?? '',
    ...(outcome.score === undefined ? {} : { score: outcome.score }),
    route: [...new Set(alerts.map((a) => `#${a.channel}`))].join(', '),
    owner: main?.owner ?? '',
    flags: [...outcome.flags, ...(outcome.lowConfidence ? ['low confidence'] : [])].join('\n'),
    paid_calls: outcome.calls.length,
    paid_calls_detail: outcome.calls.join(', '),
    brief: main?.body ?? '',
    emails_log: mail.email_log.join('\n'),
    notes: outcome.notes.join('\n'),
    evidence_json: JSON.stringify({ profile: outcome.profile, pricing: outcome.pricing, signals: outcome.signals, growth: outcome.growth, history: outcome.history, person: outcome.person, breakdown: outcome.breakdown, unknown: outcome.unknown }),
    state_json: packState({ lead, outcome, channel: main?.channel, owner: main?.owner, contact, thread, mail }),
    ...(errors.length ? { error: errors.join('\n') } : {}),
  });

  // Tier A and B: if the lead has already picked a time, this books it now. If not, the pick
  // (or the 15-minute fallback) books it later.
  let booked = null;
  if (outcome.kind === 'tiered' && outcome.tier !== 'C') {
    try {
      booked = await finalizeBooking({ leadId: lead.lead_id, connectors, env, trigger: 'qualified' });
      if (booked.status === 'waiting_for_pick') await connectors.scheduleSweep(Date.now() + rules.booking.no_pick_minutes * 60_000 + 5000);
    } catch (err) {
      await airtable.updateRecord(table, recordId, { error: [...errors, `Booking step failed: ${err.message}`].join('\n') });
    }
  }

  // Step 6b, after the brief: A and B only, and never for demo aliases.
  if (contact?.pending) {
    try {
      await enrichContact({ leadId: lead.lead_id, connectors, env, waitForClay: Boolean(outcome.personPending) });
    } catch (err) {
      await airtable.updateRecord(table, recordId, { error: [...errors, `Contact enrichment failed: ${err.message}`].join('\n') });
    }
  }
  return { status, lead, outcome, alerts, booking: booked?.booking ?? null, booked, mail };
}
