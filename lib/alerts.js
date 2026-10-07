import { rules, teamMember } from './rules.js';
import { choiceText } from './tally.js';

// Form text is data: escape it so it can never become Slack markup or a link.
const safe = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function who(lead) {
  const company = lead.company ? `${safe(lead.company)} (${safe(lead.domain)})` : safe(lead.domain);
  return `${safe(lead.name)}, ${safe(lead.title) || 'no title given'} at ${company}`;
}

const slot = (lead) => `Requested slot: ${choiceText(lead.first_choice) || 'none given'} · buyer time zone ${safe(lead.timezone) || 'unknown'}`;
const demoTag = (lead) => (lead.demo ? ' `DEMO`' : '');

// Every alert starts with "For: <name>".
export function alertFor(role, name, lines) {
  const member = teamMember(role);
  return { channel: member.channel, owner: name || member.name, text: [`${rules.alert_prefix}${name || member.name}`, ...lines].join('\n') };
}

export function customerAlert(lead, company) {
  return alertFor('csm', company.owner || null, [
    `*Existing customer asked for a demo*${demoTag(lead)}`,
    who(lead),
    slot(lead),
    `CRM: ${safe(company.name)} is a customer. Nothing has been booked.`,
  ]);
}

export function openDealAlert(lead, company) {
  return alertFor('ae', company.owner || null, [
    `*Demo request from an account with an open deal*${demoTag(lead)}`,
    who(lead),
    slot(lead),
    `CRM: open deal "${safe(company.openDeal.name)}" (stage ${safe(company.openDeal.stage)}). Nothing has been booked.`,
  ]);
}

// Temporary: until scoring and routing (phases 2 and 3) are built, unsettled leads are announced here.
export function loggedAlert(lead, company) {
  const history = company
    ? `CRM: known, not active (${safe(company.lifecyclestage) || 'no stage'}${company.lostReason ? `, lost: ${safe(company.lostReason)}` : ''}${company.lastTouch ? `, last touch ${safe(company.lastTouch)}` : ''}).`
    : 'CRM: no record for this domain.';
  return alertFor('revops', null, [
    `*New demo request logged*${demoTag(lead)}`,
    who(lead),
    slot(lead),
    history,
    '_Scoring and routing are not built yet, so nothing has been booked._',
  ]);
}
