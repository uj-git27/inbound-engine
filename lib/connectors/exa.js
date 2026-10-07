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

    // Sourced company facts and family, as structured output with citations per field.
    async companyFacts(company, domain) {
      const text = { type: 'string' };
      const res = await http('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': need('EXA_API_KEY', env) },
        body: {
          query: `${company || domain} (${domain}) company: parent company or owner, subsidiaries, number of employees, headquarters, latest funding round, who its customers are`,
          type: 'auto',
          systemPrompt: 'Answer only from the retrieved pages. Leave a field as an empty string when no page states it; never guess. parent_company is the company that owns or acquired this company, if any; parent_domain is that parent\'s website domain. subsidiaries is a comma-separated list of companies this company owns, each written as "Name (domain)". hq_country is a country name. sells_to_businesses is "yes" or "no".',
          outputSchema: {
            type: 'object',
            properties: {
              parent_company: text, parent_domain: text, subsidiaries: text, headcount: text,
              hq_country: text, latest_funding_stage: text, sells_to_businesses: text,
            },
          },
          contents: { highlights: true },
        },
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
