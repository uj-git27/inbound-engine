import { isDryRun } from '../env.js';
import { createAirtable } from './airtable.js';
import { createSlack } from './slack.js';
import { createHubspot } from './hubspot.js';
import { createApollo } from './apollo.js';
import { createMockAirtable } from './mock/airtable.js';
import { createMockSlack } from './mock/slack.js';
import { createMockApollo, createMockResearch } from './mock/world.js';
import { createHubspotCrm, createAirtableCrm, createMockCrm } from '../crm.js';
import { createResearch } from '../research.js';

let mocks = null;

// DRY_RUN: mock connectors only, no keys needed, nothing sent and nothing booked.
export function getConnectors(env = process.env) {
  if (isDryRun(env)) {
    mocks ??= {
      airtable: createMockAirtable(), slack: createMockSlack(), crm: createMockCrm(),
      apollo: createMockApollo(), research: createMockResearch(),
    };
    return mocks;
  }
  const airtable = createAirtable(env);
  const crm = env.CRM_PROVIDER === 'airtable' ? createAirtableCrm(airtable) : createHubspotCrm(createHubspot(env));
  return { airtable, slack: createSlack(env), crm, apollo: createApollo(env), research: createResearch(env) };
}

export function resetMocks() {
  mocks = null;
}
