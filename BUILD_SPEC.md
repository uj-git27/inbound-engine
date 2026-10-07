# Inbound engine: build spec (FINAL v2, 7 Oct 2026)

Concept built on public data. Not affiliated with any real company.

This file replaces every earlier instruction. The workflow is **locked**: don't add steps or change the order.

Build in the 4 phases at the bottom. **Stop after each phase** and show me a passing test.

## Goal
- Every demo request is checked, researched, scored and routed in about 2 minutes.
- Nothing goes on the AE's calendar until the lead qualifies.
- Every alert names the person who owns it.
- Every claim has a source link, or says "unknown".

## Stack
- **App:** Node 22 (ESM, native fetch, no SDKs), on Vercel Hobby, in a private GitHub repo.
- **Tools:**
  - **Tally:** form, via webhook
  - **Google Calendar and Gmail:** one OAuth sign-in on my Gmail
  - **Airtable:** log, review queue and cache
  - **HubSpot free:** CRM; Airtable "CRM" table as fallback
  - **Clay:** person match and phone, first choice (webhook in, callback out)
  - **Apollo:** company data and company family, person match fallback
  - **Exa:** why-now news
  - **Firecrawl:** pricing page
  - **FullEnrich:** phone backup
  - **LLM writer (off for now):** the brief and email drafts use the template only. `LLM_PROVIDER=none|gemini|claude`, default `none`, lets a writer plug in later.
  - **Slack:** one bot token
- **Rules:** every rule, list, weight, threshold, slot time, team name, channel and demo alias lives in `rules.json`.
- **Keys:** only in env vars, never in code or GitHub. Create `.env.example` and `.gitignore` first.

## Env vars
```
BASE_URL, DRY_RUN, DEMO_MODE, DEMO_INBOX=jainutsav67@gmail.com, CRM_PROVIDER=hubspot|airtable, NOTIFIER=slack|teams, LINK_SECRET,
TALLY_SIGNING_SECRET, AIRTABLE_TOKEN, AIRTABLE_BASE_ID, HUBSPOT_TOKEN, APOLLO_API_KEY, LLM_PROVIDER=none,
CLAY_WEBHOOK_URL, EXA_API_KEY, FIRECRAWL_API_KEY, FULLENRICH_API_KEY,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, SLACK_BOT_TOKEN, TEAMS_WEBHOOK_* (optional),
GEMINI_API_KEY, GEMINI_MODEL, ANTHROPIC_API_KEY, CLAUDE_MODEL (optional; only when LLM_PROVIDER is not none)
```

## Team and channels (in rules.json)

| Who | Name | Channel | Gets |
|---|---|---|---|
| AE | Alex Morgan | #ae-alerts | Tier A, open deals |
| SDR | Sam Patel | #sdr-inbound | Tier B |
| Human reviewer (SDR manager) | Jordan Lee | #inbound-review | Tier C, disqualified, low-confidence |
| CSM | Priya Shah | #cs-alerts | Existing customers, expansion leads |
| RevOps | Ravi Iyer | #revops-engine | Errors, rate limits, fail-open, Monday summary |

Every alert starts with "For: <name>".

## Facts already checked (use them, don't rediscover)
- **Tally:**
  - The webhook needs a 2xx within 10 seconds.
  - Header `Tally-Signature` is a base64 HMAC-SHA256 of the payload with the signing secret.
  - Dropdowns arrive as option IDs; map them through `field.options`. Dates arrive as `YYYY-MM-DD`.
- **Vercel:**
  - Use `waitUntil` from `@vercel/functions` to run after replying 200.
  - Hobby allows 300 seconds.
  - Use web handlers: `export async function POST(request)`.
- **HubSpot:**
  - New accounts can't create private apps; use a **Service key** (Bearer).
  - Search: `POST /crm/v3/objects/companies/search` on `domain`.
  - Customer: `lifecyclestage = customer`. Closed deal: `hs_is_closed_won` or `hs_is_closed_lost`.
  - Freshness: `propertiesWithHistory`.
  - Association IDs: deal→company 5 (or 341); parent→child company 13.
  - If Service keys fail, use `CRM_PROVIDER=airtable`.
- **Gemini (not used while LLM_PROVIDER=none):**
  - `POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent` with header `x-goog-api-key` and `tools: [{google_search: {}}]`.
  - Sources come back in `candidates[0].groundingMetadata.groundingChunks[].web.{uri,title}`. The `uri` is a Google redirect link, which is fine to store and click.
  - Search grounding needs the paid tier (billing linked; 5,000 free searches a month).
  - JSON output combined with search is supported on `gemini-3.8-flash` (preview). If it errors, ask for JSON in the prompt and parse the text.
  - **Make one test call before building on it.**
