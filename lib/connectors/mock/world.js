import world from '../../../data/mock-world.json' with { type: 'json' };

// DRY_RUN stand-ins for the paid services, answering from data/mock-world.json.
export function createMockApollo() {
  return {
    async enrichCompany(domain) {
      return { organization: world.apollo[domain] ?? null };
    },
  };
}

export function createMockResearch() {
  return {
    built: true,
    async pricing(domain) {
      return world.pricing[domain] ?? { model: 'unknown', quote: null, url: null };
    },
    async news(domain) {
      return world.signals[domain] ?? [];
    },
    async person(lead) {
      return world.person[lead.email] ?? null;
    },
  };
}
