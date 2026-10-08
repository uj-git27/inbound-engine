# Status

Last updated: 8 Oct 2026. Concept built on public data.

## Two versions exist right now

| | Live on Vercel | In the repo, NOT deployed |
|---|---|---|
| Form | Old Tally form: name, work email, job title, company name, preferred date and time, time zone | New Tally step 1 (to be built by Utsav) plus our own slot page at `/book` |
| Booking | Booked from the slot typed on the form | Booked when the lead is qualified AND has picked a time on `/book`, whichever comes second |
| Commit | `4388cc9` | `172f55a` and later |

Do not deploy the repo version until the new Tally form exists and one real test submission has been checked against the parser. Deploying it now would break the old form: its fields no longer match.

## What works (tests, DRY_RUN)

- `node --test`: 175 tests pass.
- `node scripts/replay.js`: 15 of 15 sample leads match. Also `--no-pick` (15-minute fallback) and `--busy` (picked time taken meanwhile).
- Core flow: webhook > free checks > CRM lookup > family check > company profile > gates > signals > score > tier > alert in Slack > Airtable log > CRM save.

## What is proven on the live site (old form)

- Form submission to Airtable, signature check, Tally retry handling.
- Routing of customer, open deal, closed lost, expansion (Apollo, web and HubSpot-linked), disqualified, Tier A and Tier C leads to the right Slack channel and owner.
- Company data from Apollo; web check, news and people search from Exa; pricing page from Firecrawl.
- Signed action links, and a simulated signed Slack button click.
- Automatic rejection email for a slam-dunk reject, sent through Gmail (to DEMO_INBOX in demo mode).
- Google sign-in: one test invite and one test email were accepted by Google.

## Not proven live

- A real lead being booked on the calendar end to end (old or new flow).
- A real click on a Slack button by a person.
- Re-routing through "Wrong: A / B / C" on a real alert.
- FullEnrich phone lookup (never run on a real lead).
- Everything in the new form flow: `/book`, `/api/slots`, `/api/slot`, the 15-minute fallback.
- The timers on a schedule: Vercel's free plan only runs them once a day. They also run on every new lead. The hourly GitHub job in `scripts/github-sweep-workflow.yml` is written but not enabled.

## The new form flow (in the repo)

1. Tally step 1 fields: First name, Last name, Work email, Number of employees (dropdown), Job title, How can we help? (optional), How did you hear about us? (optional).
2. Tally redirects to `/book?sid=@SubmissionID&e=@WorkEmail`.
3. `/book` calls `GET /api/slots?sid=`. A slam-dunk reject sees "Thanks, we'll be in touch by email." and no calendar. If the form has not reached us yet, the page retries every second for 5 seconds, then shows times anyway.
4. Slots: next 5 weekdays, 30 minutes, 9:00 to 17:00 in the AE's time zone (`AE_TZ`, default America/New_York), at least 2 hours out, minus anything busy on the calendar. Shown in the visitor's own time zone.
5. `POST /api/slot {sid, slot, tz}` stores the pick. Tier A: booked, "Invite on its way." Tier B: hold booked, "Our team will confirm shortly." Tier C and others: the pick is kept, nothing is booked.
6. Free/busy is checked again at booking. If the time was taken, the next free one is booked and the invite and email say so.
7. No pick within 15 minutes: Tier A and B get the next free slot.
8. A second POST for the same submission returns the existing booking.

Parser rules: the join key is the Tally submission ID; the domain comes from the work email; fields are found by label; dropdown IDs are resolved through the options list, never hardcoded.

Headcount: enrichment wins. With no enrichment, the range typed on the form drives the 200 to 2,000 gate. If both exist and are more than one band apart, the lead is flagged "headcount mismatch" for review; it is never disqualified for that.

## Before deploying the new flow

1. Done through the API (`node scripts/setup-tally.js`): new form https://tally.so/r/pblqzy with the webhook to `/api/lead` and a redirect to `/book?e=@Work email&sid=`. Still by hand: in the form's settings, under Redirect on completion, type @ at the end of the link and pick Submission ID. Until the deploy, a submission on this form reaches the old code on the live site.
2. One test submission with a +alias; check the parser against the real payload (labels and the employees dropdown).
3. `node scripts/setup-airtable.js` to add the new columns (employees_reported, in_their_words, lead_source, requested_slot, booked_slot, slot_changed, picked_at, buyer_tz, booking_lock).
4. Add `AE_TZ` to Vercel if the AE is not on US Eastern time.
5. Deploy, then run one live lead through `/book`.

## Known gaps and judgement calls

- **Footer on `/book`:** none, by decision. No disclaimer on the page or on the new Tally form.
- **Weekend-looking tabs:** slots are AE weekdays, but a visitor far from US Eastern can see one under a Saturday tab, because times are shown in their zone.
- **15-minute fallback without a scheduler:** the app asks itself to run again later, in hops of up to 4 minutes. Tested with mocks only.
- **Booking race:** scoring and the pick finishing in the same instant is guarded by a mark-and-recheck on the Airtable row, not a true lock.
- **Person data:** LinkedIn and title only (Exa). Time in role and previous companies stay unknown without a paid Apollo plan.
- **Google sign-in** expires 7 days after 7 Oct 2026 while the OAuth app is in Testing mode.
- **Emails name the product;** the forms and Slack alerts do not. The brief names the customer stories.

## Where things are

- Rules, lists, weights, team, templates: `rules.json`
- Spec: `BUILD_SPEC.md` (does not yet describe the new form flow; this file does)
- Booking page preview: `node scripts/dev-server.js`
- Screenshots: `screenshots/` (the phone-width ones show the page in the left 390px of the image)
