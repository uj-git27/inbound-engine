import { createHmac, timingSafeEqual } from 'node:crypto';
import { rules } from './rules.js';

// Tally-Signature is a base64 HMAC-SHA256 of the payload with the signing secret.
export function verifyTallySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signTallyPayload(rawBody, secret) {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

// Dropdowns arrive as option IDs; map them through field.options. IDs are never hardcoded.
function fieldValue(field) {
  let value = field.value;
  if (Array.isArray(value)) {
    const options = field.options ?? [];
    value = value.map((id) => options.find((o) => o.id === id)?.text ?? id).join(', ');
  }
  if (value === null || value === undefined) return null;
  const text = String(value).trim().slice(0, rules.form.max_field_length);
  return text === '' ? null : text;
}

export function domainOf(website) {
  if (!website) return null;
  const host = website
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#\s]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

// "201-500", "1,001 - 5,000", "5,001+" -> the matching band from rules.json, or null.
export function employeeBand(text) {
  if (!text) return null;
  const squash = (s) => String(s).toLowerCase().replace(/[\s,]/g, '').replace(/[–—]/g, '-');
  const wanted = squash(text);
  const bands = rules.form.employee_bands;
  const index = bands.findIndex((b) => squash(b.label) === wanted || wanted.startsWith(squash(b.label)));
  return index < 0 ? null : { index, ...bands[index] };
}

// Which band an exact headcount falls in.
export const bandIndexOf = (count) => rules.form.employee_bands.findIndex((b) => count >= b.min && count <= b.max);

// The join key is Tally's submission ID.
export function leadIdOf(payload) {
  return payload?.data?.submissionId ?? payload?.data?.responseId ?? payload?.eventId ?? null;
}

// Returns { lead, missing }. Fields are found by their label. Form text is data only; nothing
// here interprets it. The company domain comes from the work email.
export function parseTally(payload) {
  const fields = payload?.data?.fields;
  if (!Array.isArray(fields)) throw new Error('Tally payload has no data.fields');

  const raw = {};
  for (const [key, pattern] of Object.entries(rules.form.fields)) {
    const re = new RegExp(pattern, 'i');
    const field = fields.find((f) => re.test(f.label ?? ''));
    raw[key] = field ? fieldValue(field) : null;
  }

  const email = raw.email?.toLowerCase() ?? null;
  const lead = {
    lead_id: leadIdOf(payload),
    first_name: raw.first_name,
    last_name: raw.last_name,
    name: [raw.first_name, raw.last_name].filter(Boolean).join(' ') || null,
    email,
    title: raw.title,
    domain: domainOf(email?.split('@')[1]),
    // Filled later from enrichment; the form no longer asks for it.
    company: null,
    employees: employeeBand(raw.employees)?.label ?? null,
    // Shown verbatim in the brief under "In their words"; never scored.
    help: raw.help,
    // Stored on the Airtable row and the CRM contact; never scored.
    lead_source: raw.lead_source,
  };
  const missing = rules.form.required.filter((key) => !lead[key]);
  return { lead, missing };
}
