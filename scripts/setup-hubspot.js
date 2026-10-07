// Creates the custom properties and seeds the TEST records in HubSpot, and seeds the same
// records into the Airtable CRM table.
//   --reset          delete the TEST records first, then seed again
//   --airtable-only  skip HubSpot (for CRM_PROVIDER=airtable)
import { loadEnv } from '../lib/env.js';
import { createHubspot } from '../lib/connectors/hubspot.js';
import { createAirtable } from '../lib/connectors/airtable.js';
import { createHubspotProperties, resetHubspotSeed, seedHubspot, seedAirtableCrm } from '../lib/seed.js';

loadEnv();
const reset = process.argv.includes('--reset');
const airtableOnly = process.argv.includes('--airtable-only');
const log = (prefix) => (line) => console.log(`${prefix} ${line}`);

if (!airtableOnly) {
  const hubspot = createHubspot();
  await createHubspotProperties(hubspot, log('HubSpot '));
  if (reset) await resetHubspotSeed(hubspot, log('HubSpot '));
  await seedHubspot(hubspot, log('HubSpot '));
}

await seedAirtableCrm(createAirtable(), { reset }, log('Airtable'));
console.log('Done.');
