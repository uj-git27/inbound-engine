import { rules } from './rules.js';
import { showPhone } from './brief.js';
import { contactFoundAlert } from './alerts.js';
import { loadLead, saveState } from './state.js';

// Step 6b: contact enrichment, after the invite and the brief. Clay first; if no callback arrives
// within 90 seconds, Apollo's person match and then FullEnrich for the phone. Every value is
// labelled with its source, and a follow-up is posted to the same channel.
export async function enrichContact({ leadId, connectors, env = process.env, waitForClay = true }) {
  const { airtable, slack, research, fullenrich, sleep } = connectors;
  const calls = [];
  const notes = [];

  if (waitForClay) {
    const deadline = Date.now() + rules.limits.clay_wait_seconds * 1000;
    while (Date.now() < deadline) {
      await sleep(10_000);
      const current = await loadLead(airtable, leadId);
      // The Clay callback saved the contact and posted its own follow-up.
      if (current?.record.fields.clay_payload) return { source: 'Clay' };
    }
    notes.push(`No Clay callback within ${rules.limits.clay_wait_seconds} seconds; used the fallback.`);
  }

  const loaded = await loadLead(airtable, leadId);
  if (!loaded?.state) return { source: 'none' };
  const { record, state } = loaded;
  const { lead } = state;
  const contact = { ...state.contact, pending: false };

  if (!contact.person) contact.person = state.outcome.person ?? (await research.person(lead, { calls, notes }));
  if (!contact.phone) {
    try {
      calls.push('fullenrich_phone');
      const phone = await fullenrich.findPhone({ name: lead.name, domain: lead.domain, company: lead.company, linkedin: contact.person?.linkedin });
      if (phone) Object.assign(contact, { phone, phone_source: 'FullEnrich' });
    } catch (err) {
      notes.push(`FullEnrich failed: ${err.message}`);
    }
  }

  state.contact = contact;
  const paid = [record.fields.paid_calls_detail, ...calls].filter(Boolean).join(', ');
  await saveState(airtable, record.id, state, contactFields(contact, env, {
    paid_calls: paid ? paid.split(', ').length : 0,
    paid_calls_detail: paid,
    notes: [record.fields.notes, ...notes].filter(Boolean).join('\n'),
  }));
  const followUp = contactFoundAlert({ channel: state.channel, lead, contact, env });
  await slack.postMessage(followUp.channel, followUp.text);
  return { source: 'fallback', contact };
}

// Airtable columns for a contact. The phone is masked in DEMO_MODE before it is stored.
export function contactFields(contact, env = process.env, extra = {}) {
  const fields = { ...extra };
  const p = contact.person;
  if (p) {
    Object.assign(fields, {
      linkedin: p.linkedin ?? '', person_title: p.title ?? '', role_start: p.role_start ?? '',
      previous_companies: (p.previous_companies ?? []).join(', '), person_source: p.source ?? '',
    });
  }
  if (contact.phone) Object.assign(fields, { phone: showPhone(contact.phone, env), phone_source: contact.phone_source ?? '' });
  return fields;
}
