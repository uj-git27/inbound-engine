import { sweep } from '../lib/sweep.js';
import { verifyToken } from '../lib/token.js';
import { getConnectors } from '../lib/connectors/index.js';
import { runInBackground } from '../lib/background.js';

const MAX_WAIT_MS = 240_000; // one function run can wait about 4 minutes

// Runs the timed rules (15-minute booking fallback, Tier B reminder and release, 4-hour nurture
// default). Called by a scheduler or by hand with ?t=<token>.
// With &at=<time in ms>, it waits until that moment first. A wait longer than one function run
// can hold is passed on to a fresh call, so "run in 15 minutes" works without a scheduler.
export async function GET(request) {
  const url = new URL(request.url);
  const cron = (request.headers.get('user-agent') ?? '').startsWith('vercel-cron/');
  if (!cron && !verifyToken('sweep', 'run', url.searchParams.get('t'))) return Response.json({ ok: false, error: 'not allowed' }, { status: 401 });

  const at = Number(url.searchParams.get('at')) || 0;
  const wait = at - Date.now();
  if (wait > 0 && wait < 60 * 60_000) {
    const { sleep } = getConnectors();
    runInBackground((async () => {
      await sleep(Math.min(wait, MAX_WAIT_MS));
      // Hand over to a fresh call: it either waits again or, when the time has come, runs the rules.
      await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((err) => console.error('sweep: hand-over failed:', err.message));
    })());
    return Response.json({ ok: true, waiting_ms: wait });
  }
  // A delayed run that has reached its time: the caller is a hand-over that only waits 10 seconds,
  // and a run that books a meeting takes longer. So it answers at once and does the work after.
  if (at) {
    runInBackground(sweep({ connectors: getConnectors() })
      .then((result) => console.log('sweep (delayed):', JSON.stringify(result)), (err) => console.error('sweep (delayed) failed:', err.message)));
    return Response.json({ ok: true, started: true });
  }
  return Response.json({ ok: true, ...(await sweep({ connectors: getConnectors() })) });
}
