// Seeds the TEST activity history in HubSpot from data/crm-history.json. Safe to re-run: a record
// with the same kind, date and text on the same company is left alone.
//   node scripts/seed-history.js
// Every person is fake, every record starts with "TEST:", and dates are backdated with hs_timestamp.
import { readFileSync } from 'node:fs';
import { loadEnv } from '../lib/env.js';
import { teamMember } from '../lib/rules.js';
import { createHubspot } from '../lib/connectors/hubspot.js';
import { seedHubspot } from '../lib/seed.js';
import { HISTORY_OBJECTS, linkedRecords } from '../lib/crm.js';

loadEnv();
const hubspot = createHubspot();
const history = JSON.parse(readFileSync(new URL('../data/crm-history.json', import.meta.url), 'utf8'));
const log = (line) => console.log(`HubSpot  ${line}`);

// kind -> HubSpot object, the property that holds its text, and the "to company" association ID.
const KINDS = {
  email: { object: 'emails', text: 'hs_email_subject', association: 186 },
  call: { object: 'calls', text: 'hs_call_title', association: 182 },
  meeting: { object: 'meetings', text: 'hs_meeting_title', association: 188 },
  note: { object: 'notes', text: 'hs_note_body', association: 190 },
};
const stamp = (date) => `${date}T15:00:00.000Z`;
const strip = (html) => String(html ?? '').replace(/<[^>]*>/g, '').trim();

// The engine's owner field on each activity object: the fake team members are not HubSpot users.
for (const { object } of Object.values(KINDS)) {
  const groups = await hubspot.request(`/crm/v3/properties/${object}/groups`);
  try {
    await hubspot.request(`/crm/v3/properties/${object}`, {
      method: 'POST',
      body: { name: 'ie_owner_name', label: 'Inbound engine: owner name', type: 'string', fieldType: 'text', groupName: groups.json.results[0].name },
    });
    log(`property ${object}.ie_owner_name: created`);
  } catch (err) {
    if (err.status !== 409) throw err;
    log(`property ${object}.ie_owner_name: exists`);
  }
}

// Companies first (existing ones are skipped), then their activity.
await seedHubspot(hubspot, log);

for (const [domain, plan] of Object.entries(history)) {
  const [company] = await hubspot.searchCompaniesByDomain(domain);
  if (!company) throw new Error(`${domain} is not in HubSpot`);
  let created = 0;
  for (const [kind, k] of Object.entries(KINDS)) {
    const wanted = plan.items.filter((i) => i.type === kind);
    if (!wanted.length) continue;
    const existing = await linkedRecords(hubspot, company.id, k.object, HISTORY_OBJECTS[k.object]);
    for (const item of wanted) {
      const text = item.title ?? item.body;
      if (existing.some((e) => e.properties.hs_timestamp?.slice(0, 10) === item.date && strip(e.properties[k.text]) === text)) continue;
      const properties = { hs_timestamp: stamp(item.date), [k.text]: text, ie_owner_name: teamMember(item.owner_role).name };
      if (kind === 'email') Object.assign(properties, { hs_email_direction: 'EMAIL', hs_email_status: 'SENT', hs_email_text: item.status === 'OPENED' ? 'TEST: opened, no reply.' : 'TEST email.' });
      if (kind === 'call') properties.hs_call_status = item.status;
      if (kind === 'meeting') Object.assign(properties, { hs_meeting_outcome: item.status, hs_meeting_start_time: stamp(item.date), hs_meeting_end_time: `${item.date}T15:30:00.000Z` });
      await hubspot.request(`/crm/v3/objects/${k.object}`, {
        method: 'POST',
        body: { properties, associations: [{ to: { id: company.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: k.association }] }] },
      });
      created += 1;
    }
  }
  // The close date of a lost deal is part of its history.
  if (plan.deal?.closed_at) {
    for (const deal of await linkedRecords(hubspot, company.id, 'deals', HISTORY_OBJECTS.deals)) {
      if (deal.properties.closedate?.slice(0, 10) === plan.deal.closed_at) continue;
      await hubspot.request(`/crm/v3/objects/deals/${deal.id}`, { method: 'PATCH', body: { properties: { closedate: stamp(plan.deal.closed_at) } } });
      log(`${domain}: deal "${deal.properties.dealname}" close date set to ${plan.deal.closed_at}`);
    }
  }
  log(`${domain}: ${created} record${created === 1 ? '' : 's'} created, ${plan.items.length - created} already there`);
}
console.log('Done.');
