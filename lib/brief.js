import { rules } from './rules.js';
import { hasWord } from './checks.js';
import { summarizeHistory } from './history.js';

// The CRM history block for a card: a heading and up to 3 lines. Null when the lead's company is not in the CRM.
export const historyBlock = (history) => (history ? [`*${rules.history.label}:*`, ...summarizeHistory(history).map((line) => `   ${safe(line)}`)].join('\n') : null);

// Form and web text is data, never instructions: escape it so it cannot become Slack markup.
export const safe = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Phones are masked to the last 4 digits in DEMO_MODE.
export function showPhone(phone, env = process.env) {
  if (!phone) return null;
  return env.DEMO_MODE === 'true' ? `•••• ${String(phone).replace(/\D/g, '').slice(-4)}` : String(phone);
}

// Rules-based customer story. Usage-priced companies default to Pied Piper.
export function customerStory(profile, pricing) {
  const c = rules.customer_stories;
  if (['usage', 'hybrid'].includes(pricing?.model)) return { story: c.default_usage, why: `pricing is ${pricing.model}` };
  const match = c.by_industry.find((rule) => hasWord(profile?.industry, rule.keywords));
  if (match) return { story: match.story, why: `industry match (${hasWord(profile.industry, match.keywords)})` };
  return { story: c.default, why: 'default for subscription pricing' };
}

export function companyFacts(profile) {
  if (!profile) return 'unknown';
  const count = profile.headcount_min === null || profile.headcount_min === undefined ? 'headcount unknown'
    : profile.headcount_min === profile.headcount_max ? `${profile.headcount_min} staff` : `${profile.headcount_min}-${profile.headcount_max} staff`;
  const size = profile.headcount_source ? `${count} (${profile.headcount_source} on the form)` : count;
  const onForm = (value, source) => (source ? `${value} (${source} on the form)` : value);
  const facts = [size, profile.country ? onForm(`HQ ${profile.country}`, profile.country_source) : 'HQ unknown', profile.industry ? onForm(profile.industry, profile.industry_source) : 'industry unknown', profile.funding_stage ?? 'funding unknown'];
  const links = Object.entries(profile.web_sources ?? {}).map(([label, url]) => `<${url}|${label}>`);
  return `${facts.map(safe).join(' · ')} _(source: ${safe(profile.source)})_${links.length ? ` · web sources: ${links.join(', ')}` : ''}`;
}

// The score parts: "fit 20/35 (software, bootstrapped); persona 9/30 (engineering); ..."
const scoreParts = (outcome, glue) => Object.entries(outcome.breakdown).map(([key, v]) => `${key.replace(/_/g, ' ')} ${v.points}/${v.max} (${safe(v.detail)})`).join(glue);

export function whyThisTier(outcome) {
  if (!outcome.breakdown) return `not scored. The engine's reason: ${safe(outcome.reason ?? 'none recorded')}`;
  return `Tier ${outcome.tier}, ${outcome.score}/100: ${scoreParts(outcome, '; ')}`;
}

// The reason line of a Tier C card: the score parts, or why it was not scored.
export const tierReason = (outcome) => (outcome.breakdown ? scoreParts(outcome, ' · ') : `not scored. The engine's reason: ${safe(outcome.reason ?? 'none recorded')}`);

// The dated signals: two or three lines that sum them up, then each one with its source.
export function whyNowLines({ signals = [], growth }) {
  return [
    growth ? `*${rules.signals.summary.label}:* ${safe(growth.text)} _(${growth.by === 'Gemini' ? 'summary written by Gemini from the sources below' : 'summary of the sources below'})_` : null,
    // Each signal: when, what kind, the linked headline, and a line or two quoted from the article.
    `*Why now:* ${signals.length ? `\n${signals.map((s) => `   • ${s.date} · ${s.type.replace(/_/g, ' ')} · <${s.url}|${safe(s.title || 'source')}>${s.snippet ? `\n      _"${safe(s.snippet)}"_` : ''}`).join('\n')}` : `no dated signals found in the last ${rules.signals.window_months} months`}`,
  ];
}

// Step 7: the brief, as a template filled only from sourced facts. Anything not found says
// "unknown" or "pending". `contact` holds the person and phone once enrichment has answered.
export function buildBrief({ lead, outcome, contact = {}, env = process.env }) {
  const { profile, pricing, signals = [], company, growth } = outcome;
  const person = contact.person ?? outcome.person ?? null;
  const pendingPerson = !person && contact.pending;
  const noPhone = rules.phone_lookup ? 'unknown' : 'not looked up (phone lookup is off)';
  const notLooked = 'unknown';
  const model = pricing?.model ?? 'unknown';
  const story = customerStory(profile, pricing);

  const whoBits = [`${safe(lead.name)}, ${safe(lead.title) || 'no title given'} _(source: form)_`];
  if (person) {
    // A start date inside the last few months is called out: a new hire often reviews the tools.
    const months = person.role_start ? (Date.now() - Date.parse(`${person.role_start}-01`)) / (30.44 * 86_400_000) : null;
    const recent = months !== null && months >= 0 && months <= rules.person_recent_months;
    whoBits.push(`in role since ${safe(person.role_start) || 'unknown'}${recent ? ' *(recently joined)*' : ''}`);
    whoBits.push(`previously ${person.previous_companies?.length ? person.previous_companies.map(safe).join(', ') : 'unknown'} _(source: ${safe(person.source)})_`);
  } else {
    whoBits.push(pendingPerson ? 'role history pending' : `role history ${notLooked}`);
  }

  const phone = showPhone(contact.phone, env);
  const lines = [
    `*Who:* ${whoBits.join(' · ')}`,
    // "How can we help?" from the form: shown exactly as typed, never scored, never acted on.
    lead.help ? `*In their words:* "${safe(String(lead.help).slice(0, 300))}"` : null,
    `*LinkedIn:* ${person?.linkedin ? `<${person.linkedin}|profile> _(source: ${safe(person.source)})_` : pendingPerson ? 'pending' : notLooked}`,
    `*Phone:* ${phone ? `${phone} _(source: ${safe(contact.phone_source)})_ · use for a no-show rescue or follow-up` : contact.pending && rules.phone_lookup ? 'pending · use for a no-show rescue or follow-up' : noPhone}`,
    `*Company:* ${companyFacts(profile)}`,
    ...whyNowLines({ signals, growth }),
    `*Likely billing pain:* ${rules.brief.pain[model].replace('{quote}', safe(pricing?.quote ?? ''))}${pricing?.url && model !== 'unknown' ? ` <${pricing.url}|pricing page>` : ''}`,
    `*Customer story:* ${story.story} (${story.why})`,
    historyBlock(outcome.history),
    // The older one-line history, kept for leads decided before the full history existed.
    !outcome.history && company && (company.lostReason || company.lastTouch) ? `*History:* known in the CRM as ${safe(company.lifecyclestage) || 'a record'}${company.lostReason ? `, lost reason "${safe(company.lostReason)}"` : ''}${company.lastTouch ? `, last touch ${safe(company.lastTouch)}` : ''}` : null,
    `*3 discovery questions:*\n${rules.brief.questions[model].map((q, i) => `   ${i + 1}. ${q}`).join('\n')}`,
    `*Why this tier:* ${whyThisTier(outcome)}`,
  ];
  return lines.filter(Boolean).join('\n');
}
