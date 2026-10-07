// Local preview of the booking page, in DRY_RUN: mock connectors, nothing sent, nothing booked.
//   node scripts/dev-server.js          then open the two links it prints
// It seeds one qualified lead (Tier A, waiting for a time) and one slam-dunk reject.
import { createServer } from 'node:http';

process.env.DRY_RUN = 'true';
process.env.BASE_URL ??= 'http://localhost:4173';
const PORT = Number(process.env.PORT ?? 4173);

const { samples, samplePayload } = await import('../lib/samples.js');
const { getConnectors } = await import('../lib/connectors/index.js');
const { runPipeline } = await import('../lib/pipeline.js');
const { rules } = await import('../lib/rules.js');
const routes = {
  'GET /book': (await import('../api/book.js')).GET,
  'GET /api/slots': (await import('../api/slots.js')).GET,
  'POST /api/slot': (await import('../api/slot.js')).POST,
  'POST /api/lead': (await import('../api/lead.js')).POST,
};

const connectors = getConnectors();
const seed = async (id) => {
  const sample = samples.find((s) => s.id.startsWith(id));
  const payload = samplePayload(sample);
  const record = await connectors.airtable.createRecord(rules.tables.leads, {
    lead_id: payload.data.submissionId, status: 'received', received_at: new Date().toISOString(), raw_payload: JSON.stringify(payload),
  });
  await runPipeline({ recordId: record.id, payload, connectors });
  return `http://localhost:${PORT}/book?sid=${payload.data.submissionId}&e=${encodeURIComponent(sample.email)}`;
};
const qualified = await seed('01');
const rejected = await seed('05');

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // /frame?w=390&u=/book?... shows a page inside a frame of an exact width. Headless browsers
  // cannot make their window narrower than about 500px, so this is how phone-width shots are taken.
  if (url.pathname === '/frame') {
    const width = Number(url.searchParams.get('w')) || 390;
    const target = String(url.searchParams.get('u') ?? '').replace(/"/g, '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><body style="margin:0;background:#888"><iframe src="${target.startsWith('/') ? target : '/'}" width="${width}" height="844" style="border:0;display:block"></iframe></body>`);
    return;
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    res.writeHead(404).end('not found');
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => {
  console.log(`Booking page preview (DRY_RUN, nothing is sent or booked)\n  qualified lead:   ${qualified}\n  slam-dunk reject: ${rejected}`);
});
