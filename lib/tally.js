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

// Dropdowns arrive as option IDs; map them through field.options.
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

// "10am", "1 PM ET" -> "10:00", "13:00"; null unless it is one of the slots in rules.json.
function slotOf(text) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text ?? '');
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') hour += 12;
  const slot = `${String(hour).padStart(2, '0')}:${m[2] ?? '00'}`;
  return rules.booking.slots.includes(slot) ? slot : null;
}

function dateOf(text) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(text ?? '');
  return m ? m[1] : null;
}

function timezoneOf(text) {
  if (!text) return null;
  const known = Object.keys(rules.booking.buyer_timezones);
  return known.find((tz) => new RegExp(`\\b${tz}\\b`, 'i').test(text)) ?? 'Other';
}

export function leadIdOf(payload) {
  return payload?.data?.submissionId ?? payload?.data?.responseId ?? payload?.eventId ?? null;
}

// Returns { lead, missing }. Form text is data only; nothing here interprets it.
export function parseTally(payload) {
  const fields = payload?.data?.fields;
  if (!Array.isArray(fields)) throw new Error('Tally payload has no data.fields');

  const raw = {};
  for (const [key, pattern] of Object.entries(rules.form.fields)) {
    const re = new RegExp(pattern, 'i');
    const field = fields.find((f) => re.test(f.label ?? ''));
    raw[key] = field ? fieldValue(field) : null;
  }

  const lead = {
    lead_id: leadIdOf(payload),
    name: raw.name,
    email: raw.email?.toLowerCase() ?? null,
    title: raw.title,
    company: raw.company,
    website: raw.website,
    // The form asks for the company name, not a website, so the domain comes from the work email.
    domain: domainOf(raw.website) ?? domainOf(raw.email?.split('@')[1]),
    first_choice: { date: dateOf(raw.first_date), slot: slotOf(raw.first_time) },
    backup_choice: { date: dateOf(raw.backup_date), slot: slotOf(raw.backup_time) },
    timezone: timezoneOf(raw.timezone),
  };
  const missing = rules.form.required.filter((key) => !lead[key]);
  return { lead, missing };
}

export function choiceText(choice) {
  if (!choice?.date) return '';
  return `${choice.date} ${choice.slot ?? '(no time)'} ${rules.booking.slot_label}`;
}
