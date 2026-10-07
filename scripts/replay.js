// Runs the sample leads in DRY_RUN (mock connectors, nothing sent) and prints a pass/fail table.
//   node scripts/replay.js                 all 15 samples
//   node scripts/replay.js 03-logistics    samples whose id contains the text
process.env.DRY_RUN = 'true';
const { samples, runSample } = await import('../lib/samples.js');
const { getConnectors, resetMocks } = await import('../lib/connectors/index.js');

const filter = process.argv[2];
const chosen = filter ? samples.filter((s) => s.id.includes(filter)) : samples;
if (!chosen.length) {
  console.log(`No sample matches "${filter}".`);
  process.exit(1);
}

const pad = (text, width) => String(text).padEnd(width).slice(0, width);
console.log(`${pad('', 5)}${pad('SAMPLE', 27)}${pad('EXPECT', 11)}${pad('GOT', 11)}${pad('SCORE', 6)}${pad('CHANNEL', 16)}${pad('PAID CALLS', 34)}`);
let failed = 0;
for (const sample of chosen) {
  resetMocks();
  const { got, problems, pass } = await runSample(sample, getConnectors());
  if (!pass) failed += 1;
  console.log(`${pad(pass ? 'PASS' : 'FAIL', 5)}${pad(sample.id, 27)}${pad(sample.expect.outcome, 11)}${pad(got.outcome + (got.low_confidence ? ' (low)' : ''), 11)}${pad(got.score ?? '-', 6)}${pad(got.channel ? `#${got.channel}` : '-', 16)}${pad(got.calls.join(', ') || '0', 34)}`);
  for (const problem of problems) console.log(`       -> ${problem}`);
}
console.log(`\n${chosen.length - failed} of ${chosen.length} samples match${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
