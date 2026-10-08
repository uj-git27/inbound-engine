import { http } from '../http.js';
import { need } from '../env.js';

const API = 'https://api.blitz-api.ai/v2/enrichment/person';

export function createBlitz(env = process.env) {
  return {
    // A LinkedIn profile URL -> the person record with their work history, or null when not found.
    async person(linkedin) {
      const reply = await http(API, { method: 'POST', headers: { 'x-api-key': need('BLITZ_API_KEY', env) }, body: { person_linkedin_url: linkedin } });
      return reply.json?.found ? reply.json.person : null;
    },
  };
}
