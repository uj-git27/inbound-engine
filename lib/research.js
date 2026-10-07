import { rules } from './rules.js';
import { classifyNews, classifyPricing, personFromApollo, personFromExa } from './signals.js';

// At most 2 Firecrawl requests at a time (free plan), within this instance.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}

// Step 4 signals, live: Firecrawl pricing page, Exa news, Apollo person match.
// Every paid result is cached for 7 days. On an error the stale cache is used (labelled
// "cached"); otherwise the answer is "unknown". `calls` collects the labelled paid calls.
export function createResearch({ exa, firecrawl, apollo, cache }) {
  const firecrawlSlot = limiter(rules.limits.firecrawl_concurrency);

  async function cached(kind, id, calls, notes, fetchFresh, unknown) {
    const hit = await cache.get(kind, id);
    if (hit) return { ...hit, cached: true };
    try {
      const fresh = await fetchFresh();
      await cache.set(kind, id, fresh, kind);
      return fresh;
    } catch (err) {
      notes.push(`${kind} failed: ${err.message}`);
      const stale = await cache.getStale(kind, id);
      return stale ? { ...stale, cached: true } : unknown;
    }
  }

  return {
    async pricing(domain, { calls, notes }) {
      return cached('pricing', domain, calls, notes, async () => {
        calls.push('firecrawl_map');
        const mapped = await firecrawlSlot(() => firecrawl.map(`https://${domain}`, 'pricing'));
        const links = (mapped.links ?? []).map((l) => (typeof l === 'string' ? l : l.url)).filter(Boolean);
        const url = links.find((l) => /pric/i.test(l)) ?? `https://${domain}/pricing`;
        calls.push('firecrawl_pricing');
        const page = await firecrawlSlot(() => firecrawl.scrape(url));
        return classifyPricing(page.data?.markdown, url);
      }, { model: 'unknown', quote: null, url: null });
    },

    async news(domain, company, { calls, notes }) {
      const result = await cached('news', domain, calls, notes, async () => {
        calls.push('exa_news');
        const start = new Date(Date.now() - rules.signals.window_months * 30.44 * 86_400_000).toISOString();
        const reply = await exa.searchNews(`${company || domain} company news: funding, acquisition, new CFO, IPO, revenue, expansion`, {
          startPublishedDate: start, numResults: rules.signals.max_results,
        });
        return { signals: classifyNews(reply.results, { company, domain }) };
      }, { signals: [] });
      return result.signals ?? [];
    },

    async person(lead, { calls, notes }) {
      // The providers and their order come from rules.json (person_providers).
      const lookups = {
        async exa() {
          calls.push('exa_person');
          const reply = await exa.searchPeople(`${lead.name} ${lead.company || lead.domain}`);
          return personFromExa(reply.results, { name: lead.name, companies: [lead.company, lead.domain?.split('.')[0]] });
        },
        async apollo() {
          calls.push('apollo_person');
          const [first, ...rest] = String(lead.name ?? '').split(' ');
          const reply = await apollo.matchPerson({ email: lead.email, first_name: first, last_name: rest.join(' '), domain: lead.domain });
          return personFromApollo(reply?.person);
        },
      };
      const result = await cached('person', lead.email, calls, notes, async () => {
        let lastError = null;
        for (const provider of rules.person_providers) {
          try {
            const person = await lookups[provider]();
            if (person) return { person };
          } catch (err) {
            lastError = err;
          }
        }
        if (lastError) throw lastError;
        return { person: null };
      }, { person: null });
      return result.person ?? null;
    },
  };
}
