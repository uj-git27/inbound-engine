import { rules } from './rules.js';
import { parseTally, choiceText } from './tally.js';
import { freeChecks } from './checks.js';
import { decide } from './engine.js';
import { book } from './booking.js';
import { preDemoEmail, rejectionEmail } from './emails.js';
import { packState } from './state.js';
import { enrichContact } from './contact.js';
import {
  customerAlert, openDealAlert, expansionAlert, disqualifiedAlert, tierAlert, lowConfidenceAlert, rateLimitedAlert, engineErrorAlert, duplicateAlert,
} from './alerts.js';

const stamp = (status) => `${new Date().toISOString()} ${status}`;
const STATUS = {
  customer: ['routed_customer', 'Existing customer'],
  open_deal: ['routed_open_deal', 'Open deal'],
  expansion: ['routed_expansion', 'Expansion'],
  disqualified: ['disqualified', 'Disqualified'],
  duplicate: ['duplicate_skipped', 'Duplicate'],
  rate_limited: ['rate_limited', 'Rate limited'],
};

const tryBook = async (args) => {
  try {
    return await book(args);
  } catch (err) {
    const notConnected = /Missing env var (GOOGLE_|GMAIL_)/.test(err.message);
    return { booked: false, reason: notConnected ? 'calendar and email are not connected yet' : err.message };
  }
};

// Step 8: book and route. Returns the alerts to post plus what was booked and drafted.
async function route({ lead, outcome, connectors, env }) {
  const ctx = { lead, outcome, env };
  const { google } = connectors;
  switch (outcome.kind) {
    case 'customer': return { alerts: [customerAlert(ctx)], drafts: {} };
    case 'open_deal': return { alerts: [openDealAlert(ctx)], drafts: {} };
    case 'expansion': return { alerts: [expansionAlert(ctx)], drafts: {} };
    case 'disqualified': return { alerts: [disqualifiedAlert(ctx)], drafts: { rejection: rejectionEmail(lead) } };
    case 'rate_limited': return { alerts: [rateLimitedAlert(ctx)], drafts: {} };
    // Skipped, but RevOps is told so that no request ever disappears silently.
    case 'duplicate': return { alerts: [duplicateAlert(ctx)], drafts: {} };
    default: {
      const low = outcome.lowConfidence ? [lowConfidenceAlert(ctx)] : [];
      // Contact enrichment runs after the invite and brief, for A and B, never for demo aliases.
      const contact = { pending: outcome.tier !== 'C' && !lead.demo, skipped: Boolean(lead.demo) };
      if (outcome.tier === 'C') {
        return { alerts: [tierAlert({ ...ctx, contact }), ...low], drafts: { rejection: rejectionEmail(lead) }, contact };
      }
      const booking = await tryBook({ lead, google, titleSuffix: outcome.tier === 'B' ? rules.booking.sdr_title_suffix : '', env });
      const drafts = outcome.tier === 'A' ? { pre_demo: preDemoEmail(lead, outcome, booking) } : {};
      return { alerts: [tierAlert({ ...ctx, booking, contact }), ...low], booking, drafts, contact };
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
  const post = async (alerts, errors) => {
    for (const alert of alerts) {
      try {
        await slack.postMessage(alert.channel, alert.text);
      } catch (err) {
        errors.push(`Slack post to #${alert.channel} failed: ${err.message}`);
      }
    }
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
  const alias = rules.demo_aliases[lead.email];
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
  let outcome;
  let routed;
  try {
    outcome = await decide(lead, { recordId, connectors });
    await setStatus('decided', { decision: outcome.kind === 'tiered' ? `Tier ${outcome.tier}` : STATUS[outcome.kind][1], reason: outcome.reason ?? '' });
    routed = await route({ lead, outcome, connectors, env });
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

  const { alerts, booking, drafts, contact } = routed;
  await post(alerts, errors);
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
    brief: main?.text ?? '',
    drafts: JSON.stringify(drafts),
    notes: outcome.notes.join('\n'),
    evidence_json: JSON.stringify({ profile: outcome.profile, pricing: outcome.pricing, signals: outcome.signals, person: outcome.person, breakdown: outcome.breakdown, unknown: outcome.unknown }),
    state_json: packState({ lead, outcome, channel: main?.channel, owner: main?.owner, booking, contact, drafts }),
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
  return { status, lead, outcome, alerts, booking };
}
