# Inbound engine

Takes a demo request from a web form and, in about two minutes, checks it, researches the company, scores it, routes it to the right person in Slack, and books the meeting only if the lead qualifies.

> Concept built on public data. Not affiliated with any real company.

**Live demo:** https://inbound-engine-indol.vercel.app/demo

## What it does

A visitor fills in a short form (Tally) and picks a time next to it. The engine then:

1. **Rejects the obvious non-buyers for free**: personal or throwaway email, students and job seekers, agencies, recruiters, vendors, investors and press, fake data, duplicates within 30 days.
2. **Checks the CRM**: a customer, an open deal or a closed-lost account goes straight to its owner. No scoring, no paid calls.
3. **Checks the company family**: if a parent or subsidiary is a customer or has an open deal, the lead becomes an *expansion* card for that account's owner.
4. **Profiles the company** (CRM, then Apollo, plus a web check) and applies the gates: Americas HQ, sells to businesses, 200 to 2,000 employees.
5. **Looks for why-now signals** from the last 12 months, reads the pricing page, and finds the person.
6. **Scores out of 100 with fixed rules (no AI in the decision)**, and assigns Tier A, B or C.
7. **Posts a brief to Slack** addressed to the person who owns it ("For: Alex Morgan"), with the score breakdown and a source link for every claim, or "unknown".
8. **Books the meeting** on the calendar once the lead is qualified *and* has picked a time. Tier A is booked and confirmed automatically; Tier B is held for an SDR to confirm; Tier C is never booked.

Nothing lands on the AE's calendar until the lead qualifies. Every alert names its owner. An unknown fact never disqualifies a lead.

## Routing

| Outcome | Goes to | Meeting |
|---|---|---|
| Tier A (score 60+) | #ae-alerts, AE | Booked, confirmation emailed automatically |
| Tier B (40 to 59) | #sdr-inbound, SDR | Held on the AE's calendar; SDR confirms or releases |
| Tier C (below 40) | #inbound-review, reviewer | Not booked; reviewer sends to SDR, nurtures or rejects |
| Disqualified | #inbound-review, reviewer | None. Slam-dunk rejections are emailed automatically |
| Existing customer | #cs-alerts, CSM | None |
| Open deal | #ae-alerts, deal owner | None |
| Closed lost | #ae-alerts, old deal owner, with the history | None |
| Expansion (parent or subsidiary is a customer) | The account owner | None |
| Errors, rate limits, fail-open, Monday summary | #revops-engine, RevOps | Fail-open books anyway |

Team names, channels and what each person receives live in `rules.json` under `team`.

## Scoring

| Part | Max | How |
|---|---|---|
| Fit | 35 | Industry tier (core 20, adjacent 12, other B2B 5) plus funded 15 |
| Persona | 30 | Finance leader 30, RevOps/billing/finance manager 21, founder or CEO 15, engineering 9, other 3 |
| Billing model | 15 | Usage or hybrid pricing 15, tiered 8, anything else 0 |
| Why now | 20 | Funding 5, new finance leader 4, IPO prep 3, M&A 3, revenue milestone 2, international expansion 2, partnership 1; layoffs are a penalty of 5 |

Why-now signals count only if they show business growth or decline, fall inside 12 months, and carry a date and a URL. A Gemini summary may write two or three lines from those signals, and falls back to a template if it adds a number that isn't in them.

## Architecture

```
Tally form ──signed webhook──▶ POST /api/lead ──▶ raw payload to Airtable, 200 returned
                                     │
                                     ▼ (runs after the reply)
        free checks ▶ CRM lookup ▶ family ▶ profile ▶ gates ▶ signals ▶ score ▶ tier
                                     │
                    ┌────────────────┼──────────────────┐
                    ▼                ▼                  ▼
              Slack card      Airtable log          CRM save
                    │
   /demo ── time picker ──▶ POST /api/slot ──▶ booked when qualified AND picked
```

- **Runtime:** Node 22, ES modules, native `fetch`, no SDKs. One dependency (`@vercel/functions`). Deployed on Vercel; every push to `main` deploys.
- **Rules, not code:** every list, weight, threshold, slot time, team member, channel, email template and form option is in `rules.json`.
- **Connectors** (`lib/connectors/`), each with a mock for `DRY_RUN`:

  | Tool | Used for |
  |---|---|
  | Tally | Form and signed webhook |
  | Airtable | Lead log, review queue, cache |
  | HubSpot | CRM, history, customer/deal/parent links |
  | Apollo | Company data, family, person fallback |
  | Exa | News signals, web check, person search |
  | Firecrawl | Pricing page |
  | Clay | Person enrichment (webhook out, callback in) |
  | Blitz | Role start date and earlier employers |
  | Gemini | Short summary of the signals (optional) |
  | Slack | Alerts and action buttons |
  | Mailbox (SMTP + iCal) or Google API | Calendar free/busy, invites, email |

### Endpoints

| Route | Purpose |
|---|---|
| `POST /api/lead` | Tally webhook. Verifies the signature, logs, replies 200, runs the pipeline in the background |
| `GET /demo` | The form and the time picker side by side |
| `GET /book` | The time picker |
| `GET /api/slots` | Open times (`?open=1`) or the times for a submission (`?sid=`) |
| `POST /api/slot` | Stores the picked time and books if the lead is qualified |
| `GET/POST /api/action` | Signed one-click actions (confirm meeting, not qualified, nurture, ...). GET shows a confirm page; only POST acts |
| `POST /api/slack-actions` | Slack button clicks (signature verified) |
| `POST /api/clay-callback` | Clay's enriched person (token verified) |
| `GET /api/sweep` | Timed rules: 15-minute booking fallback, Tier B reminder and release, nurture default |
| `GET /api/summary` | Monday summary to #revops-engine |

