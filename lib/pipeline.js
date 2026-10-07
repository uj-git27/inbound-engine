import { rules } from './rules.js';
import { parseTally, choiceText } from './tally.js';
import { decide } from './engine.js';
import { customerAlert, openDealAlert, expansionAlert, disqualifiedAlert, tierAlert, lowConfidenceAlert } from './alerts.js';

const stamp = (status) => `${new Date().toISOString()} ${status}`;

// What each outcome becomes: the Airtable status and decision, and the alerts to post.
function plan(lead, outcome) {
  switch (outcome.kind) {
    case 'customer': return { status: 'routed_customer', decision: 'Existing customer', alerts: [customerAlert(lead, outcome.company)] };
    case 'open_deal': return { status: 'routed_open_deal', decision: 'Open deal', alerts: [openDealAlert(lead, outcome.company)] };
    case 'expansion': return { status: 'routed_expansion', decision: 'Expansion', alerts: [expansionAlert(lead, outcome)] };
    case 'disqualified': return { status: 'disqualified', decision: 'Disqualified', alerts: [disqualifiedAlert(lead, outcome)] };
    case 'duplicate': return { status: 'duplicate_skipped', decision: 'Duplicate', alerts: [] };
    default: return {
      status: `tier_${outcome.tier.toLowerCase()}`,
      decision: `Tier ${outcome.tier}`,
      alerts: [tierAlert(lead, outcome), ...(outcome.lowConfidence ? [lowConfidenceAlert(lead, outcome)] : [])],
    };
  }
}

// Runs after the webhook has replied 200. The Airtable status column updates after every step.
// Built so far: parse, steps 1 to 6, and the alert for each outcome. Brief, booking, signed links
// and contact enrichment come in phase 3.
export async function runPipeline({ recordId, payload, connectors }) {
  const { airtable, slack } = connectors;
  const table = rules.tables.leads;
  const timeline = [stamp('received')];

  const setStatus = (status, fields = {}) => {
    timeline.push(stamp(status));
    return airtable.updateRecord(table, recordId, { status, timeline: timeline.join('\n'), ...fields });
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
    name: lead.name ?? '',
    email: lead.email ?? '',
    title: lead.title ?? '',
    company: lead.company ?? '',
    website: lead.website ?? '',
    domain: lead.domain ?? '',
    first_choice: choiceText(lead.first_choice),
    backup_choice: choiceText(lead.backup_choice),
    time_zone: lead.timezone ?? '',
    demo: Boolean(lead.demo),
  };
  if (missing.length) {
    await setStatus('parse_error', { ...fields, error: `Missing form fields: ${missing.join(', ')}` });
    return { status: 'parse_error', lead };
  }
  await setStatus('parsed', fields);

  let outcome;
  try {
    outcome = await decide(lead, { recordId, connectors });
  } catch (err) {
    await setStatus('engine_error', { error: err.message });
    return { status: 'engine_error', lead };
  }

  const { status, decision, alerts } = plan(lead, outcome);
  const errors = [];
  for (const alert of alerts) {
    try {
      await slack.postMessage(alert.channel, alert.text);
    } catch (err) {
      errors.push(`Slack post to #${alert.channel} failed: ${err.message}`);
    }
  }

  const { calls, flags, notes } = outcome;
  await setStatus(status, {
    decision,
    reason: outcome.reason ?? '',
    tier: outcome.tier ?? '',
    ...(outcome.score === undefined ? {} : { score: outcome.score }),
    route: alerts.map((a) => `#${a.channel}`).join(', '),
    owner: alerts[0]?.owner ?? '',
    flags: [...flags, ...(outcome.lowConfidence ? ['low confidence'] : [])].join('\n'),
    paid_calls: calls.length,
    paid_calls_detail: calls.join(', '),
    notes: notes.join('\n'),
    evidence_json: JSON.stringify({ profile: outcome.profile, pricing: outcome.pricing, signals: outcome.signals, breakdown: outcome.breakdown, unknown: outcome.unknown }),
    ...(errors.length ? { error: errors.join('\n') } : {}),
  });
  return { status, lead, outcome, alerts };
}
