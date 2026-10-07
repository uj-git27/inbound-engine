import { waitUntil } from '@vercel/functions';

// Keeps the function alive after the 200 reply. `last` lets tests await the work.
export const background = { last: null };

export function runInBackground(promise) {
  background.last = promise;
  waitUntil(promise);
}
