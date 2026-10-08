// Creates the step 1 Tally form and its webhook to BASE_URL/api/lead.
//   node scripts/setup-tally.js              creates a NEW form (the old live form is not touched)
//   node scripts/setup-tally.js <form id>    re-syncs that form's questions and settings from rules.json
// Needs TALLY_API_KEY, TALLY_SIGNING_SECRET and BASE_URL in .env. The secret is never printed.
import { randomUUID } from 'node:crypto';
import { loadEnv, need } from '../lib/env.js';
import { rules } from '../lib/rules.js';
import { http } from '../lib/http.js';

loadEnv();
const API = 'https://api.tally.so';
const tally = (path, { method = 'GET', body } = {}) =>
  http(`${API}${path}`, { method, headers: { authorization: `Bearer ${need('TALLY_API_KEY')}` }, body });
const listed = (json) => json.items ?? json.data ?? json.forms ?? json.webhooks ?? (Array.isArray(json) ? json : []);

const block = (type, groupType, payload, groupUuid = randomUUID()) => ({ uuid: randomUUID(), type, groupUuid, groupType, payload });
// A small label (Tally's LABEL block) names the field that follows it, like a question title does.
const question = (label) => block('LABEL', 'LABEL', { html: label });
const input = (type, isRequired) => block(type, type, { isRequired, placeholder: '' });
const dropdown = (options, isRequired) => {
  const groupUuid = randomUUID();
  return options.map((text, index) =>
    block('DROPDOWN_OPTION', 'DROPDOWN', { index, isFirst: index === 0, isLast: index === options.length - 1, isRequired, text }, groupUuid));
};
// Two fields side by side: every block of a field carries the row and its own column.
const row = (left, right) => {
  const columnListUuid = randomUUID();
  return [left, right].flatMap((field) => {
    const columnUuid = randomUUID();
    return field.map((b) => ({ ...b, payload: { ...b.payload, columnListUuid, columnUuid, columnRatio: 50 } }));
  });
};

const { labels, title, required, employee_bands: bands } = rules.form;
const needs = (key) => required.includes(key) || rules.form.ask_required.includes(key);
const email = input('INPUT_EMAIL', needs('email'));
const blocks = [
  block('FORM_TITLE', 'TEXT', { title, html: title }),
  ...row([question(labels.first_name), input('INPUT_TEXT', needs('first_name'))], [question(labels.last_name), input('INPUT_TEXT', needs('last_name'))]),
  ...row([question(labels.email), email], [question(labels.company), input('INPUT_TEXT', needs('company'))]),
  ...row([question(labels.title), input('INPUT_TEXT', needs('title'))], [question(labels.country), ...dropdown(rules.form.countries, needs('country'))]),
  ...row([question(labels.industry), ...dropdown(rules.form.industries, needs('industry'))], [question(labels.employees), ...dropdown(bands.map((b) => b.label), needs('employees'))]),
  question(labels.lead_source), ...dropdown(rules.form.lead_sources, needs('lead_source')),
  // The open question keeps a full row.
  question(labels.help), input('TEXTAREA', needs('help')),
];

// The form is shown inside our own page (/demo), which swaps in the time picker when Tally
// reports the submission. There is no redirect: it would move the visitor off that page.
const base = need('BASE_URL').replace(/\/$/, '');
const settings = { redirectOnCompletion: null };

const formId = process.argv[2];
let form;
if (formId) {
  form = (await tally(`/forms/${formId}`, { method: 'PATCH', body: { status: 'PUBLISHED', blocks, settings } })).json;
  console.log(`OK   form ${formId} re-synced from rules.json`);
} else {
  form = (await tally('/forms', { method: 'POST', body: { status: 'PUBLISHED', blocks, settings } })).json;
  console.log(`OK   form "${form.name}" created (${form.id}), status ${form.status}`);
}
const id = form.id ?? formId;

const url = `${base}/api/lead`;
const webhooks = listed((await tally('/webhooks?limit=100')).json);
if (webhooks.some((w) => w.url === url && (w.formId ?? w.form?.id) === id)) {
  console.log(`OK   webhook to ${url} exists, reused`);
} else {
  await tally('/webhooks', { method: 'POST', body: { formId: id, url, eventTypes: ['FORM_RESPONSE'], signingSecret: need('TALLY_SIGNING_SECRET') } });
  console.log(`OK   webhook created: ${url}`);
}

const saved = (await tally(`/forms/${id}`)).json;
console.log(`\nRedirect saved by Tally: ${JSON.stringify(saved.settings?.redirectOnCompletion ?? null)}`);
console.log(`\nForm link:  https://tally.so/r/${id}\nEdit link:  https://tally.so/forms/${id}/edit`);
