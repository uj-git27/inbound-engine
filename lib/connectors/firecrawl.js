import { http } from '../http.js';
import { need } from '../env.js';

const API = 'https://api.firecrawl.dev/v2';

export function createFirecrawl(env = process.env) {
  const headers = () => ({ authorization: `Bearer ${need('FIRECRAWL_API_KEY', env)}` });

  return {
    async scrape(url) {
      const res = await http(`${API}/scrape`, { method: 'POST', headers: headers(), body: { url, formats: ['markdown'] } });
      return res.json;
    },
  };
}
