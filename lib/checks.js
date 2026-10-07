import { rules } from './rules.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word match, so "intern" does not match "international".
export const hasWord = (text, words) => {
  const t = ` ${String(text ?? '').toLowerCase()} `;
  return words.find((w) => new RegExp(`(^|[^a-z0-9&])${escape(w.toLowerCase())}($|[^a-z0-9&])`).test(t)) ?? null;
};

const isFake = (value) => rules.disqualify.fake_data_patterns.some((p) => new RegExp(p, 'i').test(String(value ?? '').trim()));

// Step 1: free checks, no paid calls. Based only on what the lead typed.
// Returns { disqualified: {reason, label, category} | null, flags: [] }. The category picks the
// automatic rejection email: personal_email, generic, vendor or investor_press.
export function freeChecks(lead) {
  const d = rules.disqualify;
  const emailDomain = lead.email?.split('@')[1] ?? '';
  const flags = [];
  const dq = (reason, label, category) => ({ disqualified: { reason, label, category }, flags });

  // Demo aliases stand in for a company, so their Gmail address is not "personal".
  if (!lead.demo) {
    if (d.throwaway_email_domains.includes(emailDomain)) return dq(`Throwaway email (${emailDomain})`, 'throwaway email', 'personal_email');
    if (d.personal_email_domains.includes(emailDomain)) return dq(`Personal email (${emailDomain})`, 'personal email', 'personal_email');
    if (d.billing_vendor_domains.includes(emailDomain)) return dq(`Works at a billing vendor (${emailDomain})`, 'billing vendor', 'generic');
    if (d.fake_domains.includes(emailDomain)) return dq(`Fake data (email domain ${emailDomain})`, 'fake data', 'generic');
  }
  if (isFake(lead.first_name) || isFake(lead.last_name) || isFake(lead.name)) return dq('Fake data (name)', 'fake data', 'generic');

  const student = hasWord(lead.title, d.student_or_job_seeker_titles);
  if (student) return dq(`Student or job seeker (title: "${student}")`, 'student or job seeker', 'generic');
  const vendor = hasWord(lead.title, d.vendor_titles);
  if (vendor) return dq(`Not a buyer: agency, recruiter, consultant or vendor (title: "${vendor}")`, d.not_a_buyer_label, 'vendor');
  const investor = hasWord(lead.title, d.investor_press_titles);
  if (investor) return dq(`Not a buyer: investor or press (title: "${investor}")`, d.not_a_buyer_label, 'investor_press');

  return { disqualified: null, flags };
}

// An address that cannot receive mail: nothing is sent to it.
export const isUndeliverable = (email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '') || rules.disqualify.fake_domains.includes(email.split('@')[1]);
