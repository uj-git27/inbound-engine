import { rules, teamMember } from './rules.js';
import { seed } from './seed.js';
import seededHistory from '../data/crm-history.json' with { type: 'json' };

const CLOSED = ['closedwon', 'closedlost'];

// The activity HubSpot keeps against a company, and the fields read from each kind.
export const HISTORY_OBJECTS = {
  emails: ['hs_timestamp', 'hs_email_subject', 'hs_email_direction', 'hs_email_status', 'hubspot_owner_id', 'ie_owner_name'],
  calls: ['hs_timestamp', 'hs_call_title', 'hs_call_status', 'hubspot_owner_id', 'ie_owner_name'],
  meetings: ['hs_timestamp', 'hs_meeting_title', 'hs_meeting_outcome', 'hubspot_owner_id', 'ie_owner_name'],
  notes: ['hs_timestamp', 'hs_note_body', 'hubspot_owner_id', 'ie_owner_name'],
  deals: ['dealname', 'dealstage', 'hs_is_closed_won', 'hs_is_closed_lost', 'closed_lost_reason', 'closedate', 'hs_v2_date_entered_current_stage', 'createdate'],
};
const plain = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Every record of one kind linked to a company, with the listed properties.
export async function linkedRecords(hubspot, companyId, object, properties) {
  const ids = [];
  let after = null;
  do {
    const page = await hubspot.request(`/crm/v4/objects/companies/${companyId}/associations/${object}?limit=500${after ? `&after=${after}` : ''}`);
    ids.push(...(page.json.results ?? []).map((r) => String(r.toObjectId)));
    after = page.json.paging?.next?.after ?? null;
  } while (after);
  const records = [];
  for (let i = 0; i < ids.length; i += 100) {
    const read = await hubspot.request(`/crm/v3/objects/${object}/batch/read`, { method: 'POST', body: { inputs: ids.slice(i, i + 100).map((id) => ({ id })), properties } });
    records.push(...(read.json.results ?? []));
  }
  return records;
}

// Every provider returns the same shape, or null when the domain is not in the CRM:
// { name, lifecyclestage, isCustomer, openDeal: {name, stage} | null, owner, lostReason, lastTouch,
//   profile: { headcount, country, industry, funding_stage, enriched_at },
//   related: [{ name, domain, relation }] }   parent and subsidiary links the CRM already holds
const shape = ({ name, lifecyclestage, deals = [], owner, lostReason, lastTouch, profile = {}, related = [] }) => ({
  related: [
    ...related,
    ...(profile.parent_domain && !related.some((r) => r.domain === profile.parent_domain) ? [{ name: '', domain: profile.parent_domain, relation: 'parent' }] : []),
  ].filter((r) => r.domain),
  name: name ?? '',
  lifecyclestage: lifecyclestage ?? '',
  isCustomer: lifecyclestage === 'customer',
  openDeal: deals.find((d) => !d.closed) ?? null,
  // A deal that was lost before: the returning lead goes back to that deal's owner.
  closedLost: deals.find((d) => d.lost) ?? (lostReason ? { name: '', stage: 'closedlost', lost: true } : null),
  owner: owner ?? '',
  lostReason: lostReason ?? '',
  lastTouch: lastTouch ?? '',
  profile: {
    headcount: Number(profile.headcount) || null,
    country: profile.country || null,
    industry: profile.industry || null,
    funding_stage: profile.funding_stage || null,
    enriched_at: profile.enriched_at || null,
    parent_domain: profile.parent_domain || null,
  },
});

