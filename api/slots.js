import { slotsFor, openTimes } from '../lib/slots.js';
import { getConnectors } from '../lib/connectors/index.js';

// GET /api/slots?sid=<Tally submission id>[&force=1]: what the booking page should show.
// GET /api/slots?open=1: the open times alone, before the form is submitted.
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const sid = params.get('sid');
  const early = !sid && params.get('open') === '1';
  if (early) {
    try {
      return Response.json(await openTimes({ connectors: getConnectors() }), { headers: { 'cache-control': 'no-store' } });
    } catch (err) {
      console.error('slots: failed:', err.message);
      return Response.json({ status: 'error', error: 'Could not load times. Please try again.' }, { status: 500 });
    }
  }
  if (!sid || sid.length > 100) return Response.json({ status: 'invalid', error: 'missing sid' }, { status: 400 });
  try {
    const result = await slotsFor({ sid, force: params.get('force') === '1', connectors: getConnectors() });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('slots: failed:', err.message);
    return Response.json({ status: 'error', error: 'Could not load times. Please try again.' }, { status: 500 });
  }
}
