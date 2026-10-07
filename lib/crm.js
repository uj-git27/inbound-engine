import { rules } from './rules.js';
import { seed } from './seed.js';
import { teamMember } from './rules.js';

const CLOSED = ['closedwon', 'closedlost'];

// Every provider returns the same shape, or null when the domain is not in the CRM:
// { name, lifecyclestage, isCustomer, openDeal: {name, stage} | null, owner, lostReason, lastTouch }
const shape = ({ name, lifecyclestage, deals = [], owner, lostReason, lastTouch }) => ({
  name: name ?? '',
  lifecyclestage: lifecyclestage ?? '',
  isCustomer: lifecyclestage === 'customer',
  openDeal: deals.find((d) => !d.closed) ?? null,
  owner: owner ?? '',
  lostReason: lostReason ?? '',
  lastTouch: lastTouch ?? '',
});

export function createHubspotCrm(hubspot) {
  return {
    // Exact domain match (free).
    async lookupCompany(domain) {
      const [company] = await hubspot.searchCompaniesByDomain(domain, [
        'domain', 'name', 'lifecyclestage', 'ie_owner_name', 'ie_lost_reason', 'ie_last_touch',
      ]);
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
      return shape({ name: p.name, lifecyclestage: p.lifecyclestage, deals, owner: p.ie_owner_name, lostReason: p.ie_lost_reason, lastTouch: p.ie_last_touch });
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
  });

export function createAirtableCrm(airtable) {
  return {
    async lookupCompany(domain) {
      const [record] = await airtable.findByField(rules.tables.crm, 'domain', domain);
      return record ? fromRow(record.fields) : null;
    },
  };
}

// DRY_RUN: the seeded TEST records, no network.
export function createMockCrm() {
  return {
    async lookupCompany(domain) {
      const row = seed.find((r) => r.domain === domain);
      if (!row) return null;
      return fromRow({
        name: row.name,
        lifecyclestage: row.lifecyclestage,
        deal_name: row.deal?.name,
        deal_stage: row.deal?.stage,
        owner: teamMember(row.owner_role).name,
        lost_reason: row.deal?.lost_reason,
        last_touch: row.last_touch,
      });
    },
  };
}
