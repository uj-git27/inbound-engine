import { http } from '../http.js';
import { need } from '../env.js';
import { rules } from '../rules.js';

const API = 'https://app.fullenrich.com/api/v2/contact/enrich/bulk';

export function createFullEnrich(env = process.env) {
  const headers = () => ({ authorization: `Bearer ${need('FULLENRICH_API_KEY', env)}` });

  return {
    // Phone backup: start a bulk enrichment for one contact, then poll until it finishes.
    // Returns the number or null.
    async findPhone({ name, domain, company, linkedin }) {
      const [first, ...rest] = String(name ?? '').split(' ');
      const contact = { first_name: first, last_name: rest.join(' '), domain, company_name: company, enrich_fields: ['contact.phones'] };
      if (linkedin) contact.linkedin_url = linkedin;
      const started = await http(API, { method: 'POST', headers: headers(), body: { name: `inbound-engine ${domain}`, data: [contact] } });
      const id = started.json.enrichment_id ?? started.json.id;
      const deadline = Date.now() + rules.limits.fullenrich_wait_seconds * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const poll = await http(`${API}/${id}`, { headers: headers() });
        if (['FINISHED', 'CANCELED', 'CREDITS_INSUFFICIENT'].includes(poll.json.status)) {
          return poll.json.data?.[0]?.contact_info?.most_probable_phone?.number ?? null;
        }
      }
      return null;
    },
  };
}