export function createHubspotCrm(hubspot) {
  const properties = [
    'domain', 'name', 'lifecyclestage', 'numberofemployees', 'country', 'industry',
    'ie_industry', 'ie_funding_stage', 'ie_enriched_at', 'ie_parent_domain', 'ie_owner_name', 'ie_lost_reason', 'ie_last_touch',
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
          lost: d.properties.hs_is_closed_lost === 'true',
        }));
      }
      // Parent and child companies linked in HubSpot (association 13 is parent -> child, 14 child -> parent).
      const family = await hubspot.request(`/crm/v4/objects/companies/${company.id}/associations/companies`);
      const familyLinks = family.json.results ?? [];
      let related = [];
      if (familyLinks.length) {
        const read = await hubspot.request('/crm/v3/objects/companies/batch/read', {
          method: 'POST',
          body: { inputs: familyLinks.map((r) => ({ id: String(r.toObjectId) })), properties: ['domain', 'name'] },
        });
        related = read.json.results.map((c) => {
          const types = familyLinks.find((r) => String(r.toObjectId) === String(c.id))?.associationTypes?.map((t) => t.typeId) ?? [];
          return { name: c.properties.name ?? '', domain: c.properties.domain, relation: types.includes(14) ? 'parent' : types.includes(13) ? 'subsidiary' : 'linked company' };
        });
      }
      const p = company.properties;
      return shape({
        related,
        name: p.name, lifecyclestage: p.lifecyclestage, deals, owner: p.ie_owner_name, lostReason: p.ie_lost_reason, lastTouch: p.ie_last_touch,
        profile: {
          headcount: p.numberofemployees,
          country: p.country,
          // HubSpot's own industry is a fixed list (COMPUTER_SOFTWARE); ie_industry holds free text.
          industry: p.ie_industry || p.industry?.toLowerCase().replace(/_/g, ' '),
          funding_stage: p.ie_funding_stage,
          enriched_at: p.ie_enriched_at,
          parent_domain: p.ie_parent_domain,
        },
      });
    },

    // Emails, calls, meetings, notes and deals linked to the company. Null when the domain is unknown.
    async history(domain) {
      const company = await find(domain);
      if (!company) return null;
      const kinds = Object.keys(HISTORY_OBJECTS);
      const read = await Promise.all(kinds.map((object) => linkedRecords(hubspot, company.id, object, HISTORY_OBJECTS[object])));
      const got = Object.fromEntries(kinds.map((kind, i) => [kind, read[i].map((record) => record.properties)]));
      // Names: the engine's own owner field first, then the HubSpot user the record belongs to.
      const all = [...got.emails, ...got.calls, ...got.meetings, ...got.notes];
      let owners = {};
      if (all.some((p) => !p.ie_owner_name && p.hubspot_owner_id)) {
        const list = await hubspot.request('/crm/v3/owners?limit=500');
        owners = Object.fromEntries((list.json.results ?? []).map((o) => [String(o.id), [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email]));
      }
      const ownerOf = (p) => p.ie_owner_name || owners[p.hubspot_owner_id] || '';
      let stages = {};
      if (got.deals.length) {
        const pipelines = await hubspot.request('/crm/v3/pipelines/deals');
        stages = Object.fromEntries((pipelines.json.results ?? []).flatMap((pl) => pl.stages.map((s) => [s.id, s.label])));
      }
      return {
        touches: [
          ...got.emails.map((p) => ({ type: 'email', date: p.hs_timestamp, owner: ownerOf(p), status: p.hs_email_status, incoming: p.hs_email_direction === 'INCOMING_EMAIL' })),
          ...got.calls.map((p) => ({ type: 'call', date: p.hs_timestamp, owner: ownerOf(p), status: p.hs_call_status })),
          ...got.meetings.map((p) => ({ type: 'meeting', date: p.hs_timestamp, owner: ownerOf(p), status: p.hs_meeting_outcome })),
        ],
        notes: got.notes.map((p) => ({ date: p.hs_timestamp, author: ownerOf(p), body: plain(p.hs_note_body) })),
        deals: got.deals.map((p) => ({
          name: p.dealname, stage: stages[p.dealstage] ?? p.dealstage, won: p.hs_is_closed_won === 'true', lost: p.hs_is_closed_lost === 'true',
          reason: p.closed_lost_reason ?? '', closed_at: p.closedate ?? null, entered_stage_at: p.hs_v2_date_entered_current_stage ?? p.createdate ?? null,
        })),
      };
    },

    // Creates or updates the company by domain. `fields` uses the engine's names.
    async upsertCompany(domain, fields) {
      const map = {
        name: 'name', headcount: 'numberofemployees', country: 'country', industry: 'ie_industry',
        funding_stage: 'ie_funding_stage', enriched_at: 'ie_enriched_at', parent_domain: 'ie_parent_domain',
        score: 'ie_score', tier: 'ie_tier', reasons: 'ie_reasons', signal_links: 'ie_signal_links',
        lifecyclestage: 'lifecyclestage', nurture: 'ie_nurture', rep_verdict: 'ie_rep_verdict', demo_slot: 'ie_demo_slot',
      };
      const props = {};
      for (const [key, value] of Object.entries(fields)) if (map[key] && value !== null && value !== undefined && value !== '') props[map[key]] = value;
      const existing = await find(domain);
      if (existing) await hubspot.request(`/crm/v3/objects/companies/${existing.id}`, { method: 'PATCH', body: { properties: props } });
      else await hubspot.request('/crm/v3/objects/companies', { method: 'POST', body: { properties: { domain, ...props } } });
    },

    // Creates or updates the contact by email, and links it to its company when `domain` is given.
    // Only the fields passed are written, so a later update (LinkedIn, phone) keeps the earlier ones.
    async upsertContact({ email, name, title, tier, rep_verdict, linkedin, phone, lead_source, domain }) {
      const props = { email };
      if (name) {
        const [first, ...rest] = String(name).split(' ');
        Object.assign(props, { firstname: first, lastname: rest.join(' ') });
      }
      if (title) props.jobtitle = title;
      if (tier) props.ie_tier = tier;
      if (rep_verdict) props.ie_rep_verdict = rep_verdict;
      if (linkedin) props.ie_linkedin = linkedin;
      if (phone) props.phone = phone;
      if (lead_source) props.ie_lead_source = lead_source;
      const found = await hubspot.request('/crm/v3/objects/contacts/search', {
        method: 'POST',
        body: { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['email'], limit: 1 },
      });
      let id = found.json.results?.[0]?.id;
      if (id) await hubspot.request(`/crm/v3/objects/contacts/${id}`, { method: 'PATCH', body: { properties: props } });
      else id = (await hubspot.request('/crm/v3/objects/contacts', { method: 'POST', body: { properties: props } })).json.id;
      const company = domain ? await find(domain) : null;
      if (company) await hubspot.request(`/crm/v4/objects/contacts/${id}/associations/default/companies/${company.id}`, { method: 'PUT' });
    },
  };
}

