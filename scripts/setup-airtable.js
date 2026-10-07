// Creates the Leads, Cache and CRM tables. Safe to re-run: existing tables are kept and
// only missing fields are added.
import { loadEnv } from '../lib/env.js';
import { createAirtable } from '../lib/connectors/airtable.js';
import { tableDefinitions } from '../lib/airtable-schema.js';

loadEnv();
const airtable = createAirtable();
const existing = await airtable.listTables();

for (const definition of tableDefinitions) {
  const table = existing.find((t) => t.name === definition.name);
  if (!table) {
    await airtable.createTable(definition);
    console.log(`OK   ${definition.name}: created with ${definition.fields.length} fields`);
    continue;
  }
  const have = new Set(table.fields.map((f) => f.name));
  const toAdd = definition.fields.filter((f) => !have.has(f.name));
  for (const field of toAdd) await airtable.createField(table.id, field);
  console.log(`OK   ${definition.name}: exists, ${toAdd.length ? `added ${toAdd.map((f) => f.name).join(', ')}` : 'no fields missing'}`);
}
