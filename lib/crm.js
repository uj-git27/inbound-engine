import { rules, teamMember } from './rules.js';
import { seed } from './seed.js';

const CLOSED = ['closedwon', 'closedlost'];

// Every provider returns the same shape, or null when the domain is not in the CRM:
// { name, lifecyclestage, isCustomer, openDeal: {name, stage} | null, owner, lostReason, lastTouch,
//   profile: { headcount, country, industry, funding_stage, enriched_at } }
const shape = ({ name, lifecyclestage, deals = [], owner, lostReason, lastTouch, profile = {} }) => ({
  name: name ?? '',
  lifecyclestage: lifecyclestage ?? '',
  isCustomer: lifecyclestage === 'customer',
  openDeal: deals.find((d) => !d.closed) ?? null,
  owner: owner ?? '',
  lostReason: lostReason ?? '',
  lastTouch: lastTouch ?? '',
  profile: {
    headcount: Number(profile.headcount) || null,
    country: profile.country || null,
    industry: profile.industry || null,
    funding_stage: profile.funding_stage || null,
    enriched_at: profile.enriched_at || null,
  },
});

export function createHubspotCrm(hubspot) {
  const properties = [
    'domain', 'name', 'lifecyclestage', 'numberofemployees', 'country', 'industry',
    'ie_industry', 'ie_funding_stage', 'ie_enriched_at', 'ie_owner_name', 'ie_lost_reason', 'ie_last_touch',
  ];
  const find = async (domain) => (await hubspot.searchCompaniesByDomain(domain, properties))[0] ?? null;

  return {
    // Exact domain match (free).
    async lookupCompany(domain) {
      const company = await find(domain);
      if (!company) return null;
      const links = await hubspot.request(`/crm/v4/objects/companies/${company.id}/associations/deals`);
      const ids = (links.json.results ?? []).map((r) => ({ id: String(r.toObjectId) }));
      let deals = [];
      if (ids.length) {
        const read = await hubspot.request('/crm/v3/objects/deals/batch/read', {
          method: 'POST',
          body: { inputs: ids, properties: ['dealname', 'dealstage', 'hs_is_closed_won', 'hs_is_closed_lost'] },
        });
        deals = read.json.results.map((d) => ({
          name: d.properties.dealname,
          stage: d.properties.dealstage,
          closed: d.properties.hs_is_closed_won === 'true' || d.properties.hs_is_closed_lost === 'true',
        }));
      }
      const p = company.properties;
      return shape({
        name: p.name, lifecyclestage: p.lifecyclestage, deals, owner: p.ie_owner_name, lostReason: p.ie_lost_reason, lastTouch: p.ie_last_touch,
        profile: {
          headcount: p.numberofemployees,
          country: p.country,
          // HubSpot's own industry is a fixed list (COMPUTER_SOFTWARE); ie_industry holds free text.
          industry: p.ie_industry || p.industry?.toLowerCase().replace(/_/g, ' '),
          funding_stage: p.ie_funding_stage,
          enriched_at: p.ie_enriched_at,
        },
      });
    },

    // Creates or updates the company by domain. `fields` uses the engine's names.
    async upsertCompany(domain, fields) {
      const map = {
        name: 'name', headcount: 'numberofemployees', country: 'country', industry: 'ie_industry',
        funding_stage: 'ie_funding_stage', enriched_at: 'ie_enriched_at', parent_domain: 'ie_parent_domain',
        score: 'ie_score', tier: 'ie_tier', reasons: 'ie_reasons', signal_links: 'ie_signal_links',
      };
      const props = {};
      for (const [key, value] of Object.entries(fields)) if (map[key] && value !== null && value !== undefined && value !== '') props[map[key]] = value;
      const existing = await find(domain);
      if (existing) await hubspot.request(`/crm/v3/objects/companies/${existing.id}`, { method: 'PATCH', body: { properties: props } });
      else await hubspot.request('/crm/v3/objects/companies', { method: 'POST', body: { properties: { domain, ...props } } });
    },
  };
}

const fromRow = (f) =>
  shape({
    name: f.name,
    lifecyclestage: f.lifecyclestage,
    deals: f.deal_stage ? [{ name: f.deal_name, stage: f.deal_stage, closed: CLOSED.includes(f.deal_stage) }] : [],
    owner: f.owner,
    lostReason: f.lost_reason,
    lastTouch: f.last_touch,
    profile: { headcount: f.headcount, country: f.country, industry: f.industry, funding_stage: f.funding_stage, enriched_at: f.enriched_at },
  });

const rowFields = (fields) => {
  const allowed = ['name', 'headcount', 'country', 'industry', 'funding_stage', 'enriched_at', 'parent_domain', 'score', 'tier', 'reasons', 'signal_links'];
  return Object.fromEntries(Object.entries(fields).filter(([k, v]) => allowed.includes(k) && v !== null && v !== undefined && v !== ''));
};

export function createAirtableCrm(airtable) {
  const table = rules.tables.crm;
  return {
    async lookupCompany(domain) {
      const [record] = await airtable.findByField(table, 'domain', domain);
      return record ? fromRow(record.fields) : null;
    },
    async upsertCompany(domain, fields) {
      const [record] = await airtable.findByField(table, 'domain', domain);
      if (record) await airtable.updateRecord(table, record.id, rowFields(fields));
      else await airtable.createRecord(table, { domain, ...rowFields(fields) });
    },
  };
}

// DRY_RUN: the seeded TEST records in memory, no network.
export function createMockCrm() {
  const rows = new Map(seed.map((row) => [row.domain, {
    name: row.name,
    lifecyclestage: row.lifecyclestage,
    deal_name: row.deal?.name,
    deal_stage: row.deal?.stage,
    owner: teamMember(row.owner_role).name,
    lost_reason: row.deal?.lost_reason,
    last_touch: row.last_touch,
    headcount: row.headcount,
    country: row.country,
    industry: row.industry,
    funding_stage: row.funding_stage,
    enriched_at: row.fresh ? new Date().toISOString() : undefined,
  }]));
  return {
    rows,
    async lookupCompany(domain) {
      return rows.has(domain) ? fromRow(rows.get(domain)) : null;
    },
    async upsertCompany(domain, fields) {
      rows.set(domain, { ...(rows.get(domain) ?? {}), ...rowFields(fields) });
    },
  };
}
