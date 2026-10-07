import { rules } from '../lib/rules.js';
import { verifyToken } from '../lib/token.js';
import { getConnectors } from '../lib/connectors/index.js';
import { contactFields } from '../lib/contact.js';
import { contactFoundAlert } from '../lib/alerts.js';

const reply = (status, body) => Response.json(body, { status });

const clean = (value) => {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text.trim().slice(0, 1000);
};

// Clay's HTTP API column posts the enriched person here. Callback text is data only.
// Saves the contact to the Airtable lead (labelled "Clay") and posts a follow-up to the same channel.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return reply(400, { ok: false, error: 'body is not JSON' });
  }
  if (!verifyToken('clay', body?.lead_id, body?.token)) {
    return reply(401, { ok: false, error: 'bad token' });
  }

  const { airtable, slack } = getConnectors();
  const table = rules.tables.leads;
  const [record] = await airtable.findByField(table, 'lead_id', body.lead_id);
  if (!record) return reply(404, { ok: false, error: 'unknown lead' });

  const { token, ...payload } = body;
  const contact = { pending: false };
  const person = {
    linkedin: clean(body.linkedin) || null,
    title: clean(body.title) || null,
    role_start: clean(body.role_start) || null,
    previous_companies: clean(body.previous_companies) ? clean(body.previous_companies).split(/,\s*/) : [],
    source: 'Clay',
  };
  if (person.linkedin || person.title || person.role_start || person.previous_companies.length) contact.person = person;
  if (clean(body.phone)) Object.assign(contact, { phone: clean(body.phone), phone_source: clean(body.phone_source) || 'Clay' });

  let state = null;
  try {
    state = JSON.parse(record.fields.state_json ?? 'null');
  } catch {
    // no saved state: the contact is still stored on the row
  }
  const fields = contactFields(contact, process.env, { clay_payload: JSON.stringify(payload) });
  if (state) {
    state.contact = { ...state.contact, ...contact };
    fields.state_json = JSON.stringify(state);
  }
  await airtable.updateRecord(table, record.id, fields);

  if (state?.channel) {
    const followUp = contactFoundAlert({ channel: state.channel, lead: state.lead, contact, env: process.env });
    await slack.postMessage(followUp.channel, followUp.text);
  }
  return reply(200, { ok: true });
}
