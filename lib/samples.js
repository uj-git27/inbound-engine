import samples from '../data/samples.json' with { type: 'json' };
import { rules } from './rules.js';
import { slotLabel } from './tally-form.js';
import { runPipeline } from './pipeline.js';

export { samples };

// A Tally webhook payload for one sample lead, shaped like the real form.
export function samplePayload(sample) {
  const labels = rules.form.labels;
  const times = rules.booking.slots.map((slot, i) => ({ id: `time_${i}`, text: slotLabel(slot) }));
  const zones = Object.keys(rules.booking.buyer_timezones).map((tz) => ({ id: `tz_${tz}`, text: tz }));
  return {
    eventId: `evt_${sample.id}`,
    eventType: 'FORM_RESPONSE',
    data: {
      submissionId: `sample-${sample.id}`,
      fields: [
        { label: labels.name, type: 'INPUT_TEXT', value: sample.name },
        { label: labels.email, type: 'INPUT_EMAIL', value: sample.email },
        { label: labels.title, type: 'INPUT_TEXT', value: sample.title },
        { label: labels.company, type: 'INPUT_TEXT', value: sample.company },
        { label: labels.first_date, type: 'INPUT_DATE', value: sample.date ?? '2026-10-20' },
        { label: labels.first_time, type: 'DROPDOWN', value: [times[0].id], options: times },
        { label: labels.timezone, type: 'DROPDOWN', value: [zones[0].id], options: zones },
      ],
    },
  };
}

const outcomeOf = (o) => (o.kind === 'tiered' ? o.tier : o.kind === 'disqualified' ? 'DQ' : o.kind);

// Runs one sample through the pipeline and compares it with its expected outcome.
export async function runSample(sample, connectors) {
  const payload = samplePayload(sample);
  const record = await connectors.airtable.createRecord(rules.tables.leads, {
    lead_id: payload.data.submissionId, status: 'received', received_at: new Date().toISOString(), raw_payload: JSON.stringify(payload),
  });
  const result = await runPipeline({ recordId: record.id, payload, connectors });
  const { outcome, alerts = [] } = result;
  const e = sample.expect;
  const got = {
    outcome: outcome ? outcomeOf(outcome) : result.status,
    channel: alerts[0]?.channel ?? '',
    calls: outcome?.calls ?? [],
    low_confidence: Boolean(outcome?.lowConfidence),
    score: outcome?.score,
    reason: outcome?.reason ?? '',
    first_line: alerts[0]?.text.split('\n')[0] ?? '',
  };
  const problems = [];
  if (got.outcome !== e.outcome) problems.push(`outcome ${got.outcome}, expected ${e.outcome}`);
  if (got.channel !== e.channel) problems.push(`channel ${got.channel}, expected ${e.channel}`);
  if (e.calls !== undefined && got.calls.length !== e.calls) problems.push(`${got.calls.length} paid calls, expected ${e.calls}`);
  if (e.no_call && got.calls.includes(e.no_call)) problems.push(`made a ${e.no_call} call`);
  if (e.low_confidence !== undefined && got.low_confidence !== e.low_confidence) problems.push(`low confidence ${got.low_confidence}, expected ${e.low_confidence}`);
  if (alerts.length && !got.first_line.startsWith(rules.alert_prefix)) problems.push('alert does not start with "For: "');
  return { sample, got, problems, pass: problems.length === 0 };
}