const fromRow = (f) =>
  shape({
    name: f.name,
    lifecyclestage: f.lifecyclestage,
    deals: f.deal_stage ? [{ name: f.deal_name, stage: f.deal_stage, closed: CLOSED.includes(f.deal_stage), lost: f.deal_stage === 'closedlost' }] : [],
    owner: f.owner,
    lostReason: f.lost_reason,
    lastTouch: f.last_touch,
    profile: { headcount: f.headcount, country: f.country, industry: f.industry, funding_stage: f.funding_stage, enriched_at: f.enriched_at, parent_domain: f.parent_domain },
  });

const rowFields = (fields) => {
  const allowed = ['name', 'headcount', 'country', 'industry', 'funding_stage', 'enriched_at', 'parent_domain', 'score', 'tier', 'reasons', 'signal_links', 'lifecyclestage', 'nurture', 'rep_verdict', 'demo_slot'];
  const row = Object.fromEntries(Object.entries(fields).filter(([k, v]) => allowed.includes(k) && v !== null && v !== undefined && v !== ''));
  // The Airtable nurture column is a checkbox.
  if ('nurture' in row) row.nurture = true;
  return row;
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
    // The fallback CRM keeps the latest contact on the company row.
    async upsertContact({ email, name, title }) {
      const domain = email.split('@')[1];
      const [record] = await airtable.findByField(table, 'contact_email', email);
      const fields = { contact_email: email, contact_name: name, contact_title: title };
      if (record) await airtable.updateRecord(table, record.id, fields);
      else await airtable.createRecord(table, { domain, ...fields });
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
    parent_domain: row.parent,
  }]));
  return {
    rows,
    async lookupCompany(domain) {
      return rows.has(domain) ? fromRow(rows.get(domain)) : null;
    },
    // The seeded TEST history, in the same shape the live CRM returns.
    async history(domain) {
      const row = rows.get(domain);
      if (!row) return null;
      const h = seededHistory[domain] ?? { items: [] };
      const items = h.items.map((i) => ({ ...i, owner: teamMember(i.owner_role).name }));
      const STAGES = { closedlost: 'Closed lost', closedwon: 'Closed won', presentationscheduled: 'Presentation scheduled' };
      return {
        touches: items.filter((i) => i.type !== 'note').map((i) => ({ type: i.type, date: i.date, owner: i.owner, status: i.status ?? 'SENT', incoming: false })),
        notes: items.filter((i) => i.type === 'note').map((i) => ({ date: i.date, author: i.owner, body: i.body })),
        deals: row.deal_stage ? [{
          name: row.deal_name, stage: STAGES[row.deal_stage] ?? row.deal_stage, won: row.deal_stage === 'closedwon', lost: row.deal_stage === 'closedlost',
          reason: row.lost_reason ?? '', closed_at: h.deal?.closed_at ?? null, entered_stage_at: h.deal?.entered_stage_at ?? null,
        }] : [],
      };
    },
    async upsertCompany(domain, fields) {
      rows.set(domain, { ...(rows.get(domain) ?? {}), ...rowFields(fields) });
    },
    contacts: new Map(),
    async upsertContact(contact) {
      this.contacts.set(contact.email, { ...(this.contacts.get(contact.email) ?? {}), ...contact });
    },
  };
}