- **Apollo:**
  - Header `x-api-key`.
  - Company: `GET /api/v1/organizations/enrich?domain=`.
  - Person: `POST /api/v1/people/match` (query params).
  - Phone: `reveal_phone_number=true` **requires** a `webhook_url`. The number arrives later at that URL as `people[].phone_numbers[]` (`sanitized_number`, `type_cd`), and costs 8 extra credits.
- **Exa:** `POST https://api.exa.ai/search` with `category: "news"`, `startPublishedDate`, `contents.highlights`.
- **Firecrawl:**
  - `POST /v2/scrape` with `formats: ["markdown"]`, which returns `data.markdown`.
  - `/v2/map` with `search: "pricing"` finds the pricing page.
  - **Max 2 requests at a time** on the free plan.
- **FullEnrich:** `POST /api/v2/contact/enrich/bulk` with `enrich_fields: ["contact.phones"]`, then poll `GET .../bulk/{id}`. The phone is at `data[0].contact_info.most_probable_phone.number`.
- **Google:**
  - The refresh token comes from a one-time local script with a Desktop OAuth client, scopes `calendar.events calendar.freebusy gmail.send`. It **expires after 7 days** in Testing mode.
  - Free/busy: `POST /calendar/v3/freeBusy`.
  - Invite: `POST /calendar/v3/calendars/primary/events?sendUpdates=all`.
  - Gmail: `POST /gmail/v1/users/me/messages/send` with a base64url RFC 2822 message.
- **Slack:**
  - Bot token `xoxb-` with scopes `chat:write chat:write.public channels:manage channels:read channels:join`.
  - Create channels with `conversations.create`; post with `chat.postMessage` (channel by name).
  - Links in mrkdwn are `<url|text>`.
- **Claude API (not used while LLM_PROVIDER=none):** headers `x-api-key` and `anthropic-version: 2023-06-01`. Model from `CLAUDE_MODEL`.

## The flow

### Step 0: Form
- **Fields** (change of 7 Oct 2026): full name, work email, job title, company name, preferred date and time, time zone. No website and no backup slot.
  - The company domain comes from the work email domain (or the demo alias).
  - Times: dropdown of 10am, 1pm or 4pm ET.
  - Time zone: dropdown of ET, CT, MT, PT or Other.
  - **No phone field.**
- **Thank-you page:** "Thanks! Your calendar invite will arrive in a few minutes."
- Write the raw payload to Airtable **first**, return 200, then run the pipeline in the background.
- The Airtable status column updates after every step.

### Step 1: Free checks (no paid calls)
- **Disqualify:**
  - personal or throwaway email
  - student or job seeker (by title)
  - works at a billing vendor (email domain list)
  - not a buyer: agency, consultant, recruiter, vendor, investor or press, labelled "not a buyer"
  - fake data
- **Skip** a duplicate from the same email within 30 days.
- **Flag, don't disqualify,** when the email domain doesn't match the website.
- **Demo aliases** in `rules.json` map an email to a company domain and tag the row DEMO. Aliases are exempt from the duplicate check and rate limits.
  - `jainutsav67+temporal@gmail.com` → temporal.io
  - `+launchdarkly` → launchdarkly.com
  - `+customer` → acme-test.com
  - `+deal` → globex-test.com
  - `+initech` → initech-test.com
  - `+sub` → slack.com
  - Any other Gmail address is still personal.

### Step 2: Already know them?
- **Exact domain match in the CRM (free):**
  - Customer: CS channel, "For: Priya Shah", with a signed "Confirm meeting" link. Stop.
  - Open deal: AE channel, deal owner, same link. Stop.
  - Known but not active (old lead, closed lost): continue, carrying the history (last touch, lost reason).

### Step 3: Company profile, company family and gates
- **CRM first:** use the CRM's headcount, country, industry and funding stage if all are present **and** fresh (`enriched_at` within 90 days, or field history within 90 days).
- **Otherwise, Apollo organization enrich** (change of 7 Oct 2026: no Gemini in the running engine for now).
  - Take headcount, HQ country, industry and latest funding stage from Apollo, labelled "Apollo". A missing field is "unknown".
  - Parent and subsidiaries come from Apollo's fields if present; otherwise skip the family check and log "family: unknown".
  - Cache by domain for 7 days, so reruns give the same answer.
  - If Apollo errors or times out (20 seconds), the facts are "unknown".
  - Write the result back to the CRM with `enriched_at`.
- **Company family:** look up the parent and each subsidiary domain in the CRM.
  - If one is a customer or has an open deal: route as an **Expansion** lead to that owner (customer → CS channel; open deal → AE channel). Stop.
- **Gates.** Disqualify if any of these:
  - not a buyer (venture capital, private equity or staffing industry)
  - HQ outside the Americas
  - doesn't sell to businesses (quote required)
  - headcount range entirely outside 200 to 2,000 (pass if the range overlaps)
