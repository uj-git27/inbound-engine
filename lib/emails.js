import { rules, teamMember } from './rules.js';
import { isUndeliverable } from './checks.js';

const firstName = (lead) => String(lead.name ?? '').trim().split(/\s+/)[0] || 'there';

// One sourced line, only if there is a signal worth congratulating: the most recent one.
function signalLine(outcome) {
  const labels = rules.emails.signal_labels;
  const signal = (outcome?.signals ?? []).find((s) => labels[s.type]);
  return signal ? `Congrats on the ${labels[signal.type]} announced ${signal.date}.` : '';
}

// The 3 things we'll cover are the discovery questions from the brief.
function topics(outcome) {
  const model = outcome?.pricing?.model ?? 'unknown';
  return rules.brief.questions[model].map((q, i) => `${i + 1}. ${q}`).join('\n');
}

// All emails are fixed templates from rules.json (no AI writing). Personal details come only
// from sourced facts. Returns the full message, ready to send.
export function buildEmail(template, { lead, outcome, booking, env = process.env }) {
  const e = rules.emails;
  const t = e.templates[template];
  if (!t) throw new Error(`rules.json has no email template "${template}"`);
  const ae = teamMember('ae');
  // AE emails come from the AE; rejections and nurture from the team name.
  const sender = t.from === 'ae' ? { name: ae.name, replyTo: ae.email, sign: ae.name } : { name: e.team_display_name, replyTo: e.team_reply_to, sign: e.team_display_name };
  const vars = {
    first_name: firstName(lead),
    brand: e.brand,
    meeting_time: booking?.buyerLocal ?? booking?.slot ?? '',
    signal_line: signalLine(outcome),
    topics: topics(outcome),
    // Only when the pricing page gave us a quote to cite.
    pricing_clause: outcome?.pricing?.quote ? ` (your pricing page mentions "${outcome.pricing.quote}")` : '',
    tour_url: e.productTourUrl,
    form_url: env.TALLY_FORM_URL ?? '',
    sdr_name: teamMember('sdr').name,
    sender_name: sender.sign,
  };
  const fill = (text) => text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '').replace(/ {2,}/g, ' ');
  const demo = env.DEMO_MODE === 'true';
  return {
    template,
    // DEMO_MODE sends everything to DEMO_INBOX.
    to: demo ? (env.DEMO_INBOX || lead.email) : lead.email,
    intendedFor: lead.email,
    fromName: sender.name,
    replyTo: sender.replyTo,
    bcc: !demo && e.bcc_ae_on.includes(template) ? ae.email : null,
    subject: fill(t.subject).trim(),
    // A line whose only content was an empty variable (no signal) is dropped.
    text: [...t.body.map(fill).map((l) => l.trim()).filter(Boolean), e.footer].join('\n\n'),
  };
}

// Sends one template to one lead, at most once. `state.sent` remembers what went out, and the
// returned log line goes to Airtable (template, to, from, time).
export async function sendTemplate(template, { lead, outcome, booking, state, google, env = process.env }) {
  state.sent ??= {};
  if (state.sent[template]) return { sent: false, why: `"${template}" was already sent to this lead` };
  if (isUndeliverable(lead.email)) return { sent: false, why: `"${template}" not sent: ${lead.email || 'no address'} cannot receive mail` };
  const email = buildEmail(template, { lead, outcome, booking, env });
  await google.sendEmail(email);
  const at = new Date().toISOString();
  state.sent[template] = at;
  const line = `${at} | ${template} | to ${email.to}${email.to !== email.intendedFor ? ` (demo mode; lead is ${email.intendedFor})` : ''} | from ${email.fromName} | reply-to ${email.replyTo}${email.bcc ? ` | bcc ${email.bcc}` : ''}`;
  state.email_log = [...(state.email_log ?? []), line];
  return { sent: true, email, line };
}
