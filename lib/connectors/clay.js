import { http } from '../http.js';
import { need } from '../env.js';
import { signToken } from '../token.js';

export function clayRow(lead, env = process.env) {
  return {
    lead_id: lead.lead_id,
    token: signToken('clay', lead.lead_id, env),
    name: lead.name,
    email: lead.email,
    domain: lead.domain,
    title: lead.title,
  };
}

export function createClay(env = process.env) {
  return {
    // Adds one row to the Clay table. The result arrives later at /api/clay-callback.
    async sendRow(lead) {
      const res = await http(need('CLAY_WEBHOOK_URL', env), { method: 'POST', body: clayRow(lead, env) });
      return res.json ?? res.text;
    },
  };
}
