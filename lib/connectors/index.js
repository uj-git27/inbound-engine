import { isDryRun } from '../env.js';
import { createAirtable } from './airtable.js';
import { createMockAirtable } from './mock/airtable.js';

let mocks = null;

// DRY_RUN: mock connectors only, no keys needed, nothing sent and nothing booked.
export function getConnectors(env = process.env) {
  if (isDryRun(env)) {
    mocks ??= { airtable: createMockAirtable() };
    return mocks;
  }
  return { airtable: createAirtable(env) };
}

export function resetMocks() {
  mocks = null;
}
