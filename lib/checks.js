import { rules } from './rules.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word match, so "intern" does not match "international".
export const hasWord = (text, words) => {
  const t = ` ${String(text ?? '').toLowerCase()} `;
  return words.find((w) => new RegExp(`(^|[^a-z0-9&])${escape(w.toLowerCase())}($|[^a-z0-9&])`).test(t)) ?? null;
};

const isFake = (value) => rules.disqualify.fake_data_patterns.some((p) => new RegExp(p, 'i').test(String(value ?? '').trim()));

// Step 1: free checks, no paid calls. Returns { disqualified: {reason, label} | null, flags: [] }.
export function freeChecks(lead) {
  const d = rules.disqualify;
  const emailDomain = lead.email?.split('@')[1] ?? '';
  const flags = [];
  const dq = (reason, label = reason) => ({ disqualified: { reason, label }, flags });

  // Demo aliases stand in for a company, so their Gmail address is not "personal".
  if (!lead.demo) {
    if (d.throwaway_email_domains.includes(emailDomain)) return dq(`Throwaway email (${emailDomain})`, 'throwaway email');
    if (d.personal_email_domains.includes(emailDomain)) return dq(`Personal email (${emailDomain})`, 'personal email');
    if (d.billing_vendor_domains.includes(emailDomain)) return dq(`Works at a billing vendor (${emailDomain})`, 'billing vendor');
    if (d.fake_domains.includes(emailDomain)) return dq(`Fake data (email domain ${emailDomain})`, 'fake data');
  }
  if (isFake(lead.name) || isFake(lead.company)) return dq('Fake data (name or company)', 'fake data');

  const student = hasWord(lead.title, d.student_or_job_seeker_titles);
  if (student) return dq(`Student or job seeker (title: "${student}")`, 'student or job seeker');
  const notBuyer = hasWord(lead.title, d.not_a_buyer_titles);
  if (notBuyer) return dq(`Not a buyer (title: "${notBuyer}")`, d.not_a_buyer_label);

  // Flag, don't disqualify, when the email domain doesn't match the website (only if a website was given).
  if (lead.website && !lead.demo && lead.domain && emailDomain && lead.domain !== emailDomain) {
    flags.push(`Email domain ${emailDomain} does not match website ${lead.domain}`);
  }
  return { disqualified: null, flags };
}
