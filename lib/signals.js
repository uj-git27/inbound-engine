import { rules } from './rules.js';

// Plain text from markdown: links keep their text and lose their URL.
const clean = (text) => String(text ?? '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\(https?:\/\/[^)]*\)/g, ' ')
  .replace(/[*_`#>|\[\]]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// One or two sentences quoted from the article, so the reader sees what the signal is without
// opening the link: the sentence that states the signal, plus the next one if there is room.
function snippetFor(result, re, limit = 260) {
  const sentences = (result.highlights ?? []).flatMap((h) => clean(h).split(/(?<=[.!?])\s+/)).filter((s) => s.length > 20);
  if (!sentences.length) return null;
  const at = Math.max(0, sentences.findIndex((s) => re.test(s)));
  let text = sentences[at];
  if (sentences[at + 1] && text.length + sentences[at + 1].length + 1 <= limit) text += ` ${sentences[at + 1]}`;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

// Step 4 news: fixed regex rules. Each signal needs a date, a URL, the company's name, and must
// fall in the window. One signal per type (the most recent).
export function classifyNews(results, { company, domain, now = Date.now() }) {
  const windowStart = now - rules.signals.window_months * 30.44 * 86_400_000;
  const names = [company, domain?.split('.')[0]].filter((n) => n && n.length > 2).map((n) => n.toLowerCase());
  const found = new Map();
  for (const result of results ?? []) {
    const when = Date.parse(result.publishedDate ?? '');
    if (!result.url || Number.isNaN(when) || when < windowStart || when > now) continue;
    const text = clean(`${result.title ?? ''} ${(result.highlights ?? []).join(' ')}`);
    const lower = text.toLowerCase();
    if (!names.some((n) => lower.includes(n))) continue;
    for (const [type, pattern] of Object.entries(rules.signals.rules)) {
      const re = new RegExp(pattern, 'i');
      if (!re.test(text)) continue;
      // An article whose headline states the signal beats one that only mentions it; then the newest.
      const inTitle = re.test(clean(result.title));
      const prior = found.get(type);
      if (!prior || (inTitle && !prior.inTitle) || (inTitle === prior.inTitle && when > prior.when)) {
        found.set(type, {
          type, date: new Date(when).toISOString().slice(0, 10), url: result.url, title: clean(result.title).slice(0, 120),
          snippet: snippetFor(result, re), inTitle, when,
        });
      }
    }
  }
  return [...found.values()].map(({ inTitle, when, ...signal }) => signal).sort((a, b) => b.date.localeCompare(a.date));
}

// Step 4 pricing: keyword rules classify the page, with a quoted line as evidence.
// Prefers a line containing a number.
export function classifyPricing(markdown, url = null) {
  const p = rules.pricing;
  const lines = String(markdown ?? '').split('\n').map(clean).filter((l) => l.length > 3 && l.length < 400);
  const hits = { usage: [], tiered: [], contact_sales: [] };
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const kind of Object.keys(hits)) if (p[kind].some((k) => lower.includes(k))) hits[kind].push(line);
  }
  const model = hits.usage.length && hits.tiered.length ? 'hybrid'
    : hits.usage.length ? 'usage'
      : hits.tiered.length ? 'tiered'
        : hits.contact_sales.length ? 'contact_sales' : 'unknown';
  if (model === 'unknown') return { model, quote: null, url };
  const pool = model === 'hybrid' ? [...hits.usage, ...hits.tiered] : hits[model];
  // Prefer a line with a price, then any line with a number.
  const quote = (pool.find((l) => /[$€£]\s?\d/.test(l)) ?? pool.find((l) => /\d/.test(l)) ?? pool[0]).slice(0, p.quote_max_length);
  return { model, quote, url };
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const cleanDomain = (text) => {
  const host = String(text ?? '').toLowerCase().trim().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s)]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
};

// Exa company search (structured output with citations) -> sourced facts and the company family.
// Nothing is used unless one of the pages it read is on the company's own domain, or names that
// domain: that is the check that the search found this company and not one with a similar name. A field is kept only
// when it has a value, a cited page, and confidence above "low".
export function companyFactsFromExa(reply, domain) {
  const empty = { verified: false, facts: {}, parent: null, subsidiaries: [] };
  let content = reply?.output?.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return empty;
    }
  }
  if (!content || typeof content !== 'object') return empty;
  const grounding = reply.output.grounding ?? [];
  const pages = [...(reply.results ?? []).map((r) => r.url), ...grounding.flatMap((g) => (g.citations ?? []).map((c) => c.url))];
  const onOwnSite = pages.some((url) => { const h = hostOf(url); return h === domain || h.endsWith(`.${domain}`); });
  // Or a page it read names the company's domain in its text (a profile page listing the website).
  const namesDomain = (reply.results ?? []).some((r) => `${r.title ?? ''} ${(r.highlights ?? []).join(' ')}`.toLowerCase().includes(domain));
  if (!onOwnSite && !namesDomain) return empty;

  const fact = (field) => {
    const value = String(content[field] ?? '').trim();
    const g = grounding.find((x) => x.field === field);
    if (!value || !g || g.confidence === 'low' || !g.citations?.length) return null;
    return { value, url: g.citations[0].url, urls: g.citations.map((c) => c.url), confidence: g.confidence };
  };
  const facts = {};
  const headcount = fact('headcount');
  if (headcount) {
    const numbers = (headcount.value.match(/\d[\d,]*/g) ?? []).map((n) => Number(n.replace(/,/g, ''))).filter((n) => n > 0 && n < 5_000_000 && !(n >= 1990 && n <= 2100));
    const range = /(\d[\d,]*)\s*(?:to|-|–)\s*(\d[\d,]*)/.exec(headcount.value);
    if (numbers.length) {
      const [min, max] = range ? [Number(range[1].replace(/,/g, '')), Number(range[2].replace(/,/g, ''))] : [numbers[0], numbers[0]];
      facts.headcount = { ...headcount, min: Math.min(min, max), max: Math.max(min, max) };
    }
  }
  for (const field of ['hq_country', 'latest_funding_stage']) {
    const f = fact(field);
    if (f) facts[field] = { ...f, value: f.value.replace(/\s*\(.*$/, '').slice(0, 60) };
  }
  const b2b = fact('sells_to_businesses');
  if (b2b && /^(yes|no)\b/i.test(b2b.value)) facts.sells_to_businesses = { ...b2b, value: b2b.value.toLowerCase().startsWith('yes') ? 'yes' : 'no' };

  const parentFact = fact('parent_company');
  const parentDomain = cleanDomain(content.parent_domain);
  const parent = parentFact && parentDomain && parentDomain !== domain
    ? { name: parentFact.value.slice(0, 80), domain: parentDomain, url: parentFact.url, urls: parentFact.urls, source: 'Exa' } : null;
  const subsFact = fact('subsidiaries');
  const subsidiaries = !subsFact ? [] : [...subsFact.value.matchAll(/([^,()]+)\(([^)]+)\)/g)]
    .map((m) => ({ name: m[1].trim().slice(0, 80), domain: cleanDomain(m[2]), url: subsFact.url, source: 'Exa' }))
    .filter((s) => s.domain && s.domain !== domain && s.domain !== parentDomain);
  return { verified: true, facts, parent, subsidiaries };
}

const norm = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Exa people search -> the person facts used in the brief. A result is accepted only when it is
// a LinkedIn profile whose name matches the form exactly and whose text shows a role at the
// company; otherwise the answer is unknown. It never guesses between people with the same name.
export function personFromExa(results, { name, companies }) {
  const wanted = norm(name);
  const firms = companies.map(norm).filter((c) => c.length > 2);
  if (!wanted.includes(' ') || !firms.length) return null;
  for (const result of results ?? []) {
    if (!/linkedin\.com\/in\//.test(result.url ?? '') || norm(result.title) !== wanted) continue;
    const text = (result.highlights ?? []).join('\n');
    const firm = firms.find((c) => norm(text).includes(c));
    if (!firm) continue;
    // "### CFO - [Acme](...) (Current)" or "CFO @ Acme"
    const line = text.split('\n').map((l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*/, '').trim())
      .find((l) => norm(l).includes(firm) && /\s(-|@|at)\s/i.test(l) && l.length < 160);
    const title = line ? line.split(/\s(?:-|@|at)\s/i)[0].replace(/\(current\)/i, '').trim() : null;
    // A passing mention of the company is not enough: the profile must show a role at it.
    if (!title) continue;
    return { linkedin: result.url, title, role_start: null, previous_companies: [], source: 'Exa' };
  }
  return null;
}

// Apollo people match -> the person facts used in the brief.
export function personFromApollo(person) {
  if (!person) return null;
  const jobs = person.employment_history ?? [];
  const current = jobs.find((j) => j.current) ?? null;
  const previous = [...new Set(jobs.filter((j) => !j.current && j.organization_name).map((j) => j.organization_name))].slice(0, 3);
  if (!person.linkedin_url && !person.title && !previous.length) return null;
  return {
    linkedin: person.linkedin_url ?? null,
    title: person.title ?? null,
    role_start: current?.start_date?.slice(0, 7) ?? null,
    previous_companies: previous,
    source: 'Apollo',
  };
}
