import { sweep } from '../lib/sweep.js';
import { verifyToken } from '../lib/token.js';
import { getConnectors } from '../lib/connectors/index.js';

// Runs the timed rules (Tier B reminder and release, the 4-hour nurture default).
// Called by a scheduler (Vercel cron, or the hourly GitHub Action) or by hand with ?t=<token>.
export async function GET(request) {
  const cron = (request.headers.get('user-agent') ?? '').startsWith('vercel-cron/');
  const token = new URL(request.url).searchParams.get('t');
  if (!cron && !verifyToken('sweep', 'run', token)) return Response.json({ ok: false, error: 'not allowed' }, { status: 401 });
  return Response.json({ ok: true, ...(await sweep({ connectors: getConnectors() })) });
}