### Guard rails

- **Cheapest checks first.** Nothing paid runs for a lead an earlier step settled.
- **Fail open.** An unexpected error after the free checks still books the meeting, and posts an "Engine error" alert to RevOps.
- **Time limits.** 20 seconds per external call; on timeout the cached result is used (labelled "cached") or the fact is "unknown".
- **Cache** of paid results for 7 days. **Rate limits:** 3 per company domain per hour, 40 paid runs per hour.
- **Signed links** with HMAC, 24-hour expiry, idempotent. Form text is treated as data, never as instructions.
- **Emails are fixed templates** in `rules.json`, sent at most once each per lead.
- **Booking race:** scoring and the time pick can finish together; a mark-and-recheck on the Airtable row makes sure only one books.

## Getting started

```bash
npm install
cp .env.example .env     # fill in the keys you have
npm test                 # 201 tests, mock connectors
node scripts/replay.js   # 15 sample leads, expects 15 of 15 to match
```

Everything runs offline with `DRY_RUN=true`: mock connectors, no paid calls, nothing sent, nothing booked.

### Environment

Copy `.env.example` and fill in only what you use. The main groups:

| Group | Variables |
|---|---|
| App | `BASE_URL`, `DRY_RUN`, `DEMO_MODE`, `DEMO_INBOX`, `CRM_PROVIDER` (`hubspot` or `airtable`), `NOTIFIER`, `LINK_SECRET`, `AE_TZ` |
| Tally | `TALLY_FORM_URL`, `TALLY_API_KEY`, `TALLY_SIGNING_SECRET` |
| Storage and CRM | `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `HUBSPOT_TOKEN` |
| Enrichment | `APOLLO_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `CLAY_WEBHOOK_URL`, `BLITZ_API_KEY`, `FULLENRICH_API_KEY` |
| Writer (optional) | `LLM_PROVIDER` (`none`, `gemini`, `claude`), `GEMINI_API_KEY`, `GEMINI_MODEL`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` |
| Calendar and email | `SMTP_HOST`, `SMTP_USER`, `SMTP_APP_PASSWORD`, `CALENDAR_ICAL_URL` — or the Google API: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` (turns link actions into buttons) |

Keys live only in environment variables. `.env` is git-ignored.

### Setting up the services

```bash
npm run setup:slack      # creates the 5 channels and a pinned welcome message
npm run setup:airtable   # creates the Leads, Cache and CRM tables
npm run setup:hubspot    # custom properties and TEST records (--reset to start over)
node scripts/setup-tally.js <form-id>   # syncs the form from rules.json
npm run google-token     # one-time Google refresh token (optional route)
npm run smoke            # one small real call per service; --send also sends test messages
```

### Trying it locally

```bash
node scripts/dev-server.js           # booking page preview, DRY_RUN, nothing sent
node scripts/replay.js               # all 15 samples
node scripts/replay.js --no-pick     # nobody picks a time: 15-minute fallback
node scripts/replay.js --busy        # the picked time is taken while they choose
node scripts/replay.js 03-logistics  # one sample by id
```

### Demo aliases

For role-playing a lead without a real company, any `<inbox>+<company-domain>@gmail.com` stands in for that company (for example `+temporal.io`). The company is researched for real, and duplicate and rate limits do not apply. Fixed aliases for the test accounts (customer, open deal, closed lost, parent/subsidiary) are in `rules.json` under `demo_aliases`. The inbox is `demo_alias_mailbox`.

## Repo layout

```
api/            Vercel handlers (lead, slots, slot, book, demo, action, slack-actions, clay-callback, sweep, summary)
lib/            The engine: checks, profile, signals, score, brief, alerts, booking, emails, sweep, ...
lib/connectors/ One file per service, plus mock/ for DRY_RUN
scripts/        Setup, smoke test, replay, dev server, history seed, GitHub sweep workflow
test/           node --test suites and fixtures
data/           Mock world, CRM seed and history, the 15 sample leads
rules.json      Every rule, list, weight, template and team member
BUILD_SPEC.md   The original spec
STATUS.md       What is live, what was proven, and open problems
```

## Status

Built and running on the live site, with a complete flow from form to booking.

- 201 tests pass; all 15 sample leads match their expected outcome.
- Proven live: signed submissions, Airtable log, routing to the right channel and owner for every outcome, a real end-to-end booking with a calendar event, company data, news, pricing and CRM history, and the automatic rejection email.
- Not yet proven live: a person clicking a Slack button, re-routing through "Wrong: A / B / C", the Slack card edit to "Booked", the FullEnrich phone lookup (switched off), and the expansion card with the parent's history (tests only).
- Open: the HubSpot email read returns 403 until the key has the `sales-email-read` scope; timers run once a day on Vercel's free plan (plus on every new lead), and the hourly GitHub workflow in `scripts/github-sweep-workflow.yml` is written but not enabled.

See [`STATUS.md`](STATUS.md) for the full list, the rules worth knowing, and known gaps.

## License

No license has been set. All rights reserved by the author until one is added.
