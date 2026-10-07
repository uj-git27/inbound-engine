import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyAction, ACTIONS } from '../lib/links.js';
import { runAction } from '../lib/actions.js';
import { getConnectors } from '../lib/connectors/index.js';
import { runInBackground } from '../lib/background.js';

// Slack signs every request: v0=HMAC-SHA256(signing secret, "v0:<timestamp>:<raw body>").
export function verifySlackSignature(raw, timestamp, signature, secret, now = Date.now()) {
  if (!secret || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false; // older than 5 minutes: a replay
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Button clicks from Slack. Slack needs a reply within 3 seconds, so the click is acknowledged
// straight away and the action runs in the background; the result is posted in the alert's thread.
export async function POST(request) {
  const raw = await request.text();
  const ok = verifySlackSignature(raw, request.headers.get('x-slack-request-timestamp'), request.headers.get('x-slack-signature'), process.env.SLACK_SIGNING_SECRET);
  if (!ok) return new Response('bad signature', { status: 401 });

  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get('payload'));
  } catch {
    return new Response('bad payload', { status: 400 });
  }
  const click = payload?.type === 'block_actions' ? payload.actions?.[0] : null;
  if (!click) return new Response('', { status: 200 });

  let request_;
  try {
    request_ = JSON.parse(click.value);
  } catch {
    request_ = {};
  }
  const check = verifyAction(request_);
  const connectors = getConnectors();
  const thread = { channel: payload.channel?.id ?? payload.container?.channel_id, ts: payload.message?.thread_ts ?? payload.message?.ts ?? payload.container?.message_ts };
  const person = payload.user?.name ?? payload.user?.username ?? 'someone';

  runInBackground((async () => {
    const result = check.ok
      ? await runAction({ leadId: check.leadId, action: check.action, connectors })
      : { ok: false, message: check.error.replace('link', 'button') };
    const label = ACTIONS[request_.a] ?? 'Action';
    const text = `${result.ok ? ':white_check_mark:' : ':warning:'} *${label}* (clicked by ${person}): ${result.message}`;
    await connectors.slack.postMessage(thread.channel, text, { thread });
  })().catch((err) => console.error('slack-actions: failed:', err.message)));

  return new Response('', { status: 200 });
}