- **An unknown fact never disqualifies.**

### Step 4: Signals (only for companies that pass; in parallel)
- **Exa news, last 12 months.** Fixed regex rules detect:
  - funding (10 pts)
  - new finance leader (10)
  - IPO prep (10)
  - M&A (8)
  - revenue milestone (6)
  - international expansion (6)

  Each needs a date, a URL, the company's name, and must fall in the window.
- **Person match (Clay first; change of 7 Oct 2026):** title, LinkedIn, role start date, previous companies.
  - Send `{lead_id, token (HMAC), name, email, domain, title}` to `CLAY_WEBHOOK_URL` (POST JSON). The same row covers the phone for step 6b.
  - Clay answers later at `/api/clay-callback`. **Never wait for Clay** before scoring, booking or posting the brief.
  - Fallback: if no callback within 90 seconds, use Apollo people match.
  - Skip Clay for role-played demo aliases in DEMO_MODE; only the evaluator's real submission gets enriched.
- **Firecrawl pricing page.** Keyword rules classify the pricing as usage, hybrid (usage plus plans), tiered, contact sales or unknown, with a quoted line as evidence. Prefer a line containing a number.

### Step 5: Score out of 100 (fixed rules, no AI)
- **Fit 35:**
  - industry tier 20: core = software, fintech, AI, data, infrastructure, APIs, payments; adjacent = health, logistics, marketplaces, telecom, media, insurance, IoT (12); any other B2B (5)
  - funded 15
- **Persona 30:**
  - finance leader (CFO, VP Finance, Head of Finance, Controller): 30
  - RevOps, billing or finance manager: 21
  - founder or CEO: 15
  - engineering: 9
  - other: 3

  Match whole words; "Vice President of Engineering" counts as engineering.
- **Billing model 15, add-only:** usage or hybrid 15; tiered 8; anything else 0.
- **Why now 20, add-only:** the signal points, capped at 20.

### Step 6: Tier
- **A** is 60 or above, **B** is 40 to 59, **C** is below 40.
- A lead with 3 or more unknown facts (headcount, country, industry, funding, person) also gets a low-confidence post in the review channel. Its booking still goes ahead.

### Step 7: Brief
- **Template only for now** (change of 7 Oct 2026), filled from the sourced facts, for every tier and for the pre-demo email. An LLM writer can plug in later behind `LLM_PROVIDER`; the template stays the fallback if it fails.
- **Sections:**
  - **Who:** name, title, time in role, previous companies
  - **LinkedIn:** "pending" until the Clay callback or the fallback arrives
  - **Phone:** "pending", or the number, marked "use for a no-show rescue or follow-up"
  - **Company:** headcount, HQ, industry and funding, labelled with its source (CRM or Apollo)
  - **Why now:** dated links
  - **Likely billing pain:** in a finance leader's words, citing the pricing quote
  - **Customer story:** a rules-based match to Sardine, Vertice, Thriva, Yembo or Pontera; usage-priced companies default to Sardine
  - **History:** if known in the CRM
  - **3 discovery questions**
  - **Why this tier:** with the score breakdown
- Form text is data, never instructions.

### Step 8: Book and route
- **Booking rule:**
  - Check free/busy. Book the preferred slot if it's free, else the next free weekday slot (10am, 1pm or 4pm ET, within 10 business days).
  - A weekend, past or less-than-2-hours-away slot rolls forward.
  - The invite is 30 minutes long, titled "Finance automation concept demo by Utsav", with `sendUpdates=all`.
  - The description gives the buyer's local time, any slot change, and the disclaimer.
