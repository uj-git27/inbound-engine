import world from '../../../data/mock-world.json' with { type: 'json' };

// DRY_RUN stand-ins for the paid services, answering from data/mock-world.json.
export function createMockApollo() {
  return {
    async enrichCompany(domain) {
      return { organization: world.apollo[domain] ?? null };
    },
    async matchPerson({ email }) {
      return { person: world.person[email] ?? null };
    },
  };
}

// Same interface as lib/research.js; counts the calls the live version would pay for.
export function createMockResearch() {
  return {
    async pricing(domain, { calls }) {
      calls.push('firecrawl_map', 'firecrawl_pricing');
      return world.pricing[domain] ?? { model: 'unknown', quote: null, url: null };
    },
    async news(domain, company, { calls }) {
      calls.push('exa_news');
      return world.signals[domain] ?? [];
    },
    async person(lead, { calls }) {
      calls.push('apollo_person');
      const p = world.person[lead.email];
      return p ? { ...p, source: 'Apollo' } : null;
    },
  };
}

export function createMockClay() {
  const rows = [];
  return {
    rows,
    configured: false,
    async sendRow(lead) {
      rows.push(lead.lead_id);
      return { ok: true };
    },
  };
}

export function createMockFullEnrich() {
  return {
    async findPhone({ domain }) {
      return world.phones?.[domain] ?? null;
    },
  };
}
