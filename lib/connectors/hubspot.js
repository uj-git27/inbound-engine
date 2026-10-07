import { http } from '../http.js';
import { need } from '../env.js';

const API = 'https://api.hubapi.com';

// Auth is a Service key sent as a Bearer token.
export function createHubspot(env = process.env) {
  const request = (path, { method = 'GET', body } = {}) =>
    http(`${API}${path}`, { method, headers: { authorization: `Bearer ${need('HUBSPOT_TOKEN', env)}` }, body });

  return {
    request,

    async searchCompanies(filters, properties = ['domain', 'name', 'lifecyclestage']) {
      const res = await request('/crm/v3/objects/companies/search', {
        method: 'POST',
        body: { filterGroups: [{ filters }], properties, limit: 100 },
      });
      return res.json.results;
    },

    searchCompaniesByDomain(domain, properties) {
      return this.searchCompanies([{ propertyName: 'domain', operator: 'EQ', value: domain }], properties);
    },
  };
}
