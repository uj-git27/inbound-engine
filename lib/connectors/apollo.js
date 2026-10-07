import { http } from '../http.js';
import { need } from '../env.js';

const API = 'https://api.apollo.io/api/v1';

export function createApollo(env = process.env) {
  const headers = () => ({ 'x-api-key': need('APOLLO_API_KEY', env) });

  return {
    async enrichCompany(domain) {
      const res = await http(`${API}/organizations/enrich?domain=${encodeURIComponent(domain)}`, { headers: headers() });
      return res.json;
    },
  };
}
