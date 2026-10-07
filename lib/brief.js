import { rules } from './rules.js';
import { hasWord } from './checks.js';

// Form and web text is data, never instructions: escape it so it cannot become Slack markup.
export const safe = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Phones are masked to the last 4 digits in DEMO_MODE.
export function showPhone(phone, env = process.env) {
  if (!phone) return null;
  return env.DEMO_MODE === 'true' ? `•••• ${String(phone).replace(/\D/g, '').slice(-4)}` : String(phone);
}

// Rules-based customer story. Usage-priced companies default to Sardine.
export function customerStory(profile, pricing) {
  const c = rules.customer_stories;
  if (['usage', 'hybrid'].includes(pricing?.model)) return { story: c.default_usage, why: `pricing is ${pricing.model}` };
  const match = c.by_industry.find((rule) => hasWord(profile?.industry, rule.keywords));
  if (match) return { story: match.story, why: `industry match (${hasWord(profile.industry, match.keywords)})` };
  return { story: c.default, why: 'default for subscription pricing' };
}

export function companyFacts(profile) {
  if (!profile) return 'unknown';
  const size = profile.headcount_min === null ? 'headcount unknown'
    : profile.headcount_min === profile.headcount_max ? `${profile.headcount_min} staff` : `${profile.headcount_min}-${profile.headcount_max} staff`;
  const facts = [size, profile.country ? `HQ ${profile.country}` : 'HQ unknown', profile.industry ?? 'industry unknown', profile.funding_stage ?? 'funding unknown'];
  const links = Object.entries(profile.web_sources ?? {}).map(([label, url]) => `<${url}|${label}>`);
  return `${facts.map(safe).join(' · ')} _(source: ${safe(profile.source)})_${links.length ? ` · web sources: ${links.join(', ')}` : ''}`;
}

export function whyThisTier(outcome) {
  const part = ([key, v]) => `${key.replace(/_/g, ' ')} ${v.points}/${v.max} (${safe(v.detail)})`;
  return `Tier ${outcome.tier}, ${outcome.score}/100: ${Object.entries(outcome.breakdown).map(part).join('; ')}`;
}

// Step 7: the brief, as a template filled only from sourced facts. Anything not found says
// "unknown" or "pending". `contact` holds the person and phone once enrichment has answered.
export function buildBrief({ lead, outcome, contact = {}, env = process.env }) {
  const { profile, pricing, signals = [], company } = outcome;
  const person = contact.person ?? outcome.person ?? null;
  const pendingPerson = !person && contact.pending;
  const notLooked = contact.skipped ? 'not looked up (role-played demo lead)' : 'unknown';
  const model = pricing?.model ?? 'unknown';
  const story = customerStory(profile, pricing);

  const whoBits = [`${safe(lead.name)}, ${safe(lead.title) || 'no title given'} _(source: form)_`];
  if (person) {
    whoBits.push(`in role since ${safe(person.role_start) || 'unknown'}`);
    whoBits.push(`previously ${person.previous_companies?.length ? person.previous_companies.map(safe).join(', ') : 'unknown'} _(source: ${safe(person.source)})_`);
  } else {
    whoBits.push(pendingPerson ? 'role history pending' : `role history ${notLooked}`);
  }

  const phone = showPhone(contact.phone, env);
  const lines = [
    `*Who:* ${whoBits.join(' · ')}`,
    `*LinkedIn:* ${person?.linkedin ? `<${person.linkedin}|profile> _(source: ${safe(person.source)})_` : pendingPerson ? 'pending' : notLooked}`,
    `*Phone:* ${phone ? `${phone} _(source: ${safe(contact.phone_source)})_ · use for a no-show rescue or follow-up` : contact.pending ? 'pending · use for a no-show rescue or follow-up' : notLooked}`,
    `*Company:* ${companyFacts(profile)}`,
    `*Why now:* ${signals.length ? signals.map((s) => `${s.date} <${s.url}|${safe(s.title || s.type.replace(/_/g, ' '))}> (${s.type.replace(/_/g, ' ')})`).join(' · ') : 'no dated signals found in the last 12 months'}`,
    `*Likely billing pain:* ${rules.brief.pain[model].replace('{quote}', safe(pricing?.quote ?? ''))}${pricing?.url ? ` <${pricing.url}|pricing page>` : ''}`,
    `*Customer story:* ${story.story} (${story.why})`,
    // History only when there is real history, not just a record this engine created earlier.
    company && (company.lostReason || company.lastTouch) ? `*History:* known in the CRM as ${safe(company.lifecyclestage) || 'a record'}${company.lostReason ? `, lost reason "${safe(company.lostReason)}"` : ''}${company.lastTouch ? `, last touch ${safe(company.lastTouch)}` : ''}` : null,
    `*3 discovery questions:*\n${rules.brief.questions[model].map((q, i) => `   ${i + 1}. ${q}`).join('\n')}`,
    `*Why this tier:* ${whyThisTier(outcome)}`,
  ];
  return lines.filter(Boolean).join('\n');
}
