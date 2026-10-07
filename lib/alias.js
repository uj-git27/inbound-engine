import { rules } from './rules.js';

// "jainutsav67+newrelic.com@gmail.com" stands in for newrelic.com: any company, without adding
// it to rules.json first. The mailbox it belongs to is set in rules.json (demo_alias_mailbox).
export function aliasDomain(email) {
  const [user, host] = rules.demo_alias_mailbox.split('@');
  const m = new RegExp(`^${user}\\+([a-z0-9-]+(?:\\.[a-z0-9-]+)+)@${host.replace(/\./g, '\\.')}$`).exec(email ?? '');
  return m ? m[1] : null;
}

// Demo aliases map an email to a company domain and tag the lead DEMO: a fixed alias from
// rules.json, or the general form above.
export function applyAlias(lead) {
  const alias = rules.demo_aliases[lead.email] ?? aliasDomain(lead.email);
  if (alias) Object.assign(lead, { domain: alias, demo: true });
  return lead;
}
