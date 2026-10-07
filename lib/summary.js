import { rules, teamMember } from './rules.js';

// Monday summary to #revops-engine: leads by tier, reviewer overrides, rep "wrong tier" verdicts.
export async function buildSummary(airtable, now = Date.now()) {
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const rows = (await airtable.findSince(rules.tables.leads, 'received_at', since)).map((r) => r.fields);
  const counts = {};
  for (const row of rows) {
    const key = row.decision || row.status || 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const overrides = rows.filter((r) => rules.review_override_actions.some((a) => String(r.reviewer_actions ?? '').includes(` ${a}`)));
  const wrong = rows.filter((r) => String(r.rep_verdict ?? '').startsWith('Wrong'));
  const right = rows.filter((r) => r.rep_verdict === 'Right tier');
  const paid = rows.reduce((sum, r) => sum + (Number(r.paid_calls) || 0), 0);
  const member = teamMember('revops');
  const text = [
    `${rules.alert_prefix}${member.name}`,
    `*Weekly summary: ${rows.length} demo requests in the last 7 days*`,
    Object.keys(counts).length ? Object.entries(counts).sort().map(([k, v]) => `${k}: ${v}`).join(' · ') : 'No leads this week.',
    `Reviewer overrides: ${overrides.length}${overrides.length ? ` (${overrides.map((r) => r.domain).join(', ')})` : ''}`,
    `Rep verdicts: ${right.length} right, ${wrong.length} wrong${wrong.length ? ` (${wrong.map((r) => `${r.domain} ${r.tier}→${r.rep_verdict.slice(-1)}`).join(', ')})` : ''}`,
    `Paid lookups: ${paid}`,
  ].join('\n');
  return { channel: member.channel, text, total: rows.length };
}
