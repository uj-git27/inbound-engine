import { rules } from '../lib/rules.js';
import { isDryRun } from '../lib/env.js';
import { verifyTallySignature, leadIdOf } from '../lib/tally.js';
import { getConnectors } from '../lib/connectors/index.js';
import { runPipeline } from '../lib/pipeline.js';
import { runInBackground } from '../lib/background.js';

const reply = (status, body) => Response.json(body, { status });

// Tally webhook. Needs a 2xx within 10 seconds: write the raw payload to Airtable first,
// return 200, then run the pipeline in the background.
export async function POST(request) {
  const raw = await request.text();
  const secret = process.env.TALLY_SIGNING_SECRET;

  if (secret) {
    if (!verifyTallySignature(raw, request.headers.get('tally-signature'), secret)) {
      return reply(401, { ok: false, error: 'bad signature' });
    }
  } else if (!isDryRun()) {
    return reply(500, { ok: false, error: 'TALLY_SIGNING_SECRET is not set' });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return reply(400, { ok: false, error: 'body is not JSON' });
  }

  const connectors = getConnectors();
  let record;
  try {
    record = await connectors.airtable.createRecord(
      rules.tables.leads,
      {
        lead_id: leadIdOf(payload) ?? `no-id-${Date.now()}`,
        status: 'received',
        received_at: new Date().toISOString(),
        raw_payload: raw,
      },
      { timeoutMs: rules.limits.webhook_write_timeout_ms },
    );
  } catch (err) {
    // Non-2xx makes Tally retry, so the lead is not lost.
    console.error('lead: Airtable write failed:', err.message);
    return reply(500, { ok: false, error: 'could not log the lead' });
  }

  runInBackground(
    runPipeline({ recordId: record.id, payload, connectors }).catch((err) => {
      console.error('lead: pipeline failed:', err.message);
    }),
  );
  return reply(200, { ok: true, id: record.id });
}
