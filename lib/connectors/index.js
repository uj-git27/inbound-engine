import { isDryRun } from '../env.js';
import { createAirtable } from './airtable.js';
import { createSlack } from './slack.js';
import { createHubspot } from './hubspot.js';
import { createApollo } from './apollo.js';
import { createExa } from './exa.js';
import { createFirecrawl } from './firecrawl.js';
import { createFullEnrich } from './fullenrich.js';
import { createGoogle } from './google.js';
import { createMailCalendar } from './mail-calendar.js';
import { createClay } from './clay.js';
import { createMockAirtable } from './mock/airtable.js';
import { createMockSlack } from './mock/slack.js';
import { createMockGoogle } from './mock/google.js';
import { createMockApollo, createMockResearch, createMockClay, createMockFullEnrich } from './mock/world.js';
import { createHubspotCrm, createAirtableCrm, createMockCrm } from '../crm.js';
import { createResearch } from '../research.js';
import { createCache } from '../cache.js';

let mocks = null;

// DRY_RUN: mock connectors only, no keys needed, no paid calls, nothing sent and nothing booked.
export function getConnectors(env = process.env) {
  if (isDryRun(env)) {
    mocks ??= {
      airtable: createMockAirtable(), slack: createMockSlack(), crm: createMockCrm(), google: createMockGoogle(),
      apollo: createMockApollo(), research: createMockResearch(), clay: createMockClay(), fullenrich: createMockFullEnrich(),
      sleep: async () => {},
    };
    return mocks;
  }
  const airtable = createAirtable(env);
  const apollo = createApollo(env);
  const crm = env.CRM_PROVIDER === 'airtable' ? createAirtableCrm(airtable) : createHubspotCrm(createHubspot(env));
  return {
    airtable, crm, apollo,
    slack: createSlack(env),
    // Calendar and email: a mailbox with an app password (Zoho, Gmail), unless a Google API refresh token is set.
    google: env.GOOGLE_REFRESH_TOKEN ? createGoogle(env) : createMailCalendar(env, { airtable }),
    research: createResearch({ exa: createExa(env), firecrawl: createFirecrawl(env), apollo, cache: createCache(airtable) }),
    clay: { ...createClay(env), configured: Boolean(env.CLAY_WEBHOOK_URL) },
    fullenrich: createFullEnrich(env),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function resetMocks() {
  mocks = null;
}
