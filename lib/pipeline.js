import { rules } from './rules.js';
import { parseTally, choiceText } from './tally.js';

const stamp = (status) => `${new Date().toISOString()} ${status}`;

// Runs after the webhook has replied 200. The Airtable status column updates after every step.
// Phase 1 stops after parsing; steps 1-9 are added in the later phases.
export async function runPipeline({ recordId, payload, connectors }) {
  const { airtable } = connectors;
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
  const fields = {
    name: lead.name ?? '',
    email: lead.email ?? '',
    title: lead.title ?? '',
    website: lead.website ?? '',
    domain: lead.domain ?? '',
    first_choice: choiceText(lead.first_choice),
    backup_choice: choiceText(lead.backup_choice),
    time_zone: lead.timezone ?? '',
  };
  if (missing.length) {
    await setStatus('parse_error', { ...fields, error: `Missing form fields: ${missing.join(', ')}` });
    return { status: 'parse_error', lead };
  }

  await setStatus('parsed', fields);
  return { status: 'parsed', lead };
}
