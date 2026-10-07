// Creates the Tally form (step 0) and its webhook to BASE_URL/api/lead. Safe to re-run: a form
// with the same name and a webhook with the same URL are reused.
// Needs TALLY_API_KEY and BASE_URL in .env. If TALLY_SIGNING_SECRET is empty, one is generated
// and written to .env (never printed); copy it to Vercel afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { loadEnv, need } from '../lib/env.js';
import { rules } from '../lib/rules.js';
import { http } from '../lib/http.js';
import { formBlocks } from '../lib/tally-form.js';

loadEnv();
const API = 'https://api.tally.so';
const tally = (path, { method = 'GET', body } = {}) =>
  http(`${API}${path}`, { method, headers: { authorization: `Bearer ${need('TALLY_API_KEY')}` }, body });

const listed = (json) => json.items ?? json.data ?? json.forms ?? json.webhooks ?? (Array.isArray(json) ? json : []);

const forms = listed((await tally('/forms?limit=100')).json);
let form = forms.find((f) => f.name === rules.form.title && f.status !== 'DELETED');
if (form) {
  // Re-sync the questions to rules.json. This replaces every block on the form.
  await tally(`/forms/${form.id}`, { method: 'PATCH', body: { status: 'PUBLISHED', blocks: formBlocks() } });
  console.log(`OK   form "${form.name}" exists (${form.id}), questions re-synced from rules.json`);
} else {
  form = (await tally('/forms', { method: 'POST', body: { status: 'PUBLISHED', blocks: formBlocks() } })).json;
  console.log(`OK   form "${form.name}" created (${form.id}), status ${form.status}`);
}

const url = `${need('BASE_URL').replace(/\/$/, '')}/api/lead`;
const webhooks = listed((await tally('/webhooks?limit=100')).json);
if (webhooks.some((w) => w.url === url && (w.formId ?? w.form?.id ?? form.id) === form.id)) {
  console.log(`OK   webhook to ${url} exists, reused (its signing secret was not changed)`);
} else {
  let secret = process.env.TALLY_SIGNING_SECRET;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    const env = readFileSync('.env', 'utf8');
    if (!/^TALLY_SIGNING_SECRET=.*$/m.test(env)) throw new Error('.env has no TALLY_SIGNING_SECRET= line to fill in');
    writeFileSync('.env', env.replace(/^TALLY_SIGNING_SECRET=.*$/m, `TALLY_SIGNING_SECRET=${secret}`));
    console.log('OK   signing secret generated and saved to .env');
  }
  await tally('/webhooks', { method: 'POST', body: { formId: form.id, url, eventTypes: ['FORM_RESPONSE'], signingSecret: secret } });
  console.log(`OK   webhook created: ${url}`);
}

console.log(`\nForm link:  https://tally.so/r/${form.id}\nEdit link:  https://tally.so/forms/${form.id}/edit`);
