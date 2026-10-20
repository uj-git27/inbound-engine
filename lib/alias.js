import { rules } from './rules.js';

// Number of single-character edits (insert, delete, change) between two strings.
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// "jainutsav67+newrelic.com@gmail.com" stands in for newrelic.com: any company, without adding
// it to rules.json first. The mailbox it belongs to is set in rules.json (demo_alias_mailbox).
// In DEMO_MODE a typo in the mailbox (2 characters) or its host (1 character) is forgiven, so a
// slip while typing the address on stage still reads as the company. Off, the match is exact.
export function aliasDomain(email, env = process.env) {
  const [user, host] = rules.demo_alias_mailbox.split('@');
  const m = /^([^@+\s]+)\+([a-z0-9-]+(?:\.[a-z0-9-]+)+)@([^@\s]+)$/.exec(email ?? '');
  if (!m) return null;
  const [, gotUser, domain, gotHost] = m;
  if (gotUser === user && gotHost === host) return domain;
  const forgiving = env.DEMO_MODE === 'true' && editDistance(gotUser, user) <= 2 && editDistance(gotHost, host) <= 1;
  return forgiving ? domain : null;
}

// Demo aliases map an email to a company domain and tag the lead DEMO: a fixed alias from
// rules.json, or the general form above.
export function applyAlias(lead) {
  const alias = rules.demo_aliases[lead.email] ?? aliasDomain(lead.email);
  if (alias) Object.assign(lead, { domain: alias, demo: true });
  return lead;
}
