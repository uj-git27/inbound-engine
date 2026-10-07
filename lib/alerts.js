import { rules, teamMember } from './rules.js';
import { choiceText } from './tally.js';
import { safe, buildBrief, companyFacts, showPhone } from './brief.js';
import { actionLinks, verdictLinks } from './links.js';

function who(lead) {
  const company = lead.company ? `${safe(lead.company)} (${safe(lead.domain)})` : safe(lead.domain);
  return `${safe(lead.name)}, ${safe(lead.title) || 'no title given'} at ${company}`;
}

const asked = (lead) => `Requested slot: ${choiceText(lead.first_choice) || 'none given'} · buyer time zone ${safe(lead.timezone) || 'unknown'}`;
const demoTag = (lead) => (lead.demo ? ' `DEMO`' : '');

function bookingLine(booking) {
  if (!booking) return null;
  if (!booking.booked) return `:warning: Not booked: ${safe(booking.reason)}`;
  const link = booking.eventLink ? ` · <${booking.eventLink}|open event>` : '';
  return `Booked: ${booking.slot}${booking.changed ? ' (the requested slot was not available)' : ''} · invite sent${link}`;
}

// Every alert starts with "For: <name>" and ends with the action links and the tier verdict links.
function alert(role, name, lead, lines, actions, env) {
  const member = teamMember(role);
  const owner = name || member.name;
  const footer = [
    actions.length ? `Actions: ${actionLinks(lead.lead_id, actions, env)}` : null,
    verdictLinks(lead.lead_id, env),
  ];
  return { channel: member.channel, owner, role, text: [`${rules.alert_prefix}${owner}`, ...lines, ...footer].filter(Boolean).join('\n') };
}

export function customerAlert({ lead, outcome, env }) {
  return alert('csm', outcome.company.owner, lead, [
    `*Existing customer asked for a demo*${demoTag(lead)}`,
    who(lead),
    asked(lead),
    `CRM: ${safe(outcome.company.name)} is a customer. No meeting is booked until you confirm.`,
  ], ['confirm_meeting'], env);
}

export function openDealAlert({ lead, outcome, env }) {
  const deal = outcome.company.openDeal;
  return alert('ae', outcome.company.owner, lead, [
    `*Demo request from an account with an open deal*${demoTag(lead)}`,
    who(lead),
    asked(lead),
    `CRM: open deal "${safe(deal.name)}" (stage ${safe(deal.stage)}). No meeting is booked until you confirm.`,
  ], ['confirm_meeting'], env);
}

// Customer -> CS channel; open deal -> AE channel; addressed to that account's owner.
export function expansionAlert({ lead, outcome, env }) {
  const { expansion, profile } = outcome;
  const known = expansion.company;
  return alert(known.isCustomer ? 'csm' : 'ae', known.owner, lead, [
    `*Expansion lead*${demoTag(lead)}`,
    who(lead),
    asked(lead),
    `Family: its ${expansion.relation} ${safe(expansion.name || expansion.domain)} (${safe(expansion.domain)}) ${known.isCustomer ? 'is a customer' : `has an open deal "${safe(known.openDeal.name)}"`} _(family link source: ${safe(expansion.source ?? profile.source)}${expansion.url ? `, <${expansion.url}|evidence>` : ''})_.`,
    `Company: ${companyFacts(profile)}`,
    'No meeting is booked until you confirm.',
  ], ['confirm_meeting'], env);
}

export function disqualifiedAlert({ lead, outcome, env }) {
  return alert('reviewer', null, lead, [
    `*Disqualified: ${safe(outcome.label)}*${demoTag(lead)}`,
    who(lead),
    asked(lead),
    `Reason: ${safe(outcome.reason)}`,
    outcome.profile ? `Company: ${companyFacts(outcome.profile)}` : null,
    'No meeting booked. The rejection email (with a product tour link) is sent only if you approve it.',
  ], ['approve_rejection', 'confirm_anyway'], env);
}

const TIER = {
  A: { role: 'ae', actions: ['approve_email'] },
  B: { role: 'sdr', actions: ['promote_ae'] },
  C: { role: 'reviewer', actions: ['send_sdr', 'nurture', 'approve_rejection', 'find_contact'] },
};

export function tierAlert({ lead, outcome, booking, contact, env }, tier = outcome.tier) {
  const t = TIER[tier];
  return alert(t.role, null, lead, [
    `*Tier ${outcome.tier} · ${outcome.score}/100*${demoTag(lead)}${tier === 'B' && booking?.booked ? ' · SDR to take' : ''}`,
    who(lead),
    tier === 'C' && !booking ? `${asked(lead)} · no meeting booked` : bookingLine(booking) ?? asked(lead),
    buildBrief({ lead, outcome, contact, env }),
    outcome.flags?.length ? `*Flags:* ${outcome.flags.map(safe).join('; ')}` : null,
    tier === 'A' && booking?.booked ? '_A pre-demo email is drafted. It is sent only if you approve it._' : null,
  ], t.actions, env);
}

export function lowConfidenceAlert({ lead, outcome, env }) {
  return alert('reviewer', null, lead, [
    `*Low confidence: Tier ${outcome.tier} · ${outcome.score}/100*${demoTag(lead)}`,
    who(lead),
    `Unknown facts (${outcome.unknown.length}): ${outcome.unknown.join(', ')}. The score is built on thin data; the booking still goes ahead.`,
  ], [], env);
}

const plain = (role, lines) => {
  const member = teamMember(role);
  return { channel: member.channel, owner: member.name, role, text: [`${rules.alert_prefix}${member.name}`, ...lines.filter(Boolean)].join('\n') };
};

export function rateLimitedAlert({ lead, outcome }) {
  return plain('revops', [`*Rate limited*${demoTag(lead)}`, who(lead), `Reason: ${safe(outcome.reason)}`, 'No paid lookups were run and nothing was booked.']);
}

export function duplicateAlert({ lead, outcome }) {
  return plain('revops', [`*Duplicate skipped*${demoTag(lead)}`, who(lead), `Reason: ${safe(outcome.reason)}`, 'Nothing was looked up or booked.']);
}

export function engineErrorAlert({ lead, error, booking }) {
  return plain('revops', [
    `*Engine error*${demoTag(lead)}`,
    who(lead),
    `Error: ${safe(error)}`,
    booking ? `Fail open: ${bookingLine(booking)}` : 'Fail open: the meeting could not be booked either.',
  ]);
}

export function contactFoundAlert({ channel, lead, contact, env }) {
  const person = contact.person;
  const phone = showPhone(contact.phone, env);
  const found = [
    person?.linkedin ? `<${person.linkedin}|LinkedIn> (source: ${safe(person.source)})` : null,
    phone ? `phone ${phone} (source: ${safe(contact.phone_source)})` : null,
  ].filter(Boolean);
  const text = found.length ? `Contact found for ${safe(lead.name)}: ${found.join(', ')}` : `Contact lookup finished for ${safe(lead.name)}: nothing found (LinkedIn unknown, phone unknown).`;
  return { channel, text };
}

export function noteAlert(channel, ownerName, text) {
  return { channel, text: `${rules.alert_prefix}${ownerName}\n${text}` };
}
