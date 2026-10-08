import test from 'node:test';
import assert from 'node:assert/strict';
import { withBlitzHistory } from '../lib/signals.js';
import { createResearch } from '../lib/research.js';
import { createCache } from '../lib/cache.js';
import { createMockAirtable } from '../lib/connectors/mock/airtable.js';
import { buildBrief } from '../lib/brief.js';

const found = { linkedin: 'https://www.linkedin.com/in/dana-reyes', title: 'CFO', role_start: null, previous_companies: [], source: 'Exa' };
const profile = {
  experiences: [
    { company_name: 'Acme Labs', job_title: 'Chief Financial Officer', job_start_date: '2026-06-01', job_is_current: true },
    { company_name: 'Board Co', job_title: 'Advisor', job_start_date: '2020-01-01', job_is_current: true },
    { company_name: 'Globex', job_title: 'VP Finance', job_start_date: '2021-03-01', job_is_current: false },
    { company_name: 'Globex', job_title: 'Controller', job_start_date: '2018-03-01', job_is_current: false },
    { company_name: 'Initech', job_title: 'Analyst', job_start_date: '2015-03-01', job_is_current: false },
  ],
};

test('Blitz history: start date and title of the current role at the company, earlier employers once each', () => {
  assert.deepEqual(withBlitzHistory(found, profile, { companies: ['Acme Labs', 'acme-labs'] }), {
    linkedin: found.linkedin, title: 'Chief Financial Officer', role_start: '2026-06', previous_companies: ['Globex', 'Initech'], source: 'Exa + Blitz',
  });
});

test('Blitz history: no current role at the company, or nothing found, leaves the person as found', () => {
  assert.deepEqual(withBlitzHistory(found, profile, { companies: ['Northwind'] }), found);
  assert.deepEqual(withBlitzHistory(found, null, { companies: ['Acme Labs'] }), found);
});

const lead = { name: 'Dana Reyes', email: 'dana@acme-labs.com', company: 'Acme Labs', domain: 'acme-labs.com' };
const exa = { searchPeople: async () => ({ results: [{ url: found.linkedin, title: 'Dana Reyes', highlights: ['### CFO - [Acme Labs](https://x) (Current)'] }] }) };
const research = (blitz) => createResearch({ exa, blitz, cache: createCache(createMockAirtable()) });

test('person lookup: Exa finds the profile, Blitz adds the history; a Blitz failure keeps the Exa result', async () => {
  const ctx = { calls: [], notes: [] };
  const person = await research({ person: async () => profile }).person(lead, ctx);
  assert.deepEqual([person.role_start, person.source, ctx.calls], ['2026-06', 'Exa + Blitz', ['exa_person', 'blitz_person']]);

  const broken = { calls: [], notes: [] };
  const kept = await research({ person: async () => { throw new Error('HTTP 402'); } }).person(lead, broken);
  assert.deepEqual([kept.source, kept.role_start], ['Exa', null]);
  assert.match(broken.notes[0], /Blitz failed: HTTP 402/);

  const none = { calls: [], notes: [] };
  assert.equal((await research(null).person(lead, none)).source, 'Exa');
  assert.deepEqual(none.calls, ['exa_person']);
});

test('brief: a role started in the last 6 months is marked as recently joined', () => {
  const month = (ago) => new Date(Date.now() - ago * 30.44 * 86_400_000).toISOString().slice(0, 7);
  const who = (role_start) => buildBrief({ lead: { name: 'Dana Reyes', title: 'CFO' }, outcome: { profile: null, pricing: { model: 'unknown' }, signals: [], person: { ...found, role_start } } }).split('\n')[0];
  assert.match(who(month(2)), /in role since \d{4}-\d{2} \*\(recently joined\)\*/);
  assert.equal(who(month(14)).includes('recently joined'), false);
  assert.equal(who(null).includes('recently joined'), false);
});
