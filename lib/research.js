import { rules } from './rules.js';
import { verifyWebLinks, verifySignalLinks } from './linkcheck.js';
import { classifyNews, classifyPricing, personFromApollo, personFromExa, withBlitzHistory, companyFactsFromExa } from './signals.js';

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
export function createResearch({ exa, firecrawl, apollo, blitz, cache }) {
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

    // Web check for step 3: sourced company facts, plus the parent and subsidiaries found online.
    async companyWeb(domain, company, { calls, notes }) {
      return cached('company_web', domain, calls, notes, async () => {
        calls.push('exa_company');
        // Every cited page is checked, so the brief never shows a link that is known to be dead.
        return verifyWebLinks(companyFactsFromExa(await exa.companyFacts(company, domain), domain));
      }, { verified: false, facts: {}, parent: null, subsidiaries: [] });
    },

    // The saved web check, if there is a recent one: free, so it can add source links to CRM data.
    companyWebCached: (domain) => cache.get('company_web', domain),

    async news(domain, company, { calls, notes }) {
      const result = await cached('news', domain, calls, notes, async () => {
        calls.push('exa_news');
        const start = new Date(Date.now() - rules.signals.window_months * 30.44 * 86_400_000).toISOString();
        const reply = await exa.searchNews(rules.signals.news_query.replace('{company}', company || domain), {
          startPublishedDate: start, numResults: rules.signals.max_results,
        });
        return { signals: await verifySignalLinks(classifyNews(reply.results, { company, domain })) };
      }, { signals: [] });
      // Strict window: a saved result can be a few days old, so anything that has since passed the
      // cut-off is dropped again here.
      const cutoff = new Date(Date.now() - rules.signals.window_months * 30.44 * 86_400_000).toISOString().slice(0, 10);
      return (result.signals ?? []).filter((s) => s.date >= cutoff);
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
      // Blitz reads the LinkedIn profile that was found, for the role start date and earlier
      // employers. If it fails, the person is kept as found.
      const history = async (person) => {
        if (!blitz || !person.linkedin || person.role_start) return person;
        try {
          calls.push('blitz_person');
          return withBlitzHistory(person, await blitz.person(person.linkedin), { companies: [lead.company, lead.domain?.split('.')[0]] });
        } catch (err) {
          notes.push(`Blitz failed: ${err.message}`);
          return person;
        }
      };
      // Saved per email and name: a demo alias can be reused with a different name.
      const result = await cached('person', `${lead.email}|${String(lead.name ?? '').toLowerCase()}`, calls, notes, async () => {
        let lastError = null;
        for (const provider of rules.person_providers) {
          try {
            const person = await lookups[provider]();
            if (person) return { person: await history(person) };
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
