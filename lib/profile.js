import { rules } from './rules.js';
import { domainOf } from './tally.js';
import { hasWord } from './checks.js';

const UNKNOWN = null;

const emptyProfile = (source) => ({
  headcount_min: UNKNOWN, headcount_max: UNKNOWN, country: UNKNOWN, industry: UNKNOWN,
  funding_stage: UNKNOWN, funding_date: UNKNOWN, parent: null, subsidiaries: [], family_known: false, source,
});

// Apollo organization enrich -> the engine's company profile. A missing field stays unknown.
export function profileFromApollo(org) {
  if (!org) return emptyProfile('unknown');
  const related = (o) => (o?.website_url ? { name: o.name ?? '', domain: domainOf(o.website_url), source: 'Apollo' } : null);
  const headcount = Number(org.estimated_num_employees) || UNKNOWN;
  const industries = [org.industry, ...(org.industries ?? [])].filter(Boolean);
  return {
    name: org.name ?? '',
    headcount_min: headcount,
    headcount_max: headcount,
    country: org.country || UNKNOWN,
    industry: [...new Set(industries)].join(', ') || UNKNOWN,
    funding_stage: org.latest_funding_stage || UNKNOWN,
    funding_date: org.latest_funding_round_date?.slice(0, 10) || UNKNOWN,
    parent: related(org.owned_by_organization),
    subsidiaries: (org.suborganizations ?? []).map(related).filter((s) => s?.domain),
    family_known: 'owned_by_organization_id' in org || 'suborganizations' in org,
    source: 'Apollo',
  };
}

// CRM first: use its facts only if all four are present and fresh.
export function profileFromCrm(company) {
  const p = company?.profile;
  if (!p || !p.headcount || !p.country || !p.industry || !p.funding_stage || !p.enriched_at) return null;
  if (Date.now() - Date.parse(p.enriched_at) > rules.freshness_days * 86_400_000) return null;
  return {
    ...emptyProfile('CRM'), name: company.name, headcount_min: p.headcount, headcount_max: p.headcount,
    country: p.country, industry: p.industry, funding_stage: p.funding_stage,
    // The parent saved by an earlier enrichment keeps the family check working on CRM data.
    parent: p.parent_domain ? { name: '', domain: p.parent_domain } : null,
    family_known: Boolean(p.parent_domain),
  };
}

// Step 3 company profile. `calls` collects the labelled paid calls for this lead.
export async function getProfile({ domain, company, apollo, cache, calls, notes }) {
  const fromCrm = profileFromCrm(company);
  if (fromCrm) return fromCrm;

  const cached = await cache.get('apollo_company', domain);
  if (cached) return { ...cached, source: 'Apollo (cached)' };
  try {
    calls.push('apollo_company');
    const reply = await apollo.enrichCompany(domain);
    const profile = profileFromApollo(reply?.organization);
    if (profile.source === 'Apollo') await cache.set('apollo_company', domain, profile, 'Apollo');
    return profile;
  } catch (err) {
    notes.push(`Apollo company enrich failed: ${err.message}`);
    const stale = await cache.getStale('apollo_company', domain);
    return stale ? { ...stale, source: 'Apollo (cached)' } : emptyProfile('unknown');
  }
}

// Adds what the web search found: source links for the facts, values Apollo did not have,
// and any parent or subsidiaries. Only used when the search was verified to be about this company.
export function mergeWeb(profile, web) {
  if (!web?.verified) return profile;
  const out = { ...profile, web_sources: {}, subsidiaries: [...(profile.subsidiaries ?? [])] };
  const f = web.facts ?? {};
  const filled = [];
  // A fact whose cited pages turned out to be dead keeps its value but gets no link.
  const link = (label, fact) => { if (fact.url) out.web_sources[label] = fact.url; };
  if (f.headcount) {
    link('headcount', f.headcount);
    if (out.headcount_min === null) { out.headcount_min = f.headcount.min; out.headcount_max = f.headcount.max; filled.push('headcount'); }
  }
  if (f.hq_country) {
    link('HQ', f.hq_country);
    if (!out.country) { out.country = f.hq_country.value; filled.push('country'); }
  }
  if (f.latest_funding_stage) {
    link('funding', f.latest_funding_stage);
    if (!out.funding_stage) { out.funding_stage = f.latest_funding_stage.value; filled.push('funding'); }
  }
  if (f.sells_to_businesses) out.sells_to_businesses = f.sells_to_businesses;
  if (!out.parent && web.parent) out.parent = web.parent;
  for (const sub of web.subsidiaries ?? []) if (!out.subsidiaries.some((s) => s.domain === sub.domain)) out.subsidiaries.push(sub);
  out.family_known = Boolean(profile.family_known || web.parent || web.subsidiaries?.length);
  if (filled.length) out.source = profile.source === 'unknown' ? 'Exa' : `${profile.source} + Exa`;
  return out;
}

// Gates. An unknown fact never disqualifies. Returns a reason or null.
export function gate(profile) {
  const g = rules.gates;
  const industry = profile.industry;
  if (industry) {
    const notBuyer = hasWord(industry, g.not_a_buyer_industries);
    if (notBuyer) return { reason: `Not a buyer (industry: ${notBuyer})`, label: rules.disqualify.not_a_buyer_label };
    const consumer = hasWord(industry, g.consumer_industries);
    if (consumer) return { reason: `Doesn't sell to businesses (industry per ${profile.source}: "${consumer}")`, label: 'not B2B' };
  }
  // A web source that clearly says the company does not sell to businesses (high confidence only).
  const b2b = profile.sells_to_businesses;
  if (b2b?.value === 'no' && b2b.confidence === 'high') {
    return { reason: `Doesn't sell to businesses (web source: ${b2b.url})`, label: 'not B2B' };
  }
  if (profile.country && !g.americas_countries.includes(profile.country.toLowerCase())) {
    return { reason: `HQ outside the Americas (${profile.country})`, label: 'outside the Americas' };
  }
  if (profile.headcount_min !== null && (profile.headcount_min > g.headcount_max || profile.headcount_max < g.headcount_min)) {
    const size = profile.headcount_min === profile.headcount_max ? profile.headcount_min : `${profile.headcount_min}-${profile.headcount_max}`;
    return { reason: `Headcount ${size} is outside ${g.headcount_min} to ${g.headcount_max}`, label: 'headcount out of range' };
  }
  return null;
}
