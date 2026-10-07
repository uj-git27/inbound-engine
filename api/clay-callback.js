import { rules } from '../lib/rules.js';
import { verifyToken } from '../lib/token.js';
import { getConnectors } from '../lib/connectors/index.js';

const reply = (status, body) => Response.json(body, { status });

const clean = (value) => {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text.trim().slice(0, 1000);
};

// Clay's HTTP API column posts the enriched person here. Callback text is data only.
// The Slack follow-up ("Contact found") is added with routing in phase 3.
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

  const { airtable } = getConnectors();
  const table = rules.tables.leads;
  const [record] = await airtable.findByField(table, 'lead_id', body.lead_id);
  if (!record) return reply(404, { ok: false, error: 'unknown lead' });

  const { token, ...payload } = body;
  const fields = { clay_payload: JSON.stringify(payload) };
  const person = {
    linkedin: clean(body.linkedin),
    person_title: clean(body.title),
    role_start: clean(body.role_start),
    previous_companies: clean(body.previous_companies),
  };
  if (Object.values(person).some(Boolean)) Object.assign(fields, person, { person_source: 'Clay' });
  if (clean(body.phone)) Object.assign(fields, { phone: clean(body.phone), phone_source: clean(body.phone_source) || 'Clay' });

  await airtable.updateRecord(table, record.id, fields);
  return reply(200, { ok: true });
}
