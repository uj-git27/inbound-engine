// In-memory Airtable for DRY_RUN and tests. `tables` is exposed so tests can inspect it.
export function createMockAirtable() {
  const tables = new Map();
  let next = 1;
  const rows = (table) => {
    if (!tables.has(table)) tables.set(table, new Map());
    return tables.get(table);
  };

  return {
    tables,

    async createRecord(table, fields) {
      const record = { id: `recMOCK${next++}`, fields: { ...fields } };
      rows(table).set(record.id, record);
      return record;
    },

    async updateRecord(table, id, fields) {
      const record = rows(table).get(id);
      if (!record) throw new Error(`mock Airtable: no record ${id} in ${table}`);
      Object.assign(record.fields, fields);
      return record;
    },

    // The mock takes a predicate in place of an Airtable formula.
    async findRecords(table, { where, maxRecords = 10 } = {}) {
      const all = [...rows(table).values()];
      return (where ? all.filter((r) => where(r.fields)) : all).slice(0, maxRecords);
    },

    findByField(table, field, value) {
      return this.findRecords(table, { where: (fields) => fields[field] === value });
    },

    async deleteRecord(table, id) {
      rows(table).delete(id);
    },

    async listTables() {
      return [...tables.keys()].map((name) => ({ id: name, name, fields: [] }));
    },

    async createTable(definition) {
      rows(definition.name);
      return { id: definition.name, name: definition.name };
    },

    async createField() {
      return {};
    },
  };
}
