import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDryRun, need } from './env.js';

// DRY_RUN works with no keys, so it gets a fixed secret that is useless anywhere else.
const secret = (env) => (isDryRun(env) && !env.LINK_SECRET ? 'dry-run-secret' : need('LINK_SECRET', env));

// HMAC token that ties a callback to one lead and one purpose (for example "clay").
export function signToken(purpose, leadId, env = process.env) {
  return createHmac('sha256', secret(env)).update(`${purpose}:${leadId}`).digest('base64url');
}

export function verifyToken(purpose, leadId, token, env = process.env) {
  if (!leadId || typeof token !== 'string') return false;
  const expected = Buffer.from(signToken(purpose, leadId, env));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
