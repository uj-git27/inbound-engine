import { rules, teamMember } from './rules.js';
import { safe, buildBrief, companyFacts, showPhone, historyBlock, whyNowLines } from './brief.js';
import { ACTIONS, CONFIRM_TEXT, actionLinks, verdictLinks, buttonValue } from './links.js';
import { buildEmail } from './emails.js';

function who(lead) {
  const company = lead.company ? `${safe(lead.company)} (${safe(lead.domain)})` : safe(lead.domain);
  return `${safe(lead.name)}, ${safe(lead.title) || 'no title given'} at ${company}`;
}

// The lead picks a time on the booking page after the form, so an alert usually arrives first.
const asked = (lead) => (lead.requested_local ? `Time the lead picked: ${safe(lead.requested_local)}` : 'The lead picks a time on the booking page.');
const WAITING = `Not booked yet: waiting for the lead to pick a time. If they don't within ${rules.booking.no_pick_minutes} minutes, the next free slot is booked. The booking will be posted in this thread.`;
const VERDICTS = ['verdict_right', 'verdict_wrong_A', 'verdict_wrong_B', 'verdict_wrong_C'];

function bookingLine(booking) {
  if (!booking) return null;
  if (booking.cancelled) return 'Meeting cancelled.';
  if (!booking.booked) return `:warning: Not booked: ${safe(booking.reason)}`;
  const link = booking.eventLink ? ` · <${booking.eventLink}|open event>` : '';
  return `Booked: ${booking.slot}${booking.changed ? ' (the time they asked for was taken, so this is the next free one)' : ''} · invite sent${link}`;
}

// Every alert starts with "For: <name>". `body` is the message; `actions` are offered as Slack
// buttons when the Slack app has interactivity on, otherwise as signed links under the text.
// Alerts about a tier decision (a scored lead or a disqualified one) also carry the verdict:
// "Right tier" and "Wrong: A / B / C". Choosing a different tier moves the lead to that tier's owner.
// Customer, open-deal and expansion alerts have no tier, so they have no verdict.
function alert(role, name, lead, lines, actions, env, { verdict = false } = {}) {
  const member = teamMember(role);
  const owner = name || member.name;
  const body = [`${rules.alert_prefix}${owner}`, ...lines].filter(Boolean).join('\n');
  const footer = [actions.length ? `Actions: ${actionLinks(lead.lead_id, actions, env)}` : null, verdict ? verdictLinks(lead.lead_id, env) : null];
  return { channel: member.channel, owner, role, leadId: lead.lead_id, actions, verdict, body, text: [body, ...footer].filter(Boolean).join('\n') };
}

