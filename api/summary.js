import { buildSummary } from '../lib/summary.js';
import { verifyToken } from '../lib/token.js';
import { getConnectors } from '../lib/connectors/index.js';

// Monday summary. Called by the Vercel cron (see vercel.json), or by hand with ?t=<token>.
export async function GET(request) {
  const cron = (request.headers.get('user-agent') ?? '').startsWith('vercel-cron/');
  const token = new URL(request.url).searchParams.get('t');
  if (!cron && !verifyToken('summary', 'weekly', token)) return Response.json({ ok: false, error: 'not allowed' }, { status: 401 });
  const { airtable, slack } = getConnectors();
  const summary = await buildSummary(airtable);
  await slack.postMessage(summary.channel, summary.text);
  return Response.json({ ok: true, leads: summary.total });
}
