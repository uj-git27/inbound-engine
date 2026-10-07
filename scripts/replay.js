// Runs the sample leads in DRY_RUN (mock connectors, nothing sent) and prints a pass/fail table.
//   node scripts/replay.js                 all 15 samples; each lead picks the first open time
//   node scripts/replay.js --no-pick       nobody picks a time: Tier A and B fall back after 15 minutes
//   node scripts/replay.js --busy          the time each lead picks is taken while they choose
//   node scripts/replay.js 03-logistics    samples whose id contains the text
process.env.DRY_RUN = 'true';
const { samples, runSample } = await import('../lib/samples.js');
const { getConnectors, resetMocks } = await import('../lib/connectors/index.js');
const { sweep } = await import('../lib/sweep.js');
const { slotGrid, aeZone } = await import('../lib/booking.js');
const { rules } = await import('../lib/rules.js');

const args = process.argv.slice(2);
const noPick = args.includes('--no-pick');
const busy = args.includes('--busy');
const filter = args.find((a) => !a.startsWith('--'));
const chosen = filter ? samples.filter((s) => s.id.includes(filter)) : samples;
if (!chosen.length) {
  console.log(`No sample matches "${filter}".`);
  process.exit(1);
}

const pad = (text, width) => String(text).padEnd(width).slice(0, width - 1).padEnd(width);
const when = (iso) => (iso ? new Intl.DateTimeFormat('en-US', { timeZone: aeZone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)) : '-');
const leadRow = (c, sample) => [...c.airtable.tables.get(rules.tables.leads).values()].find((r) => r.fields.lead_id === `sample-${sample.id}`)?.fields ?? {};

console.log(`Mode: ${noPick ? 'nobody picks a time (15-minute fallback)' : busy ? 'the picked time is taken meanwhile' : 'each lead picks the first open time'}\n`);
console.log(`${pad('', 5)}${pad('LEAD', 25)}${pad('TIER', 12)}${pad('REQUESTED_SLOT', 25)}${pad('BOOKED_SLOT', 25)}${pad('SLOT_CHANGED', 13)}FLAGS`);
let failed = 0;
for (const sample of chosen) {
  resetMocks();
  const c = getConnectors();
  if (busy) {
    // The first time on offer gets taken after the page has shown it.
    const first = slotGrid()[0];
    const original = c.google.freeBusy.bind(c.google);
    let asked = 0;
    c.google.freeBusy = async (...a) => { asked += 1; const list = await original(...a); return asked > 1 ? [...list, { start: new Date(first.start).toISOString(), end: new Date(first.end).toISOString() }] : list; };
  }
  const { got, problems, pass } = await runSample(sample, c, { pick: noPick ? null : 'first' });
  if (noPick) await sweep({ connectors: c, now: Date.now() + (rules.booking.no_pick_minutes + 1) * 60_000 });
  const row = leadRow(c, sample);
  const extra = [];
  if (noPick && ['A', 'B'].includes(got.outcome) && !row.booked_slot) extra.push('a qualified lead was not booked after 15 minutes');
  if (!['A', 'B'].includes(got.outcome) && row.booked_slot) extra.push(`a ${got.outcome} lead was booked`);
  const all = [...problems.filter((p) => !(noPick && /picked a time/.test(p))), ...extra];
  if (all.length) failed += 1;
  const flags = [...got.flags, ...(got.low_confidence ? ['low confidence'] : [])].join('; ') || '-';
  console.log(`${pad(all.length ? 'FAIL' : 'PASS', 5)}${pad(sample.id, 25)}${pad(got.outcome + (got.score === undefined ? '' : ` (${got.score})`), 12)}${pad(when(row.requested_slot), 25)}${pad(when(row.booked_slot), 25)}${pad(row.slot_changed ? 'yes' : 'no', 13)}${flags}`);
  for (const problem of all) console.log(`       -> ${problem}`);
  if (!pass && !all.length) { /* only the expected "no pick" note */ }
}
console.log(`\n${chosen.length - failed} of ${chosen.length} samples match${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