// Slack limits a text block to 3,000 characters, so a long brief is split at line breaks.
function sections(body, limit = 2900) {
  const chunks = [];
  let current = '';
  for (const line of body.split('\n')) {
    const piece = line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
    if (current && current.length + piece.length + 1 > limit) { chunks.push(current); current = piece; } else current = current ? `${current}\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } }));
}

const button = (leadId, action, env, style) => ({
  type: 'button',
  action_id: action,
  text: { type: 'plain_text', text: ACTIONS[action] },
  value: buttonValue(leadId, action, env),
  ...(style ? { style } : {}),
  // Slack asks "are you sure?" before the click is sent, so nothing runs by accident.
  confirm: {
    title: { type: 'plain_text', text: `${ACTIONS[action]}?` },
    text: { type: 'plain_text', text: CONFIRM_TEXT[action] },
    confirm: { type: 'plain_text', text: 'Yes' },
    deny: { type: 'plain_text', text: 'Cancel' },
  },
});

export function alertBlocks(a, env = process.env) {
  const blocks = sections(a.body);
  if (a.actions.length) {
    blocks.push({ type: 'actions', elements: a.actions.map((action, i) => button(a.leadId, action, env, i === 0 ? 'primary' : action === 'not_qualified' || action === 'approve_rejection' ? 'danger' : undefined)) });
  }
  if (a.verdict) blocks.push({ type: 'actions', elements: VERDICTS.map((action) => button(a.leadId, action, env)) });
  return blocks;
}

// Posts an alert. Returns Slack's reply, which later messages use to reply in the same thread.
// With `thread`, the alert is posted as a reply in that thread.
export function postAlert(slack, a, env = process.env, thread) {
  const hasButtons = a.leadId && (a.actions.length || a.verdict);
  const extra = thread ? { thread } : {};
  if (hasButtons && env.SLACK_SIGNING_SECRET) return slack.postMessage(a.channel, a.body, { ...extra, blocks: alertBlocks(a, env) });
  return slack.postMessage(a.channel, a.text, extra);
}

// Rewrites an alert posted earlier (`message` is Slack's reply to that post), keeping its buttons.
export function updateAlert(slack, a, env = process.env, message) {
  const hasButtons = a.leadId && (a.actions.length || a.verdict);
  if (hasButtons && env.SLACK_SIGNING_SECRET) return slack.updateMessage(message, a.body, { blocks: alertBlocks(a, env) });
  return slack.updateMessage(message, a.text);
}

// The AE's intro email, shown in full for review, with one action to send it. Nothing is sent
// until the AE chooses to; the text is the approved "ae_intro" template filled with sourced facts.
export function introDraft({ lead, outcome, booking, env }) {
  const email = buildEmail('ae_intro', { lead, outcome, booking, env });
  const ae = teamMember('ae');
  const body = [
    `*Optional intro email from ${safe(email.fromName)}* (not sent; review it, then send it if you want to):`,
    `*Subject:* ${safe(email.subject)}`,
    ...email.text.split('\n').map((line) => `> ${safe(line)}`),
  ].join('\n');
  return {
    channel: ae.channel, owner: ae.name, role: 'ae', leadId: lead.lead_id, actions: ['send_intro'], verdict: false, body,
    text: `${body}\nActions: ${actionLinks(lead.lead_id, ['send_intro'], env)}`,
  };
}

export function customerAlert({ lead, outcome, env }) {
  return alert('csm', outcome.company.owner, lead, [
    `*Existing customer asked for a demo*`,
    who(lead),
    asked(lead),
    `CRM: ${safe(outcome.company.name)} is a customer. No meeting is booked until you confirm.`,
    historyBlock(outcome.history),
  ], ['confirm_meeting'], env);
}

export function openDealAlert({ lead, outcome, env }) {
  const deal = outcome.company.openDeal;
  return alert('ae', outcome.company.owner, lead, [
    `*Demo request from an account with an open deal*`,
    who(lead),
    asked(lead),
    `CRM: open deal "${safe(deal.name)}" (stage ${safe(deal.stage)}). No meeting is booked until you confirm.`,
    historyBlock(outcome.history),
  ], ['confirm_meeting'], env);
}

// A company whose deal was lost before goes back to the old deal's owner with the history.
export function closedLostAlert({ lead, outcome, env }) {
  const { company } = outcome;
  const deal = company.closedLost;
  const history = [
    deal.name ? `deal "${safe(deal.name)}" was closed lost` : 'a deal was closed lost',
    company.lostReason ? `lost reason "${safe(company.lostReason)}"` : null,
    company.lastTouch ? `last touch ${safe(company.lastTouch)}` : null,
  ].filter(Boolean).join(', ');
  return alert('ae', company.owner, lead, [
    `*Returning account: previously closed lost*`,
    who(lead),
    asked(lead),
    outcome.history ? historyBlock(outcome.history) : `CRM history: ${history}.`,
    'They came back on their own. No meeting is booked until you confirm.',
  ], ['confirm_meeting'], env);
}

// Customer -> CS channel; open deal -> AE channel; addressed to that account's owner.
export function expansionAlert({ lead, outcome, env }) {
  const { expansion, profile } = outcome;
  const known = expansion.company;
  return alert(known.isCustomer ? 'csm' : 'ae', known.owner, lead, [
    `*Expansion lead*`,
    who(lead),
    asked(lead),
    `Family: its ${expansion.relation} ${safe(expansion.name || expansion.domain)} (${safe(expansion.domain)}) ${known.isCustomer ? 'is a customer' : `has an open deal "${safe(known.openDeal.name)}"`} _(family link source: ${safe(expansion.source ?? profile.source)}${expansion.url ? `, <${expansion.url}|evidence>` : ''})_.`,
    `Company: ${companyFacts(profile)}`,
    outcome.history ? historyBlock(outcome.history).replace(':*', ` of ${safe(expansion.name || expansion.domain)}:*`) : null,
    'No meeting is booked until you confirm.',
  ], ['confirm_meeting'], env);
}

// `emailNote` says what happens with the rejection email: nothing is sent until the reviewer acts.
export function disqualifiedAlert({ lead, outcome, env, emailNote }) {
  return alert('reviewer', null, lead, [
    `*Disqualified: ${safe(outcome.label)}*`,
    who(lead),
    asked(lead),
    `Reason: ${safe(outcome.reason)}`,
    outcome.profile ? `Company: ${companyFacts(outcome.profile)}` : null,
    // Researched anyway for a size rejection: what changed in the last 12 months.
    ...(outcome.signals ? whyNowLines(outcome) : []),
    historyBlock(outcome.history),
    `No meeting booked. ${emailNote}`,
  ], ['approve_rejection', 'nurture', 'confirm_anyway'], env, { verdict: true });
}

const TIER = {
  A: { role: 'ae', actions: [] },
  B: { role: 'sdr', actions: ['confirm_meeting', 'not_qualified'] },
  C: { role: 'reviewer', actions: ['send_sdr', 'nurture', 'approve_rejection', 'find_contact'] },
};

export function tierAlert({ lead, outcome, booking, contact, env, note }, tier = outcome.tier) {
  const t = TIER[tier];
  // A lead moved here by a person keeps the engine's own result in the heading.
  const scored = outcome.score === undefined ? `Not scored (the engine disqualified it: ${safe(outcome.label ?? 'see reason')})` : `Tier ${outcome.tier} · ${outcome.score}/100`;
  const moved = tier !== outcome.tier ? ` · now handled as Tier ${tier}` : '';
  return alert(t.role, null, lead, [
    `*${scored}*${moved}${tier === 'B' ? ' · SDR to take' : ''}`,
    who(lead),
    tier === 'C' && !booking ? 'No meeting booked: Tier C never books by itself.' : bookingLine(booking) ?? WAITING,
    buildBrief({ lead, outcome, contact, env }),
    outcome.flags?.length ? `*Flags:* ${outcome.flags.map(safe).join('; ')}` : null,
    note ? `_${note}_` : null,
  ], t.actions, env, { verdict: tier === outcome.tier });
}

export function lowConfidenceAlert({ lead, outcome, env }) {
  return alert('reviewer', null, lead, [
    `*Low confidence: Tier ${outcome.tier} · ${outcome.score}/100*`,
    who(lead),
    `Unknown facts (${outcome.unknown.length}): ${outcome.unknown.join(', ')}. The score is built on thin data; the booking still goes ahead.`,
  ], [], env);
}

const plain = (role, lines) => {
  const member = teamMember(role);
  const text = [`${rules.alert_prefix}${member.name}`, ...lines.filter(Boolean)].join('\n');
  return { channel: member.channel, owner: member.name, role, actions: [], body: text, text };
};

export function rateLimitedAlert({ lead, outcome }) {
  return plain('revops', [`*Rate limited*`, who(lead), `Reason: ${safe(outcome.reason)}`, 'No paid lookups were run and nothing was booked.']);
}

export function duplicateAlert({ lead, outcome }) {
  return plain('revops', [`*Duplicate skipped*`, who(lead), `Reason: ${safe(outcome.reason)}`, 'Nothing was looked up or booked, and no email was sent.']);
}

export function engineErrorAlert({ lead, error, booking }) {
  return plain('revops', [
    `*Engine error*`,
    who(lead),
    `Error: ${safe(error)}`,
    booking ? `Fail open: ${bookingLine(booking)}` : 'Fail open: the meeting could not be booked either.',
  ]);
}

export { bookingLine };

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
