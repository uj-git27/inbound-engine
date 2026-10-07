import { rules } from './rules.js';
import { hasWord } from './checks.js';

// Persona from the job title on the form. Whole words; the first matching group wins.
// "Vice President of Engineering" matches no finance pattern, so it counts as engineering.
export function persona(title) {
  const p = rules.scoring.persona;
  for (const group of ['finance_leader', 'revops_billing_finance_manager', 'founder_ceo', 'engineering']) {
    if (hasWord(title, p.patterns[group])) return { group, points: p[group] };
  }
  return { group: 'other', points: p.other };
}

export function industryTier(industry) {
  const i = rules.scoring.fit.industry;
  if (!industry) return { tier: 'unknown', points: 0 };
  if (hasWord(industry, i.core.keywords)) return { tier: 'core', points: i.core.points };
  if (hasWord(industry, i.adjacent.keywords)) return { tier: 'adjacent', points: i.adjacent.points };
  return { tier: 'other B2B', points: i.other_b2b.points };
}

const isFunded = (stage) => Boolean(stage) && !rules.scoring.fit.funded_excludes.includes(stage.toLowerCase());

// Step 5: score out of 100, fixed rules, no AI.
export function score({ lead, profile, pricing, signals }) {
  const s = rules.scoring;
  const industry = industryTier(profile.industry);
  const funded = isFunded(profile.funding_stage) ? s.fit.funded : 0;
  const who = persona(lead.title);
  const billing = s.billing_model[pricing?.model ?? 'unknown'] ?? 0;
  const seen = new Set();
  const signalPoints = (signals ?? []).reduce((sum, sig) => {
    if (seen.has(sig.type)) return sum;
    seen.add(sig.type);
    return sum + (rules.signals.points[sig.type] ?? 0);
  }, 0);
  const whyNow = Math.min(signalPoints, s.why_now.max);

  const breakdown = {
    fit: { points: industry.points + funded, max: s.fit.max, detail: `industry ${industry.tier} ${industry.points}, funded ${funded}` },
    persona: { points: who.points, max: s.persona.max, detail: who.group.replace(/_/g, ' ') },
    billing_model: { points: billing, max: s.billing_model.max, detail: pricing?.model ?? 'unknown' },
    why_now: { points: whyNow, max: s.why_now.max, detail: [...seen].join(', ').replace(/_/g, ' ') || 'no signals' },
  };
  const total = Object.values(breakdown).reduce((sum, part) => sum + part.points, 0);
  return { total, breakdown };
}

// Step 6.
export const tierOf = (total) => (total >= rules.tiers.A ? 'A' : total >= rules.tiers.B ? 'B' : 'C');

export function unknownFacts({ profile, person }) {
  const unknown = [];
  if (profile.headcount_min === null) unknown.push('headcount');
  if (!profile.country) unknown.push('country');
  if (!profile.industry) unknown.push('industry');
  if (!profile.funding_stage) unknown.push('funding');
  if (!person) unknown.push('person');
  return unknown;
}
