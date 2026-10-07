import { http } from '../http.js';
import { need } from '../env.js';

export function createExa(env = process.env) {
  return {
    async searchNews(query, { startPublishedDate, numResults = 10 } = {}) {
      const res = await http('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': need('EXA_API_KEY', env) },
        body: { query, category: 'news', numResults, startPublishedDate, contents: { highlights: true } },
      });
      return res.json;
    },

    // LinkedIn profile documents for a named person at a company.
    async searchPeople(query) {
      const res = await http('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': need('EXA_API_KEY', env) },
        body: { query, category: 'people', numResults: 5, contents: { highlights: true } },
      });
      return res.json;
    },
  };
}
