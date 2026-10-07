import { rules } from './rules.js';

// Paid results are cached by domain or email for 7 days in the Airtable "Cache" table.
export function createCache(airtable) {
  const table = rules.tables.cache;
  const maxAge = rules.limits.cache_days * 86_400_000;

  async function read(kind, id) {
    const [record] = await airtable.findByField(table, 'key', `${kind}:${id}`);
    if (!record) return null;
    return { record, value: JSON.parse(record.fields.value), fresh: Date.now() - Date.parse(record.fields.stored_at) < maxAge };
  }

  return {
    // Fresh entry or null.
    async get(kind, id) {
      const hit = await read(kind, id);
      return hit?.fresh ? hit.value : null;
    },

    // Any entry, however old: used when a live call fails (labelled "cached").
    async getStale(kind, id) {
      return (await read(kind, id))?.value ?? null;
    },

    async set(kind, id, value, source) {
      const fields = { key: `${kind}:${id}`, kind, value: JSON.stringify(value), source, stored_at: new Date().toISOString() };
      const hit = await read(kind, id);
      if (hit) await airtable.updateRecord(table, hit.record.id, fields);
      else await airtable.createRecord(table, fields);
    },
  };
}
