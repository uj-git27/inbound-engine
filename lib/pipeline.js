import { rules } from './rules.js';
import { parseTally, choiceText } from './tally.js';
import { customerAlert, openDealAlert, loggedAlert } from './alerts.js';

const stamp = (status) => `${new Date().toISOString()} ${status}`;

// Runs after the webhook has replied 200. The Airtable status column updates after every step.
// Built so far: parse, demo alias, step 2 (already know them?). Steps 1 and 3-9 come in later phases.
export async function runPipeline({ recordId, payload, connectors }) {
  const { airtable, slack, crm } = connectors;
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

  // Step 2: already know them? Exact domain match in the CRM (free).
  let company = null;
  try {
    company = lead.domain ? await crm.lookupCompany(lead.domain) : null;
  } catch (err) {
    await setStatus('crm_error', { error: `CRM lookup failed: ${err.message}` });
  }

  let outcome;
  if (company?.isCustomer) {
    outcome = { status: 'routed_customer', decision: 'Existing customer', alert: customerAlert(lead, company) };
  } else if (company?.openDeal) {
    outcome = { status: 'routed_open_deal', decision: 'Open deal', alert: openDealAlert(lead, company) };
  } else {
    outcome = { status: 'awaiting_scoring', decision: '', alert: loggedAlert(lead, company) };
  }

  const { alert } = outcome;
  try {
    await slack.postMessage(alert.channel, alert.text);
  } catch (err) {
    await setStatus('slack_error', { error: `Slack post to #${alert.channel} failed: ${err.message}` });
    return { status: 'slack_error', lead };
  }
  await setStatus(outcome.status, {
    decision: outcome.decision,
    route: `#${alert.channel}`,
    owner: alert.owner,
    reason: company ? `CRM match on ${lead.domain}: ${company.name}` : `No CRM record for ${lead.domain}`,
  });
  return { status: outcome.status, lead, alert };
}
