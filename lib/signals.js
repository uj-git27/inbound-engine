import { rules } from './rules.js';

// Plain text from markdown: links keep their text and lose their URL.
const clean = (text) => String(text ?? '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\(https?:\/\/[^)]*\)/g, ' ')
  .replace(/[*_`#>|\[\]]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
        found.set(type, { type, date: new Date(when).toISOString().slice(0, 10), url: result.url, title: clean(result.title).slice(0, 120), inTitle, when });
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
