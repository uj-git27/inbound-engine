// One small real call per service, printing OK or FAIL.
//   node scripts/smoke.js                 every service
//   node scripts/smoke.js --only=gemini   a comma-separated subset
//   node scripts/smoke.js --send          also: a test invite and a test Gmail to DEMO_INBOX,
//                                         and a test message in each Slack channel
import { loadEnv, need } from '../lib/env.js';
import { rules } from '../lib/rules.js';
import { createAirtable } from '../lib/connectors/airtable.js';
import { createHubspot } from '../lib/connectors/hubspot.js';
import { createGemini, companyProfilePrompt, groundingSources } from '../lib/connectors/gemini.js';
import { createApollo } from '../lib/connectors/apollo.js';
import { createExa } from '../lib/connectors/exa.js';
import { createFirecrawl } from '../lib/connectors/firecrawl.js';
import { createClaude } from '../lib/connectors/claude.js';
import { createGoogle } from '../lib/connectors/google.js';
import { createSlack } from '../lib/connectors/slack.js';

loadEnv();
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const send = process.argv.includes('--send');

async function gemini() {
  const client = createGemini();
  const modes = [];
  for (const domain of ['temporal.io', 'slack.com']) {
    let response;
    let mode = 'JSON mode + search';
    try {
      response = await client.generate(companyProfilePrompt(domain), { jsonMode: true, timeoutMs: 60_000 });
    } catch (err) {
      // Spec fallback: if JSON output with search errors, ask for JSON in the prompt only.
      // Only a rejected request (400) means that; quota or auth errors would fail again.
      if (err.status !== 400) throw err;
      console.log(`  gemini ${domain}: JSON mode + search failed (${err.message}); retrying with JSON in the prompt only`);
      mode = 'JSON in prompt + search';
      response = await client.generate(companyProfilePrompt(domain), { jsonMode: false, timeoutMs: 60_000 });
    }
    console.log(`\n----- Gemini raw response for ${domain} (${mode}) -----`);
    console.log(JSON.stringify(response, null, 2));
    console.log(`----- end ${domain} -----\n`);
    const sources = groundingSources(response).length;
    if (!sources) throw new Error(`${domain}: no groundingChunks in the response (is search grounding on the paid tier?)`);
    modes.push(`${domain}: ${mode}, ${sources} sources`);
  }
  return modes.join('; ');
}

async function apollo() {
  const res = await createApollo().enrichCompany('temporal.io');
  if (!res.organization) throw new Error(`no organization in the reply: ${JSON.stringify(res).slice(0, 200)}`);
  return `${res.organization.name}, ${res.organization.estimated_num_employees ?? '?'} employees`;
}

async function hubspot() {
  const results = await createHubspot().searchCompaniesByDomain('acme-test.com');
  return `company search works; acme-test.com ${results.length ? 'found' : 'not seeded yet'}`;
}

async function airtable() {
  const tables = await createAirtable().listTables();
  const names = tables.map((t) => t.name);
  const absent = Object.values(rules.tables).filter((t) => !names.includes(t));
  if (absent.length) throw new Error(`missing tables: ${absent.join(', ')} (run scripts/setup-airtable.js)`);
  return `tables present: ${Object.values(rules.tables).join(', ')}`;
}

async function exa() {
  const start = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const res = await createExa().searchNews('Temporal Technologies funding', { startPublishedDate: start, numResults: 1 });
  if (!Array.isArray(res.results)) throw new Error(`no results array: ${JSON.stringify(res).slice(0, 200)}`);
  return `${res.results.length} result: ${res.results[0]?.title ?? '(none)'}`;
}

async function firecrawl() {
  const res = await createFirecrawl().scrape('https://example.com');
  if (!res.data?.markdown) throw new Error(`no data.markdown: ${JSON.stringify(res).slice(0, 200)}`);
  return `${res.data.markdown.length} chars of markdown`;
}

async function claude() {
  const res = await createClaude().message({ user: 'Reply with the single word OK.', maxTokens: 16 });
  const text = res.content?.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error(`no text block: ${JSON.stringify(res).slice(0, 200)}`);
  return `${res.model} replied "${text.trim()}"`;
}

async function google() {
  const client = createGoogle();
  const now = Date.now();
  const busy = await client.freeBusy(new Date(now).toISOString(), new Date(now + 7 * 86_400_000).toISOString());
  let detail = `free/busy works (${busy.length} busy blocks in the next 7 days)`;
  if (send) {
    const inbox = need('DEMO_INBOX');
    const start = new Date(Math.ceil((now + 24 * 3_600_000) / 3_600_000) * 3_600_000);
    const event = await client.createEvent({
      summary: 'TEST: inbound engine invite (safe to delete)',
      description: rules.disclaimer,
      start: { dateTime: start.toISOString() },
      end: { dateTime: new Date(start.getTime() + rules.booking.duration_minutes * 60_000).toISOString() },
      attendees: [{ email: inbox }],
    });
    const mail = await client.sendEmail({
      to: inbox,
      subject: 'TEST: inbound engine Gmail send',
      text: `This is the phase 1 test email.\n\n${rules.disclaimer}`,
    });
    detail += `; invite sent to ${inbox} (${event.htmlLink}); Gmail sent (id ${mail.id})`;
  }
  return detail;
}

async function slack() {
  const client = createSlack();
  const who = await client.authTest();
  let detail = `signed in as ${who.user} in ${who.team}`;
  if (send) {
    for (const member of Object.values(rules.team)) {
      await client.postMessage(member.channel, `${rules.alert_prefix}${member.name}\nTEST: inbound engine smoke message.`);
    }
    detail += `; test message posted to ${Object.values(rules.team).map((m) => `#${m.channel}`).join(', ')}`;
  }
  return detail;
}

const checks = { gemini, apollo, hubspot, airtable, exa, firecrawl, claude, google, slack };
let failed = 0;
const lines = [];
for (const [name, run] of Object.entries(checks)) {
  if (only && !only.includes(name)) continue;
  try {
    lines.push(`OK   ${name}: ${await run()}`);
  } catch (err) {
    failed += 1;
    lines.push(`FAIL ${name}: ${err.message}`);
  }
}
console.log(lines.join('\n'));
console.log(failed ? `\n${failed} FAILED` : '\nSmoke test passed');
process.exit(failed ? 1 : 0);
