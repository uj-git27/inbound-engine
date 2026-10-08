import samples from '../data/samples.json' with { type: 'json' };
import { rules } from './rules.js';
import { runPipeline } from './pipeline.js';
import { slotsFor, pickSlot } from './slots.js';

export { samples };

const option = (text) => `opt_${text.replace(/[^a-z0-9]+/gi, '_')}`;

// A Tally webhook payload for one sample lead, shaped like the real step-1 form: found by
// label, with the dropdown answer sent as an option ID that the options list resolves.
export function samplePayload(sample) {
  const labels = rules.form.labels;
  const [first, ...rest] = String(sample.name ?? '').split(' ');
  const bands = rules.form.employee_bands.map((b) => ({ id: option(b.label), text: b.label }));
  const dropdown = (label, value, list) => ({ label, type: 'DROPDOWN', value: value ? [option(value)] : null, options: list.map((text) => ({ id: option(text), text })) });
  return {
    eventId: `evt_${sample.id}`,
    eventType: 'FORM_RESPONSE',
    data: {
      submissionId: `sample-${sample.id}`,
      fields: [
        { label: labels.first_name, type: 'INPUT_TEXT', value: sample.first_name ?? first },
        { label: labels.last_name, type: 'INPUT_TEXT', value: sample.last_name ?? rest.join(' ') },
        { label: labels.email, type: 'INPUT_EMAIL', value: sample.email },
        { label: labels.employees, type: 'DROPDOWN', value: sample.employees ? [option(sample.employees)] : null, options: bands },
        { label: labels.company, type: 'INPUT_TEXT', value: sample.company ?? null },
        { label: labels.title, type: 'INPUT_TEXT', value: sample.title },
        dropdown(labels.country, sample.country, rules.form.countries),
        dropdown(labels.industry, sample.industry, rules.form.industries),
        { label: labels.help, type: 'TEXTAREA', value: sample.help ?? null },
        dropdown(labels.lead_source, sample.lead_source, rules.form.lead_sources),
      ],
    },
  };
}

const outcomeOf = (o) => (o.kind === 'tiered' ? o.tier : o.kind === 'disqualified' ? 'DQ' : o.kind);

// Runs one sample through the pipeline and compares it with its expected outcome.
// `pick` plays the lead on the booking page after the form:
//   'first' (default) picks the first open time; a number picks that position in the list;
//   null picks nothing, as when the lead closes the page.
export async function runSample(sample, connectors, { pick = 'first' } = {}) {
  const payload = samplePayload(sample);
  const sid = payload.data.submissionId;
  const table = rules.tables.leads;
  const record = await connectors.airtable.createRecord(table, {
    lead_id: sid, status: 'received', received_at: new Date().toISOString(), raw_payload: JSON.stringify(payload),
  });
  const result = await runPipeline({ recordId: record.id, payload, connectors });

  let picked = null;
  if (pick !== null) {
    const offer = await slotsFor({ sid, connectors });
    if (offer.status === 'ok' && offer.slots.length) {
      picked = await pickSlot({ sid, slot: offer.slots[pick === 'first' ? 0 : pick], tz: 'America/Los_Angeles', connectors });
    } else {
      picked = { status: offer.status };
    }
  }

  const { outcome, alerts = [] } = result;
  const row = (await connectors.airtable.findByField(table, 'lead_id', sid))[0]?.fields ?? {};
  const e = sample.expect ?? {};
  const got = {
    outcome: outcome ? outcomeOf(outcome) : result.status,
    channel: alerts[0]?.channel ?? '',
    calls: outcome?.calls ?? [],
    low_confidence: Boolean(outcome?.lowConfidence),
    score: outcome?.score,
    reason: outcome?.reason ?? '',
    flags: outcome?.flags ?? [],
    first_line: alerts[0]?.text.split('\n')[0] ?? '',
    requested_slot: row.requested_slot || null,
    booked_slot: row.booked_slot || null,
    slot_changed: Boolean(row.slot_changed),
    page: picked?.status ?? null,
  };
  const problems = [];
  if (e.outcome !== undefined && got.outcome !== e.outcome) problems.push(`outcome ${got.outcome}, expected ${e.outcome}`);
  if (e.channel !== undefined && got.channel !== e.channel) problems.push(`channel ${got.channel}, expected ${e.channel}`);
  if (e.calls !== undefined && got.calls.length !== e.calls) problems.push(`${got.calls.length} paid calls, expected ${e.calls}`);
  if (e.no_call && got.calls.includes(e.no_call)) problems.push(`made a ${e.no_call} call`);
  if (e.low_confidence !== undefined && got.low_confidence !== e.low_confidence) problems.push(`low confidence ${got.low_confidence}, expected ${e.low_confidence}`);
  if (alerts.length && !got.first_line.startsWith(rules.alert_prefix)) problems.push('alert does not start with "For: "');
  // Only Tier A and B are booked by the engine; nothing else may end up with a meeting.
  const bookable = ['A', 'B'].includes(got.outcome);
  if (!bookable && got.booked_slot) problems.push(`a ${got.outcome} lead was booked`);
  if (bookable && pick !== null && !got.booked_slot) problems.push('a qualified lead that picked a time was not booked');
  return { sample, got, problems, pass: problems.length === 0, result, picked };
}
