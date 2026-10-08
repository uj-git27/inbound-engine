# Status

Last updated: 8 Oct 2026 (commit after `b6cbbf0`). Concept built on public data.

## What is live

- Site: https://inbound-engine-indol.vercel.app
- **Every `git push` to `main` deploys to production** (Vercel is linked to the GitHub repo). A push is a deploy.
- Demo page: `/demo`. The Tally form (https://tally.so/r/pblqzy) sits in a frame; after submit the time picker (`/book`) takes its place on the same page.
- The old form (https://tally.so/r/J9NYgR) no longer matches the parser. Do not use it.

## The flow

1. Form fields: First name, Last name, Work email, Company name, Job title, Country, Industry, Number of employees (all required), How did you hear about us? (dropdown, optional), Anything specific you'd like to explore? (optional).
2. Tally sends the submission to `POST /api/lead` (signed). The engine runs: free checks > CRM lookup > family check > company profile > gates > signals > score > tier > Slack card > Airtable log > CRM save.
3. The time picker calls `GET /api/slots?sid=`. A slam-dunk reject sees "Thanks, we'll be in touch by email." and no calendar. If the form has not reached us yet, the page retries every second for 5 seconds, then shows times anyway.
4. Slots: next 5 weekdays, 30 minutes, 9:00 to 17:00 in the AE's time zone (`AE_TZ`, default America/New_York), at least 2 hours out, minus anything busy on the calendar. Shown in the visitor's own time zone.
5. `POST /api/slot {sid, slot, tz}` stores the pick. Tier A: booked, "Invite on its way." Tier B: hold booked, "Our team will confirm shortly." Tier C and others: the pick is kept, nothing is booked.
6. Booking happens when the lead is qualified AND has picked a time, whichever comes second. Free/busy is checked again at booking; if the time was taken, the next free one is booked and the invite and email say so.
7. No pick within 15 minutes: Tier A and B get the next free slot.
8. Once booked, the Slack card itself is edited to say "Booked: <time>"; the details go in its thread.

## Rules worth knowing

- **Form answers win** for employee size, industry and country: they are shown on the card ("self-reported on the form") and drive the gates and the score. Enrichment is used only when the form says "Other" or is blank. The CRM keeps what enrichment found. A headcount more than one band away from enrichment adds a "headcount mismatch" flag for review.
- **Company name:** the CRM's or enrichment's name is used; the one typed on the form is the fallback.
- **Signals:** only business growth or decline counts (funding, new finance leader, IPO, M&A, revenue, expansion, partnership, layoffs, decline). Product or feature releases are not signals. "Why now" points add up to exactly 20: funding 5, new finance leader 4, IPO prep 3, M&A 3, revenue milestone 2, international expansion 2, partnership 1. Layoffs are a penalty of 5 (the part never goes below 0). Decline is shown but not scored. The card's "Why this tier" line lists each signal with its points.
- **12 months, strict:** asked of the search, checked on every article date, and checked again on saved results. An article with no date is dropped.
- **Summary:** Gemini writes 2 to 3 lines from those signals only (`LLM_PROVIDER=gemini`). If it fails or adds a number that is not in the signals, a template line is used.
- **Size rejections** (headcount out of range) still get the 12-month research and summary on their card. Other rejections get no research.
- **Parent and subsidiary:** checked before the gates, from HubSpot links, then Apollo, then a web search (Exa). A parent or subsidiary that is a customer or has an open deal makes the lead an "Expansion" card for that account's owner.
- **Role-played demo leads:** any `jainutsav67+<something>@gmail.com`. The company is researched for real and duplicate and rate limits do not apply. The card carries no DEMO tag, and the person typed on the form is enriched like any lead: LinkedIn and role. The paid phone lookup (FullEnrich) is switched off for everyone: `phone_lookup` in `rules.json`.
- **Tier B at short notice:** a meeting booked less than 4 hours ahead is not auto-released by the "unconfirmed 4 hours before" rule.

## CRM history

Every card about a company carries up to 3 lines: touches, deal status, latest note. Template only, no AI. Shown on Tier A/B/C briefs, customer, open deal, closed lost, expansion (the parent's history) and gate rejections. A company that is not in the CRM shows "No prior activity. Net new account." Read from HubSpot (emails, calls, meetings, notes, deals), saved for 60 minutes; "CRM history unavailable" if the read fails. Seed: `node scripts/seed-history.js` (TEST records for Initech, Northwind, Globex, Acme, Salesforce).

## Open problems

- **HubSpot email read is 403.** The service key needs `sales-email-read` (or `crm.objects.emails.read`). Until then accounts with emails (Initech, Northwind) show "CRM history unavailable", and the history seed cannot be re-run.
- **15-minute fallback not proven live.** Two live tests failed to book by themselves. Likely cause: the last delayed call was cut off after 10 seconds, before the booking finished. A fix is deployed (`api/sweep.js` now answers at once and works afterwards) but has not been re-tested live.
- **`/demo` in a real browser not confirmed.** Whether the picker appears in place, or Tally's redirect sends the visitor to `/book`, needs one manual test. If it redirects, remove the redirect in `scripts/setup-tally.js`.
- **Timers on a schedule:** Vercel's free plan runs them once a day; they also run on every new lead. The GitHub job in `scripts/github-sweep-workflow.yml` is written but not enabled.

## Proven on the live site

- Signed form submissions, Airtable log, Tally retry handling.
- Routing of customer, open deal, closed lost, expansion, disqualified, Tier A and Tier C leads to the right Slack channel and owner.
- A real booking end to end: Cohere (picked on the slot page) and Northwind (booked by a manual run of the timed rules), each with a calendar event.
- Company data from Apollo; web check, news and people search from Exa; pricing page from Firecrawl; one Gemini summary.
- CRM history from HubSpot for Globex, Acme and Salesforce.
- Automatic rejection email for a slam-dunk reject.

## Not proven live

- A real click on a Slack button by a person; re-routing through "Wrong: A / B / C".
- The Slack card being edited to "Booked".
- The person lookup for a demo alias.
- FullEnrich phone lookup.
- The expansion card with the parent's history (covered by tests only).

## Tests

- `node --test`: 196 tests pass.
- `node scripts/replay.js`: 15 of 15 sample leads match. Also `--no-pick` (15-minute fallback) and `--busy` (picked time taken meanwhile).

## Known gaps and judgement calls

- **No footer or disclaimer** on `/book`, `/demo` or the Tally form, by decision.
- **Weekend-looking tabs:** slots are AE weekdays, but a visitor far from US Eastern can see one under a Saturday tab, because times are shown in their zone.
- **Booking race:** scoring and the pick finishing in the same instant is guarded by a mark-and-recheck on the Airtable row, not a true lock.
- **Person data:** Exa finds the LinkedIn profile and title; Blitz (`BLITZ_API_KEY`) then reads that profile for the role start date and earlier employers. A role started in the last 6 months is marked "recently joined" on the card (`person_recent_months`).
- **Google sign-in** expires 7 days after 7 Oct 2026 while the OAuth app is in Testing mode.
- **Emails name the product;** the forms and Slack alerts do not. The brief names the customer stories.
- **Airtable:** `first_choice`, `backup_choice`, `time_zone`, `website`, `drafts` and the default "Table 1" are not used by the engine and can be deleted by hand (the API cannot delete columns).

## Where things are

- Rules, lists, weights, team, templates, form options: `rules.json`
- Spec: `BUILD_SPEC.md` is the original spec and does not describe the new form flow, CRM history or the signal changes; this file does.
- Form setup: `node scripts/setup-tally.js pblqzy` (re-syncs the form from `rules.json`)
- Booking page preview: `node scripts/dev-server.js`
- Screenshots: `screenshots/` (taken before the footer was removed)
