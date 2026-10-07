import { http } from '../http.js';
import { need } from '../env.js';

const API = 'https://api.airtable.com/v0';

export function createAirtable(env = process.env) {
  const headers = () => ({ authorization: `Bearer ${need('AIRTABLE_TOKEN', env)}` });
  const base = () => need('AIRTABLE_BASE_ID', env);
  const tableUrl = (table) => `${API}/${base()}/${encodeURIComponent(table)}`;

  return {
    async createRecord(table, fields, { timeoutMs } = {}) {
      const res = await http(tableUrl(table), { method: 'POST', headers: headers(), body: { fields, typecast: true }, timeoutMs });
      return res.json;
    },

    async updateRecord(table, id, fields) {
      const res = await http(`${tableUrl(table)}/${id}`, { method: 'PATCH', headers: headers(), body: { fields, typecast: true } });
      return res.json;
    },

    async findRecords(table, { formula, maxRecords = 10 } = {}) {
      const query = new URLSearchParams({ maxRecords: String(maxRecords) });
      if (formula) query.set('filterByFormula', formula);
      const res = await http(`${tableUrl(table)}?${query}`, { headers: headers() });
      return res.json.records;
    },

    findByField(table, field, value) {
      const quoted = String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return this.findRecords(table, { formula: `{${field}} = '${quoted}'` });
    },

    async deleteRecord(table, id) {
      await http(`${tableUrl(table)}/${id}`, { method: 'DELETE', headers: headers() });
    },

    async listTables() {
      const res = await http(`${API}/meta/bases/${base()}/tables`, { headers: headers() });
      return res.json.tables;
    },

    async createTable(definition) {
      const res = await http(`${API}/meta/bases/${base()}/tables`, { method: 'POST', headers: headers(), body: definition });
      return res.json;
    },

    async createField(tableId, field) {
      const res = await http(`${API}/meta/bases/${base()}/tables/${tableId}/fields`, { method: 'POST', headers: headers(), body: field });
      return res.json;
    },
  };
}