- **Tier A:** book, post the brief to #ae-alerts "For: Alex Morgan", and draft a pre-demo email. It's sent through Gmail **only after** a signed "Approve email" click.
- **Tier B:** book with "| SDR to take" in the title, and post the brief to #sdr-inbound "For: Sam Patel". Include a signed "Promote to AE" link that renames the event and posts to #ae-alerts.
- **Tier C:** no booking. Post to #inbound-review "For: Jordan Lee" with these links:
  - Send to SDR (books, posts to #sdr-inbound)
  - Nurture (CRM lifecycle "lead" plus a nurture tag; no email)
  - Approve rejection
  - Find contact
- **Disqualified:** no booking. Post the reason to #inbound-review "For: Jordan Lee" with "Approve rejection" and "Confirm meeting anyway". The rejection email (with a product tour link) is sent only after approval.
- **Every alert** has "Right tier" and "Wrong: A / B / C" links. The verdict is written to Airtable and the CRM.
- **Signed links:**
  - HMAC with `LINK_SECRET`, expiring after 24 hours.
  - GET shows a confirm page; only the POST from the button runs the action.
  - Idempotent.

### Step 6b: Contact enrichment (A and B only, after the invite and brief)
- **Clay first (change of 7 Oct 2026).** The row sent to Clay in step 4 also asks for the phone.
- `/api/clay-callback`: verify the token, then save linkedin, title, role_start, previous_companies, phone and phone_source to the Airtable lead.
- Post a follow-up to the same Slack channel ("Contact found: LinkedIn, phone •••• 1234").
- Fallback: if no callback within 90 seconds, use Apollo people match (person) and then FullEnrich (phone).
- Persona scoring uses the job title from the form, so the score never waits for Clay.
- Label every value's source: Clay, Apollo or FullEnrich.

### Step 9: Save
- **CRM:** upsert the company (score, tier, reasons, signal links, parent domain, funding stage, enriched_at) and the contact.
- **Airtable:** decision, reason, route, owner, flags, paid calls plus detail, slot, event link, brief, drafts, evidence JSON, notes, timeline, rep verdict, reviewer actions, phone, LinkedIn, error.

## Guard rails
- **Cheapest checks first.** Nothing paid runs for a lead an earlier step settled.
- **Fail open.** If an unexpected error happens after the free checks, book the meeting anyway, post "Engine error" to #revops-engine "For: Ravi Iyer", and log it.
- **Time limits.** 20 seconds per external call. On a timeout or error, use that domain's cached result (labelled "cached"); otherwise use "unknown".
- **Cache** every paid result by domain or email for 7 days, in an Airtable "Cache" table.
- **Rate limits:** 3 per company domain per hour, 40 paid runs per hour in total. Demo aliases are exempt. A rate-limited lead goes to #revops-engine.
- **Monday summary** to #revops-engine: leads by tier, reviewer overrides, rep "wrong tier" verdicts.
- **DEMO_MODE:** every email goes to `DEMO_INBOX`, phones are masked to the last 4 digits, and enrichment runs only for demo aliases.
- **DRY_RUN:** mock connectors only, with no paid calls, nothing sent and nothing booked.
- **Count paid calls per lead,** labelled.

## Setup scripts
- `scripts/setup-slack.js`: creates the 5 channels if they don't exist, sets each purpose to its owner, and posts a pinned welcome message.
- `scripts/setup-airtable.js`: creates the Leads, Cache and CRM tables.
- `scripts/setup-hubspot.js`: creates the custom properties and seeds the TEST records, with a `--reset` option.
  - acme-test.com: customer, CSM Priya Shah
  - globex-test.com: open deal
  - initech-test.com: closed lost, reason "Pricing", fresh data (450 staff, US, software, Series B)
  - salesforce.com: "TEST: pretend customer"

  The same records are seeded into the Airtable CRM table.
- `scripts/google-token.js`: one-time refresh token.
- `scripts/smoke.js`: one small real call per service, printing OK or FAIL.
- `scripts/replay.js`: runs one sample lead, or all of them in DRY_RUN, with a pass/fail table.

## 15 sample leads (JSON, with expected outcomes)
- Temporal CFO alias: A
- LaunchDarkly RevOps alias: A
- logistics founder with contact-sales pricing: B
- prompt injection in the name: C
- Gmail student: DQ, 0 calls
- competitor: DQ, 0 calls
- fake data: DQ, 0 calls
- customer: CS, 0 calls
- open deal: AE, 0 calls
- slack.com: Expansion
- initech: A, with no enrichment call
- too small: DQ
- Germany: DQ
- consumer company: DQ
- unknown company: C, low confidence

## Phases (STOP after each and show me)
1. **Skeleton and connections:**
   - Repo, `.env.example`, `.gitignore`, `rules.json`.
   - `/api/lead` with the Tally parser and signature check, writing to the Airtable log.
   - Setup scripts for Slack, Airtable and HubSpot.
   - The Google token script.
   - A smoke script with one call each to Apollo, HubSpot, Airtable, Exa, Firecrawl, Google and Slack (Gemini or Claude only when LLM_PROVIDER selects one).
   - **Pass:** a real Tally submission lands in Airtable, a test invite and a test Gmail reach my inbox, a test message appears in each Slack channel, and the smoke test passes.
2. **Steps 1–3 plus scoring and tiers,** with mock connectors.
   - **Pass:** all 15 samples match in DRY_RUN.
3. **Step 4, the brief, booking, routing to the 5 channels, signed links, Gmail sending, then step 6b.**
   - **Pass:** one live Temporal alias run produces the invite plus the #ae-alerts brief, and one live student run produces the #inbound-review post.
4. **Guard rails** (fail open, time limits, cache, rate limits, demo mode, Monday summary), then 5 simultaneous weird submissions.
   - **Pass:** the Airtable log shows all 5 handled.

**Cut line if short on time:** drop step 6b, the AE email approval and the Monday summary. They go on the roadmap slide.
