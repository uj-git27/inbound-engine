import { isDryRun } from '../env.js';
import { createAirtable } from './airtable.js';
import { createSlack } from './slack.js';
import { createHubspot } from './hubspot.js';
import { createMockAirtable } from './mock/airtable.js';
import { createMockSlack } from './mock/slack.js';
import { createHubspotCrm, createAirtableCrm, createMockCrm } from '../crm.js';

let mocks = null;

// DRY_RUN: mock connectors only, no keys needed, nothing sent and nothing booked.
export function getConnectors(env = process.env) {
  if (isDryRun(env)) {
    mocks ??= { airtable: createMockAirtable(), slack: createMockSlack(), crm: createMockCrm() };
    return mocks;
  }
  const airtable = createAirtable(env);
  const crm = env.CRM_PROVIDER === 'airtable' ? createAirtableCrm(airtable) : createHubspotCrm(createHubspot(env));
  return { airtable, slack: createSlack(env), crm };
}

export function resetMocks() {
  mocks = null;
}
