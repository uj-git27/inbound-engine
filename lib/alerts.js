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
const NOT_BOOKED = '_Nothing has been booked. Brief, booking and action links come in the next phase._';

function companyLine(profile) {
  if (!profile) return null;
  const size = profile.headcount_min === null ? 'headcount unknown'
    : profile.headcount_min === profile.headcount_max ? `${profile.headcount_min} staff` : `${profile.headcount_min}-${profile.headcount_max} staff`;
  const facts = [size, profile.country ?? 'HQ unknown', profile.industry ?? 'industry unknown', profile.funding_stage ?? 'funding unknown'];
  return `Company: ${facts.map(safe).join(' · ')} _(source: ${safe(profile.source)})_`;
}

function historyLine(company) {
  if (!company) return null;
  const parts = [company.lifecyclestage || 'no stage', company.lostReason && `lost: ${company.lostReason}`, company.lastTouch && `last touch ${company.lastTouch}`];
  return `History: known in the CRM (${parts.filter(Boolean).map(safe).join(', ')})`;
}

// Every alert starts with "For: <name>".
export function alertFor(role, name, lines) {
  const member = teamMember(role);
  const owner = name || member.name;
  return { channel: member.channel, owner, text: [`${rules.alert_prefix}${owner}`, ...lines.filter(Boolean)].join('\n') };
}

export function customerAlert(lead, company) {
  return alertFor('csm', company.owner, [
    `*Existing customer asked for a demo*${demoTag(lead)}`,
    who(lead),
    slot(lead),
    `CRM: ${safe(company.name)} is a customer.`,
    NOT_BOOKED,
  ]);
}

export function openDealAlert(lead, company) {
  return alertFor('ae', company.owner, [
    `*Demo request from an account with an open deal*${demoTag(lead)}`,
    who(lead),
    slot(lead),
    `CRM: open deal "${safe(company.openDeal.name)}" (stage ${safe(company.openDeal.stage)}).`,
    NOT_BOOKED,
  ]);
}

// Customer -> CS channel; open deal -> AE channel; addressed to that account's owner.
export function expansionAlert(lead, outcome) {
  const { expansion, profile } = outcome;
  const known = expansion.company;
  return alertFor(known.isCustomer ? 'csm' : 'ae', known.owner, [
    `*Expansion lead*${demoTag(lead)}`,
    who(lead),
    slot(lead),
    `Family: its ${expansion.relation} ${safe(expansion.name || expansion.domain)} (${safe(expansion.domain)}) ${known.isCustomer ? 'is a customer' : `has an open deal "${safe(known.openDeal.name)}"`}.`,
    companyLine(profile),
    NOT_BOOKED,
  ]);
}

export function disqualifiedAlert(lead, outcome) {
  return alertFor('reviewer', null, [
    `*Disqualified: ${safe(outcome.label)}*${demoTag(lead)}`,
    who(lead),
    `Reason: ${safe(outcome.reason)}`,
    companyLine(outcome.profile),
    '_No meeting booked. The rejection email is only sent after approval (next phase)._',
  ]);
}

const TIER_ROLE = { A: 'ae', B: 'sdr', C: 'reviewer' };

export function tierAlert(lead, outcome) {
  const b = outcome.breakdown;
  const part = (label, p) => `${label} ${p.points}/${p.max} (${safe(p.detail)})`;
  return alertFor(TIER_ROLE[outcome.tier], null, [
    `*Tier ${outcome.tier} · ${outcome.score}/100*${demoTag(lead)}`,
    who(lead),
    slot(lead),
    companyLine(outcome.profile),
    historyLine(outcome.company),
    `Why this tier: ${part('fit', b.fit)}; ${part('persona', b.persona)}; ${part('billing model', b.billing_model)}; ${part('why now', b.why_now)}`,
    outcome.pricing?.quote && `Pricing evidence: "${safe(outcome.pricing.quote)}"`,
    ...(outcome.signals ?? []).map((s) => `Why now: ${safe(s.date)} <${s.url}|${safe(s.title || s.type)}>`),
    outcome.flags.length ? `Flags: ${outcome.flags.map(safe).join('; ')}` : null,
    outcome.signals_built ? null : '_Pricing and news signals are not built yet, so billing model and why-now score 0 for now._',
    NOT_BOOKED,
  ]);
}

export function lowConfidenceAlert(lead, outcome) {
  return alertFor('reviewer', null, [
    `*Low confidence: Tier ${outcome.tier} · ${outcome.score}/100*${demoTag(lead)}`,
    who(lead),
    `Unknown facts (${outcome.unknown.length}): ${outcome.unknown.join(', ')}. The score is built on thin data; please take a look.`,
  ]);
}
