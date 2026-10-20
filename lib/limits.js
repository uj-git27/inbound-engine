import { rules } from './rules.js';

// Rate limits: 3 per company domain per hour, 40 paid runs per hour in total.
// Demo aliases are exempt. In DEMO_MODE the per-domain limit is off too (a demo reuses one domain
// over and over, and nothing reaches a real lead); the total cap on paid runs stays. Returns a reason or null.
export async function rateLimited(lead, recordId, airtable, now = Date.now()) {
  if (lead.demo) return null;
  const since = new Date(now - 3_600_000).toISOString();
  const recent = (await airtable.findSince(rules.tables.leads, 'received_at', since)).filter((r) => r.id !== recordId);
  const sameDomain = recent.filter((r) => r.fields.domain === lead.domain && !r.fields.demo).length;
  if (process.env.DEMO_MODE !== 'true' && sameDomain >= rules.limits.per_domain_per_hour) {
    return `${sameDomain} other requests from ${lead.domain} in the last hour (limit ${rules.limits.per_domain_per_hour})`;
  }
  const paidRuns = recent.filter((r) => Number(r.fields.paid_calls) > 0 && !r.fields.demo).length;
  if (paidRuns >= rules.limits.paid_runs_per_hour) {
    return `${paidRuns} paid runs in the last hour (limit ${rules.limits.paid_runs_per_hour})`;
  }
  return null;
}
