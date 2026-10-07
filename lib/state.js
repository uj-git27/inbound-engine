import { rules } from './rules.js';

// What the action links and the contact follow-up need later, kept on the Airtable lead row.
export function packState({ lead, outcome, channel, owner, booking, contact, drafts }) {
  const { kind, tier, score, breakdown, reason, label, unknown, lowConfidence, profile, pricing, signals, person, company, expansion, flags } = outcome;
  return JSON.stringify({
    lead,
    outcome: { kind, tier, score, breakdown, reason, label, unknown, lowConfidence, profile, pricing, signals, person, company, expansion, flags },
    channel, owner, booking: booking ?? null, contact: contact ?? {}, drafts: drafts ?? {},
  });
}

export async function loadLead(airtable, leadId) {
  const [record] = await airtable.findByField(rules.tables.leads, 'lead_id', leadId);
  if (!record) return null;
  let state = null;
  try {
    state = JSON.parse(record.fields.state_json ?? 'null');
  } catch {
    // an unreadable state is treated as missing
  }
  return { record, state };
}

export const saveState = (airtable, recordId, state, fields = {}) =>
  airtable.updateRecord(rules.tables.leads, recordId, { state_json: JSON.stringify(state), ...fields });
