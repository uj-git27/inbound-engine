import { rules } from './rules.js';
import { freeChecks } from './checks.js';
import { createCache } from './cache.js';
import { getProfile, gate } from './profile.js';
import { score, tierOf, unknownFacts } from './score.js';
import { rateLimited } from './limits.js';

const MAX_FAMILY_LOOKUPS = 10;

async function isDuplicate(lead, recordId, airtable) {
  if (lead.demo || !lead.email) return false;
  const cutoff = Date.now() - rules.disqualify.duplicate_window_days * 86_400_000;
  const rows = await airtable.findByField(rules.tables.leads, 'email', lead.email);
  return rows.some((r) => r.id !== recordId && Date.parse(r.fields.received_at) >= cutoff && r.fields.status !== 'parse_error');
}

// Steps 1 to 6: decides what the lead is. Cheapest checks first; nothing paid runs for a lead
// that an earlier step settled. Returns an outcome; routing and saving happen in the pipeline.
export async function decide(lead, { recordId, connectors }) {
  const { airtable, crm, apollo, research, clay } = connectors;
  const out = { kind: null, flags: [], calls: [], notes: [], company: null, profile: null };
  const done = (kind, extra = {}) => Object.assign(out, { kind }, extra);

  // Step 1: free checks.
  const checks = freeChecks(lead);
  out.flags.push(...checks.flags);
  if (checks.disqualified) return done('disqualified', checks.disqualified);
  if (await isDuplicate(lead, recordId, airtable)) {
    return done('duplicate', { reason: `Duplicate: same email within ${rules.disqualify.duplicate_window_days} days` });
  }

  // Step 2: already know them? Exact domain match in the CRM (free).
  out.company = await crm.lookupCompany(lead.domain);
  if (out.company?.isCustomer) return done('customer', { reason: `CRM: ${out.company.name} is a customer` });
  if (out.company?.openDeal) return done('open_deal', { reason: `CRM: open deal "${out.company.openDeal.name}"` });

  // Guard rail: rate limits apply before anything paid runs. Demo aliases are exempt.
  const limited = await rateLimited(lead, recordId, airtable);
  if (limited) return done('rate_limited', { reason: limited });

  // Step 3: company profile (CRM first, otherwise Apollo), company family, gates.
  const profile = await getProfile({ domain: lead.domain, company: out.company, apollo, cache: createCache(airtable), calls: out.calls, notes: out.notes });
  out.profile = profile;
  if (profile.source === 'Apollo') {
    try {
      await crm.upsertCompany(lead.domain, {
        name: out.company?.name || profile.name || lead.company,
        headcount: profile.headcount_max, country: profile.country, industry: profile.industry,
        funding_stage: profile.funding_stage, parent_domain: profile.parent?.domain, enriched_at: new Date().toISOString(),
      });
    } catch (err) {
      out.notes.push(`CRM write-back failed: ${err.message}`);
    }
  }

  if (!profile.family_known) {
    out.notes.push('family: unknown');
  } else {
    const relatives = [
      ...(profile.parent?.domain ? [{ ...profile.parent, relation: 'parent' }] : []),
      ...profile.subsidiaries.map((s) => ({ ...s, relation: 'subsidiary' })),
    ].slice(0, MAX_FAMILY_LOOKUPS);
    for (const relative of relatives) {
      const known = await crm.lookupCompany(relative.domain);
      if (known?.isCustomer || known?.openDeal) {
        return done('expansion', {
          expansion: { ...relative, company: known },
          reason: `Expansion: ${relative.relation} ${relative.name || relative.domain} ${known.isCustomer ? 'is a customer' : 'has an open deal'}`,
        });
      }
    }
  }

  const gated = gate(profile);
  if (gated) return done('disqualified', gated);

  // Step 4: signals, in parallel, only for companies that pass.
  const ctx = { calls: out.calls, notes: out.notes };
  // Person: skipped for role-played demo aliases. Clay first, and never waited for; without
  // Clay, Apollo's person match answers straight away.
  let personLookup = Promise.resolve(null);
  if (!lead.demo && clay.configured) {
    out.personPending = true;
    personLookup = clay.sendRow(lead).then(() => null, (err) => {
      out.notes.push(`Clay send failed: ${err.message}`);
      out.personPending = false;
      return null;
    });
  } else if (!lead.demo) {
    personLookup = research.person(lead, ctx);
  }
  const [pricing, signals, person] = await Promise.all([
    research.pricing(lead.domain, ctx),
    research.news(lead.domain, profile.name || lead.company, ctx),
    personLookup,
  ]);
  Object.assign(out, { pricing, signals, person });

  // Steps 5 and 6: score, tier, confidence.
  const scored = score({ lead, profile, pricing, signals });
  const unknown = unknownFacts({ profile, person: person ?? out.personPending });
  return done('tiered', {
    score: scored.total,
    breakdown: scored.breakdown,
    tier: tierOf(scored.total),
    unknown,
    lowConfidence: unknown.length >= rules.low_confidence_unknowns,
    reason: Object.entries(scored.breakdown).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v.points}/${v.max} (${v.detail})`).join('; '),
  });
}
