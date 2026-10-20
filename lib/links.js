import { createHmac, timingSafeEqual } from 'node:crypto';
import { rules } from './rules.js';
import { isDryRun, need } from './env.js';

const secret = (env) => (isDryRun(env) && !env.LINK_SECRET ? 'dry-run-secret' : need('LINK_SECRET', env));
const sign = (leadId, action, expires, env) => createHmac('sha256', secret(env)).update(`${leadId}|${action}|${expires}`).digest('base64url');

export const ACTIONS = {
  confirm_meeting: 'Confirm meeting',
  confirm_anyway: 'Confirm meeting anyway',
  not_qualified: 'Not qualified',
  send_intro: 'Send intro email',
  send_sdr: 'Send to SDR',
  nurture: 'Nurture',
  approve_rejection: 'Approve rejection',
  find_contact: 'Find contact',
  verdict_right: 'Right tier',
  verdict_wrong_A: 'Wrong: A',
  verdict_wrong_B: 'Wrong: B',
  verdict_wrong_C: 'Wrong: C',
};

// What the "are you sure?" step tells the person before anything happens.
export const CONFIRM_TEXT = {
  confirm_meeting: 'Books the meeting if it is not booked yet, and sends the confirmation email where one applies.',
  confirm_anyway: 'Books a meeting for this disqualified lead.',
  not_qualified: 'Cancels the meeting and sends the lead a short thank-you with the product tour.',
  send_intro: 'Sends the intro email shown above to the lead, from the AE.',
  send_sdr: 'Hands this lead to the SDR to follow up. No email is sent.',
  nurture: 'Tags the lead as nurture in the CRM and sends the product tour email.',
  approve_rejection: 'Sends the rejection email to the lead.',
  find_contact: 'Looks up LinkedIn and phone for this lead (uses paid lookups).',
  verdict_right: 'Records that this tier was right.',
  verdict_wrong_A: 'Records that this lead should have been Tier A.',
  verdict_wrong_B: 'Records that this lead should have been Tier B.',
  verdict_wrong_C: 'Records that this lead should have been Tier C.',
};

const expiry = (now) => now + rules.links.expiry_hours * 3_600_000;

// Signed links: HMAC with LINK_SECRET, expiring after 24 hours.
export function actionUrl(leadId, action, env = process.env, now = Date.now()) {
  const expires = expiry(now);
  const query = new URLSearchParams({ l: leadId, a: action, e: String(expires), s: sign(leadId, action, expires, env) });
  return `${(env.BASE_URL ?? '').replace(/\/$/, '')}/api/action?${query}`;
}

// The same signed request, carried in a Slack button's value.
export function buttonValue(leadId, action, env = process.env, now = Date.now()) {
  const expires = expiry(now);
  return JSON.stringify({ l: leadId, a: action, e: String(expires), s: sign(leadId, action, expires, env) });
}

export function verifyAction({ l, a, e, s } = {}, env = process.env, now = Date.now()) {
  if (!l || !ACTIONS[a] || !e || typeof s !== 'string') return { ok: false, error: 'This link is not valid.' };
  const expected = Buffer.from(sign(l, a, e, env));
  const given = Buffer.from(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, error: 'This link is not valid.' };
  if (Number(e) < now) return { ok: false, error: 'This link has expired (links last 24 hours).' };
  return { ok: true, leadId: l, action: a };
}

// Slack mrkdwn links for a list of actions: <url|text> · <url|text>
export function actionLinks(leadId, actions, env = process.env) {
  return actions.map((a) => `<${actionUrl(leadId, a, env)}|${ACTIONS[a]}>`).join('  ·  ');
}

// "Right tier" and "Wrong: A / B / C" on every alert.
export function verdictLinks(leadId, env = process.env, lane = null) {
  const wrong = ['A', 'B', 'C'].filter((t) => t !== lane).map((t) => `<${actionUrl(leadId, `verdict_wrong_${t}`, env)}|${t}>`).join(' / ');
  return `<${actionUrl(leadId, 'verdict_right', env)}|Right tier>  ·  Wrong: ${wrong}`;
}
