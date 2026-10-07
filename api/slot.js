import { pickSlot } from '../lib/slots.js';
import { getConnectors } from '../lib/connectors/index.js';

// POST /api/slot {sid, slot, tz}: the lead picked a time on the booking page.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: 'invalid', error: 'body is not JSON' }, { status: 400 });
  }
  const { sid, slot, tz } = body ?? {};
  if (typeof sid !== 'string' || !sid || sid.length > 100 || typeof slot !== 'string') {
    return Response.json({ status: 'invalid', error: 'sid and slot are required' }, { status: 400 });
  }
  try {
    const { http, ...result } = await pickSlot({ sid, slot, tz: typeof tz === 'string' ? tz : null, connectors: getConnectors() });
    return Response.json(result, { status: http, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('slot: failed:', err.message);
    return Response.json({ status: 'error', error: 'Could not save your time. Please try again.' }, { status: 500 });
  }
}
