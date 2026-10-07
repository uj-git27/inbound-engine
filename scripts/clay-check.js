// Sends one test row to the Clay webhook, then waits for Clay to call /api/clay-callback on the
// deployed app and prints the payload it received.
//   node scripts/clay-check.js --name="Jane Doe" --email=jane@acme.com --domain=acme.com --title=CFO
// Needs CLAY_WEBHOOK_URL, LINK_SECRET, AIRTABLE_TOKEN and AIRTABLE_BASE_ID in .env, the app deployed
// with the same LINK_SECRET, and the Clay table's HTTP API column pointing at BASE_URL/api/clay-callback.
import { loadEnv } from '../lib/env.js';
import { rules } from '../lib/rules.js';
import { createAirtable } from '../lib/connectors/airtable.js';
import { createClay, clayRow } from '../lib/connectors/clay.js';

loadEnv();
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const lead = {
  lead_id: `clay-test-${Date.now()}`,
  name: arg('name'),
  email: arg('email'),
  domain: arg('domain'),
  title: arg('title'),
};
const absent = ['name', 'email', 'domain', 'title'].filter((k) => !lead[k]);
if (absent.length) {
  console.log(`Missing --${absent.join(', --')}. Example:\n  node scripts/clay-check.js --name="Jane Doe" --email=jane@acme.com --domain=acme.com --title=CFO`);
  process.exit(1);
}

const WAIT_SECONDS = 180;
const airtable = createAirtable();
const table = rules.tables.leads;

const record = await airtable.createRecord(table, {
  lead_id: lead.lead_id,
  status: 'clay_test',
  received_at: new Date().toISOString(),
  name: lead.name,
  email: lead.email,
  domain: lead.domain,
  title: lead.title,
});
console.log(`Airtable test row created: ${lead.lead_id}`);

const { token, ...shown } = clayRow(lead);
console.log('Row sent to Clay (token hidden):', JSON.stringify(shown));
console.log('Clay webhook replied:', JSON.stringify(await createClay().sendRow(lead)));

console.log(`Waiting up to ${WAIT_SECONDS}s for the callback at ${process.env.BASE_URL}/api/clay-callback ...`);
const started = Date.now();
while (Date.now() - started < WAIT_SECONDS * 1000) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const [row] = await airtable.findByField(table, 'lead_id', lead.lead_id);
  if (row?.fields.clay_payload) {
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`\nOK   callback received after about ${seconds}s. Payload:\n`);
    console.log(JSON.stringify(JSON.parse(row.fields.clay_payload), null, 2));
    console.log('\nSaved to the lead:', JSON.stringify({
      linkedin: row.fields.linkedin, person_title: row.fields.person_title, role_start: row.fields.role_start,
      previous_companies: row.fields.previous_companies, person_source: row.fields.person_source,
      phone: row.fields.phone, phone_source: row.fields.phone_source,
    }, null, 2));
    process.exit(0);
  }
}
console.log(`\nFAIL no callback within ${WAIT_SECONDS}s. Check the Clay table: did the row arrive, did the enrichment run, and did the HTTP API column fire? Test row ${record.id} is still in Airtable.`);
process.exit(1);
