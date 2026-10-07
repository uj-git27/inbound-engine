import seed from '../data/crm-seed.json' with { type: 'json' };
import { rules, teamMember } from './rules.js';

export { seed };

const group = { companies: 'companyinformation', contacts: 'contactinformation' };
const prop = (name, label, type = 'string', fieldType = 'text') => ({ name, label, type, fieldType });

export const hubspotProperties = {
  companies: [
    prop('ie_score', 'Inbound engine: score', 'number', 'number'),
    prop('ie_tier', 'Inbound engine: tier'),
    prop('ie_reasons', 'Inbound engine: reasons', 'string', 'textarea'),
    prop('ie_signal_links', 'Inbound engine: signal links', 'string', 'textarea'),
    prop('ie_parent_domain', 'Inbound engine: parent domain'),
    prop('ie_funding_stage', 'Inbound engine: funding stage'),
    prop('ie_industry', 'Inbound engine: industry'),
    prop('ie_enriched_at', 'Inbound engine: enriched at', 'datetime', 'date'),
    prop('ie_owner_name', 'Inbound engine: owner name'),
    prop('ie_lost_reason', 'Inbound engine: lost reason'),
    prop('ie_last_touch', 'Inbound engine: last touch'),
    prop('ie_nurture', 'Inbound engine: nurture tag'),
    prop('ie_rep_verdict', 'Inbound engine: rep verdict'),
    prop('ie_test_record', 'Inbound engine: TEST record'),
  ],
  contacts: [
    prop('ie_tier', 'Inbound engine: tier'),
    prop('ie_rep_verdict', 'Inbound engine: rep verdict'),
  ],
};

export async function createHubspotProperties(hubspot, log) {
  for (const [object, props] of Object.entries(hubspotProperties)) {
    for (const p of props) {
      try {
        await hubspot.request(`/crm/v3/properties/${object}`, { method: 'POST', body: { ...p, groupName: group[object] } });
        log(`property ${object}.${p.name}: created`);
      } catch (err) {
        if (err.status !== 409) throw err;
        log(`property ${object}.${p.name}: exists`);
      }
    }
  }
}

// Deletes only records flagged ie_test_record=true, and the deals attached to them.
export async function resetHubspotSeed(hubspot, log) {
  const companies = await hubspot.searchCompanies([{ propertyName: 'ie_test_record', operator: 'EQ', value: 'true' }]);
  for (const company of companies) {
    const deals = await hubspot.request(`/crm/v4/objects/companies/${company.id}/associations/deals`);
    for (const deal of deals.json.results ?? []) {
      await hubspot.request(`/crm/v3/objects/deals/${deal.toObjectId}`, { method: 'DELETE' });
    }
    await hubspot.request(`/crm/v3/objects/companies/${company.id}`, { method: 'DELETE' });
    log(`deleted ${company.properties.domain} (+${deals.json.results?.length ?? 0} deals)`);
  }
}

export async function seedHubspot(hubspot, log) {
  for (const row of seed) {
    const existing = await hubspot.searchCompaniesByDomain(row.domain);
    if (existing.length) {
      log(`${row.domain}: exists, skipped (use --reset to recreate)`);
      continue;
    }
    const properties = {
      domain: row.domain,
      name: row.name,
      lifecyclestage: row.lifecyclestage,
      ie_owner_name: teamMember(row.owner_role).name,
      ie_test_record: 'true',
    };
    if (row.headcount) properties.numberofemployees = row.headcount;
    if (row.country) properties.country = row.country;
    if (row.hubspot_industry) properties.industry = row.hubspot_industry;
    if (row.funding_stage) properties.ie_funding_stage = row.funding_stage;
    if (row.last_touch) properties.ie_last_touch = row.last_touch;
    if (row.deal?.lost_reason) properties.ie_lost_reason = row.deal.lost_reason;
    if (row.fresh) properties.ie_enriched_at = new Date().toISOString();

    const company = await hubspot.request('/crm/v3/objects/companies', { method: 'POST', body: { properties } });
    if (row.deal) {
      const dealProps = { dealname: row.deal.name, pipeline: 'default', dealstage: row.deal.stage };
      if (row.deal.lost_reason) dealProps.closed_lost_reason = row.deal.lost_reason;
      await hubspot.request('/crm/v3/objects/deals', {
        method: 'POST',
        body: {
          properties: dealProps,
          // deal -> company association ID 5
          associations: [{ to: { id: company.json.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }] }],
        },
      });
    }
    if (row.parent) {
      const [parent] = await hubspot.searchCompaniesByDomain(row.parent);
      if (!parent) throw new Error(`${row.domain}: parent ${row.parent} is not in HubSpot`);
      // parent -> child company association ID 13
      await hubspot.request(`/crm/v4/objects/companies/${parent.id}/associations/companies/${company.json.id}`, {
        method: 'PUT',
        body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 13 }],
      });
    }
    log(`${row.domain}: created${row.deal ? ` with deal "${row.deal.name}"` : ''}${row.parent ? ` as a child of ${row.parent}` : ''}`);
  }
}

export async function seedAirtableCrm(airtable, { reset = false } = {}, log) {
  const table = rules.tables.crm;
  for (const row of seed) {
    const existing = await airtable.findByField(table, 'domain', row.domain);
    if (existing.length && !reset) {
      log(`${row.domain}: exists, skipped (use --reset to recreate)`);
      continue;
    }
    // Only rows this script flagged as test records are ever deleted.
    for (const record of existing.filter((r) => r.fields.test_record)) await airtable.deleteRecord(table, record.id);
    const fields = {
      domain: row.domain,
      name: row.name,
      lifecyclestage: row.lifecyclestage,
      owner: teamMember(row.owner_role).name,
      test_record: true,
    };
    if (row.deal) Object.assign(fields, { deal_name: row.deal.name, deal_stage: row.deal.stage });
    if (row.deal?.lost_reason) fields.lost_reason = row.deal.lost_reason;
    if (row.last_touch) fields.last_touch = row.last_touch;
    if (row.parent) fields.parent_domain = row.parent;
    if (row.headcount) fields.headcount = row.headcount;
    if (row.country) fields.country = row.country;
    if (row.industry) fields.industry = row.industry;
    if (row.funding_stage) fields.funding_stage = row.funding_stage;
    if (row.fresh) fields.enriched_at = new Date().toISOString();
    await airtable.createRecord(table, fields);
    log(`${row.domain}: created`);
  }
}
