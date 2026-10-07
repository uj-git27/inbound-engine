import { createHmac, timingSafeEqual } from 'node:crypto';
import { rules } from './rules.js';
import { isDryRun, need } from './env.js';

const secret = (env) => (isDryRun(env) && !env.LINK_SECRET ? 'dry-run-secret' : need('LINK_SECRET', env));
const sign = (leadId, action, expires, env) => createHmac('sha256', secret(env)).update(`${leadId}|${action}|${expires}`).digest('base64url');

export const ACTIONS = {
  confirm_meeting: 'Confirm meeting',
  confirm_anyway: 'Confirm meeting anyway',
  approve_email: 'Approve email',
  promote_ae: 'Promote to AE',
  send_sdr: 'Send to SDR',
  nurture: 'Nurture',
  approve_rejection: 'Approve rejection',
  find_contact: 'Find contact',
  verdict_right: 'Right tier',
  verdict_wrong_A: 'Wrong: A',
  verdict_wrong_B: 'Wrong: B',
  verdict_wrong_C: 'Wrong: C',
};

// Signed links: HMAC with LINK_SECRET, expiring after 24 hours.
export function actionUrl(leadId, action, env = process.env, now = Date.now()) {
  const expires = now + rules.links.expiry_hours * 3_600_000;
  const query = new URLSearchParams({ l: leadId, a: action, e: String(expires), s: sign(leadId, action, expires, env) });
  return `${(env.BASE_URL ?? '').replace(/\/$/, '')}/api/action?${query}`;
}

export function verifyAction({ l, a, e, s }, env = process.env, now = Date.now()) {
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
export function verdictLinks(leadId, env = process.env) {
  const wrong = ['A', 'B', 'C'].map((t) => `<${actionUrl(leadId, `verdict_wrong_${t}`, env)}|${t}>`).join(' / ');
  return `<${actionUrl(leadId, 'verdict_right', env)}|Right tier>  ·  Wrong: ${wrong}`;
}
