# Optima Solutions Stage 2 — HubSpot Order Sync (Milestone 7)

A NestJS service accepts signed `order.created` webhooks from an online store, stores each order in PostgreSQL, and synchronizes it to HubSpot. Each sync looks up or creates/updates a Contact, creates one Deal, and associates the Deal with the Contact. Temporary HubSpot failures are retried automatically: individual HTTP calls are retried with exponential backoff, and failed orders get durable retries scheduled in PostgreSQL. A Next.js dashboard shows the latest 50 synchronization attempts and lets an operator manually retry orders that are currently failed.

A standalone C#/.NET 10 console app exports every HubSpot Deal created in the last 7 days to CSV for the accounting team ([details](#milestone-7--hubspot-deals-csv-exporter)).

Not yet implemented (later milestones): the n8n workflow, Docker Compose, and deployment.

## Current status

| Area | Status |
| --- | --- |
| Webhook receiver, HMAC verification, validation, idempotent persistence | Done |
| HubSpot Contact upsert, Deal creation, association, unique `optima_order_id` | Done; live-verified in a developer test portal using PHP currency |
| Sync-attempt history, partial-failure recovery, advisory locking | Done |
| Dashboard: latest 50 attempts, status badges, HubSpot links, error details, manual Retry | Done |
| Automatic retry/backoff for 429/5xx/network errors (requirement 25) | Done: in-request HTTP retries plus durable order-level retries ([details](#automatic-retries)) |
| C# CSV export of the last 7 days of Deals (requirement 28) | Done; live read-only export verified |

The sample order `ORD-WEBHOOK-DEMO-20261018` is `synced`. Its history keeps one failed attempt, from before the HubSpot unique property existed, and one succeeded attempt. Because the order is synced, the dashboard shows "Up to date" instead of a Retry button.

## Technology stack

- **Backend:** Node.js 22+, NestJS 11, TypeScript 5.9, TypeORM 0.3, PostgreSQL 17, HubSpot CRM REST APIs via built-in `fetch`
- **Frontend:** Next.js 16 (App Router, Turbopack), React, TypeScript, Tailwind CSS 4, lucide-react icons
- **Testing:** Node test runner (`node --test`) against real PostgreSQL with mocked HubSpot, `@nestjs/testing`, and Playwright (Chromium)
- **Tooling:** npm workspaces, ESLint 9 (`eslint-config-next`), `concurrently`

## Project structure

```text
optima-hubspot-assessment/
  package.json, package-lock.json   # root workspace; the API lives in the root package
  tsconfig.json                     # compiles apps/api/src -> dist/
  playwright.config.ts              # browser tests (reads apps/dashboard/.env.local)
  .env.example                      # API / database / HubSpot placeholders
  apps/
    api/src/
      main.ts, application.ts, app.module.ts
      webhooks/      # POST /webhooks/orders: raw-body HMAC guard, DTO validation, persistence
      sync/          # OrderSyncService (locking, checkpoints, audit), RetrySchedulerService, CLI commands
      hubspot/       # HubSpot HTTP client (with retries), retry.ts backoff helpers, configuration preflight
      dashboard/     # GET /health, GET /sync-attempts, POST /orders/:id/retry + API-key guard
      database/      # data source, entities, migrations, verify script
    dashboard/                     # @optima/dashboard (Next.js)
      .env.example                 # dashboard placeholders (copy to .env.local)
      src/proxy.ts                 # HTTP Basic login for every page and API route
      src/app/page.tsx             # dashboard page
      src/app/api/dashboard/route.ts                 # server-side proxy: health + attempts
      src/app/api/orders/[orderId]/retry/route.ts    # server-side proxy: retry (same-origin only)
      src/components/dashboard.tsx # client UI
      src/lib/backend.ts           # server-only fetch to NestJS with the API key
  tests/
    database.test.cjs, webhooks.test.cjs, sync.test.cjs, dashboard.test.cjs, retry.test.cjs
    ui/dashboard.spec.ts           # Playwright
  tools/mock-webhook/send-order.mjs  # signed sample webhook sender
  tools/hubspot-deals-exporter/      # C# (.NET 10) Deals CSV exporter: src/, tests/, global.json, output/ (git-ignored)
  artifacts/                         # screenshots written by the browser tests
```

## Architecture

```text
Mock store --signed webhook--> NestJS :3001 /webhooks/orders
                                 | HMAC guard -> DTO validation -> INSERT orders (unique order_id)
                                 v
                               OrderSyncService (advisory lock per order)
                                 | -> HubSpot: Contact search/create/update -> Deal (unique optima_order_id) -> association
                                 | -> sync_attempts row per attempt (status, IDs, error, timestamps)
                                 v
Browser --Basic auth--> Next.js :3000 --(server-side, Bearer API key)--> NestJS /health, /sync-attempts, /orders/:id/retry
```

The browser only talks to Next.js. Next.js route handlers call NestJS server-side with `DASHBOARD_API_KEY`. HubSpot and PostgreSQL credentials exist only in the NestJS process.

## Environment variables

There are two local, Git-ignored files. Never commit real values.

**Root `.env`** (NestJS, migrations and CLI commands). Copy it from `.env.example`:

| Variable | Purpose |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | PostgreSQL connection (`optima_hubspot_db`) |
| `PORT` | API port. Use `3001`; port 3000 is the dashboard's |
| `NODE_ENV` | `development` |
| `WEBHOOK_SECRET` | Shared HMAC key for the store/sender and the receiver |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot private/legacy app token |
| `HUBSPOT_PIPELINE_ID`, `HUBSPOT_DEAL_STAGE_ID` | Internal IDs from `npm run hubspot:check` (e.g. `default`, `appointmentscheduled`) |
| `HUBSPOT_ORDER_ID_PROPERTY` | Unique Deal property, default `optima_order_id` |
| `DASHBOARD_API_KEY` | Random value of at least 32 characters, shared with the dashboard server |
| `HUBSPOT_PORTAL_ID` | Numeric HubSpot account ID used for record links. Leave it blank to show IDs without links |
| `HUBSPOT_RETRY_*`, `SYNC_AUTO_RETRY_*` | Optional retry tuning; the defaults apply when unset. See [Automatic retries](#automatic-retries) |

**`apps/dashboard/.env.local`** (Next.js server only). Copy it from `apps/dashboard/.env.example`:

| Variable | Purpose |
| --- | --- |
| `NESTJS_API_URL` | `http://localhost:3001` |
| `DASHBOARD_API_KEY` | Exactly the same value as in the root `.env` |
| `DASHBOARD_USERNAME` | Dashboard login username |
| `DASHBOARD_PASSWORD` | Dashboard login password, at least 16 characters |
| `DASHBOARD_ORIGIN` | `http://localhost:3000`; the only origin allowed to POST retries |

Generate random values in PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))
```

No variable uses the `NEXT_PUBLIC_` prefix. Do not add one for credentials, because Next.js inlines those values into browser JavaScript.

## Setup (Windows PowerShell)

Requirements: Node.js 22+ and PostgreSQL 17. Run every command from the project root. Use `npm.cmd` in PowerShell, or `npm` in other shells.

```powershell
npm.cmd ci
# Only if the files do not already exist:
Copy-Item .env.example .env
Copy-Item apps\dashboard\.env.example apps\dashboard\.env.local
# Edit both files and fill in real values.
```

### PostgreSQL

Create the database once (in DBeaver or psql): `CREATE DATABASE optima_hubspot_db;`. The DB role needs connect permission and DDL permission on the public schema for migrations.

```powershell
npm.cmd run migration:run   # applies tracked migrations; safe to rerun
npm.cmd run db:verify       # checks tables, applied migrations, and entity/schema alignment
```

`synchronize` and `migrationsRun` are both `false`, so schema changes go only through reviewed migrations. Milestone 6 adds one additive migration, `AddAutomaticRetryScheduling1792340000000`. It adds three columns (`orders.next_retry_at`, `orders.auto_retry_count`, `sync_attempts.triggered_by`) and an index; existing rows are unchanged. **Run `npm.cmd run migration:run` after pulling Milestone 6.** `migration:revert` undoes the last migration. Reverting the initial migration deletes its tables and data.

### HubSpot

Required app scopes: `crm.objects.contacts.read/write`, `crm.objects.deals.read/write` and `crm.schemas.deals.read`. Creating the property once also needs `crm.schemas.deals.write`. The account must have the order currency (PHP) enabled.

```powershell
npm.cmd run hubspot:check                      # read-only preflight; prints portal ID, currencies, pipelines
npm.cmd run hubspot:check -- --create-property # one-time creation of the unique optima_order_id property
```

Normal synchronization never creates schema. It stops if the unique property, the scopes, a valid stage or the currency is missing. Copy the printed numeric portal ID into `HUBSPOT_PORTAL_ID`.

## Running both applications

Use two PowerShell terminals in the project root.

**Terminal 1 — NestJS API (http://localhost:3001)**

```powershell
npm.cmd run build
npm.cmd start
# or, with recompile and restart on change:
npm.cmd run dev:api
```

**Terminal 2 — Next.js dashboard (http://localhost:3000)**

```powershell
# Development:
npm.cmd run dev:dashboard
# Or production:
npm.cmd run build:dashboard
npm.cmd run start:dashboard
```

Or run both in one terminal in development mode:

```powershell
npm.cmd run dev:all
```

Open **http://localhost:3000** and sign in with `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in the browser's login prompt. Use `localhost`, not `127.0.0.1`. Retry requests must come from `DASHBOARD_ORIGIN`, so the Retry button returns 403 from any other origin.

Both servers bind to `127.0.0.1` only. Stop them with Ctrl+C. If a port is already in use, find the process with `Get-NetTCPConnection -LocalPort 3000,3001 -State Listen`.

## Using the dashboard

- **Connection badge.** "Backend connected" appears only when NestJS answers `/health` and PostgreSQL responds. Otherwise the badge says "Backend unavailable" and an error banner explains why.
- **Summary cards.** Total, successful and failed counts cover the latest 50 attempts, and failed includes historical failures. "In progress" counts orders that are currently pending or processing, across all orders.
- **History table.** Shows the latest 50 attempts, newest first. Each row shows the order ID, attempt number and its trigger (`webhook`, `manual`, `automatic` or `command`; blank for attempts recorded before Milestone 6), attempt status, current order status, the Contact and Deal IDs that attempt recorded, an error link, and start/finish times in browser local time. When `HUBSPOT_PORTAL_ID` is set, IDs link to the HubSpot record.
- **Search and filter.** Search narrows rows by order ID, and the filter selects all, succeeded, failed or processing attempts. Both work on the 50 loaded rows only.
- **View error.** Opens the full, sanitized error text for that attempt.
- **Refresh.** Reloads health and history. Data does not refresh automatically.
- **Loading, empty and error states.** Skeleton rows appear while loading. "No synchronization attempts yet" appears when no attempts exist. A backend outage shows an alert and keeps the last loaded data, with Retry disabled.

### Manual Retry behavior

- Retry appears only on rows whose **order** is currently `failed`. A historical failed attempt on an order that is now `synced` shows "Up to date" instead.
- If an automatic retry is scheduled, the row shows "Auto retry <time>" under the Retry button. Retrying manually earlier is allowed.
- Clicking Retry opens a confirmation dialog. Confirming sends `POST /api/orders/:orderId/retry` to Next.js, which forwards it server-side to NestJS.
- NestJS calls the same `OrderSyncService.synchronize(orderId, failedOnly = true)` used by the webhook and the `sync:order` command. It takes the per-order PostgreSQL advisory lock and re-checks that the order is still `failed` inside the lock, so concurrent clicks or a racing webhook cannot cause double processing.
- A retry records a new attempt. Earlier attempts are never modified, except that attempts left `processing` by a crashed worker are closed as interrupted.
- An existing Deal is reused: the saved Deal ID is used, or the Deal is found by the unique `optima_order_id` property, so retries never create duplicate Deals.
- Manual and automatic retries share the per-order lock. If one is running, the other returns 409 / `processing` and does nothing. A successful manual retry clears the automatic schedule, and a manual retry that fails again starts a fresh automatic retry budget.
- Responses:

| HTTP | Meaning |
| --- | --- |
| 200 | Synced |
| 409 | Not eligible (synced, pending or processing) or already locked by another worker |
| 404 | Unknown order |
| 503 | Sync attempted and failed; the failure is recorded in history |
| 403 | Request came from a disallowed origin |

The dashboard shows the message and refreshes the history.

## API endpoints (NestJS, port 3001)

| Method & path | Auth | Description |
| --- | --- | --- |
| `POST /webhooks/orders` | `X-Webhook-Signature: sha256=<hex HMAC>` | Receive `order.created` (see the webhook contract below) |
| `GET /health` | `Authorization: Bearer <DASHBOARD_API_KEY>` | `{status, database, checkedAt}`; 503 if the database is unreachable |
| `GET /sync-attempts?limit=1..50` | Bearer key | Latest attempts (default and maximum 50), ordered by `started_at DESC, id DESC`. Each row: `id, orderId, attemptStatus, orderStatus, contactId, dealId, error, startedAt, finishedAt, trigger, nextRetryAt, autoRetryCount, retryEligible`. The response also includes `summary`, `limit` and `portalId`. Customer payloads are never returned, and errors are redacted for configured secrets and Bearer tokens |
| `POST /orders/:orderId/retry` | Bearer key | Manual retry of a currently failed order (status codes above) |

The Next.js browser-facing routes are `GET /api/dashboard` and `POST /api/orders/:orderId/retry`. Both require the Basic login, and retry also requires a same-origin `Origin` header. Requests without the key get 401. If the key is not configured, or is shorter than 32 characters, NestJS returns 503.

## Webhook contract

`POST /webhooks/orders` accepts `application/json` with exactly one signature header:

```text
X-Webhook-Signature: sha256=<64 lowercase hexadecimal characters>
```

The signature is HMAC-SHA256 with `WEBHOOK_SECRET`, computed over the exact request body bytes. A bounded raw-body parser (100 KB, no decompression) runs first. The guard compares signatures with `timingSafeEqual` before any JSON parsing, and only then does nested class-validator validation run. Unknown fields, implicit numeric coercion and invalid Unicode are rejected. Phone is optional and every other assessment field is required. Dates need seconds and a timezone, currency is uppercase ISO 4217, and items must contain 1–1000 entries. The total is not forced to equal the item sum, because tax, discounts and shipping are unspecified.

```powershell
npm.cmd run webhook:send -- ORD-NEW-SYNTHETIC-TEST   # signs and sends the sample payload with that order ID
```

Note that this sends a real order through the live HubSpot sync if the API is running with a real token. Use it sparingly.

| Result | HTTP |
| --- | --- |
| New order accepted (stored; sync attempted, success or failure recorded) | 201 `{"result":"accepted"}` |
| Duplicate `order_id` (no overwrite, no new sync) | 200 `{"result":"duplicate"}` |
| Bad or missing signature | 401 |
| Invalid authenticated payload | 400 |
| Oversized or compressed body | 413 / 415 |
| Database unavailable | 503 |

## Synchronization design

1. The worker takes a session-level PostgreSQL advisory lock keyed by `order_id` on a dedicated connection. A concurrent worker gets "processing" and skips. Synced orders are skipped without any remote calls.
2. Under the lock, any abandoned `processing` attempts are closed as interrupted, a new attempt row is created, and the order is set to `processing`.
3. The stored payload is revalidated. Scopes, the unique property, the pipeline stage and currency support are checked before any write.
4. The Contact is found by email (search, then a direct `idProperty=email` lookup if the search index lags) and then created or updated. Its ID is checkpointed immediately.
5. The Deal is looked up directly by `optima_order_id`. If it exists it is reused. Otherwise it is created with name `Order <order_id>`, the total as amount, the UTC close date taken from `created_at`, the configured pipeline and stage, and `deal_currency_code`. Its ID is checkpointed.
6. The default Deal→Contact association is created (PUT) and then read back to verify it.
7. The order is set to `synced` and the attempt to `succeeded`, atomically.

No database transaction is held across HTTP calls. Idempotency has two layers: the local unique `order_id`, and HubSpot's unique `optima_order_id`. A lost create response is recovered by the unique-property lookup. This is not a guarantee of global exactly-once processing: someone can delete, merge or edit records in HubSpot, and the integration does not repair those changes automatically. The session lock needs a direct connection or session pooling, not transaction-mode PgBouncer.

Errors become sanitized failed attempts. Raw HubSpot response bodies are never stored. Each HTTP request times out after 10 seconds.

## Automatic retries

There are two layers. Both reuse the existing synchronization workflow, lock, checkpoints and attempt history.

| | Layer 1: HTTP retries | Layer 2: order-level retries |
| --- | --- | --- |
| Unit | One HubSpot HTTP call | One full synchronization attempt (one `sync_attempts` row) |
| Where | `HubSpotService.retrying()`, inside the running attempt | `orders.next_retry_at`, picked up by `RetrySchedulerService` |
| Delays | Seconds (1s → 30s) | Minutes to an hour (1 min → 60 min) |
| Survives restart | No; an interrupted attempt is recovered by layer 2 | Yes; the schedule is stored in PostgreSQL |
| Recorded as | Not a separate row. An exhausted call adds "gave up after N HTTP tries" to the attempt error | A new `sync_attempts` row with `triggered_by = 'automatic'` |

### Retryable and permanent errors

- **Retryable (transient):** HTTP 429, 500, 502, 503 and 504, network errors, and the 10-second request timeout.
- **Permanent, never retried automatically:** 400, 401, 403, 404, 409, any other 4xx or 5xx, invalid payloads, missing or invalid configuration (token, scopes, unique property, pipeline/stage, currency), `deal_order_reference_mismatch`, `previous_deal_missing_do_not_recreate`, and `association_not_verified`. These need a fix and then a manual retry.
- Expected lookup 404s (Contact by email, Deal by `optima_order_id`) still mean "not found". They are never retried.

### Backoff formula

Retry *n* (1 = first retry) waits:

```text
cap(n)  = min(MAX_DELAY, INITIAL_DELAY × MULTIPLIER^(n−1))
delay   = cap(n)/2 + random[0,1] × cap(n)/2        # "equal jitter": uniform in [cap/2, cap]
```

The lower bound guarantees real spacing between tries, and the random half spreads out clients that failed at the same moment.

| Setting | HTTP layer (default) | Order layer (default) |
| --- | --- | --- |
| Max attempts | `HUBSPOT_RETRY_MAX_ATTEMPTS=5` (total tries, including the first) | `SYNC_AUTO_RETRY_MAX_ATTEMPTS=5` (automatic attempts after the initial webhook/manual/command attempt; `0` disables scheduling) |
| Initial delay | `HUBSPOT_RETRY_INITIAL_DELAY_MS=1000` | `SYNC_AUTO_RETRY_INITIAL_DELAY_MS=60000` |
| Multiplier | `HUBSPOT_RETRY_MULTIPLIER=2` | `SYNC_AUTO_RETRY_MULTIPLIER=2` |
| Maximum delay | `HUBSPOT_RETRY_MAX_DELAY_MS=30000` | `SYNC_AUTO_RETRY_MAX_DELAY_MS=3600000` |

HTTP caps for the defaults: 1s, 2s, 4s, 8s, so at most about 15s of waiting per call over 5 tries. Order caps for the defaults: 1, 2, 4, 8 and 16 minutes, so an order gets up to 6 full attempts over roughly half an hour. Other settings:

- `SYNC_AUTO_RETRY_ENABLED=true`: turns the poller on or off in the API process.
- `SYNC_AUTO_RETRY_POLL_INTERVAL_MS=15000`: how often the poller checks for due retries.
- `SYNC_AUTO_RETRY_STALE_AFTER_MS=300000`: after this long, a pending or processing order is treated as interrupted (see below).

Invalid values stop startup with a clear message.

### Retry-After

The `Retry-After` header is parsed as delta-seconds (`7`) or an HTTP-date (`Wed, 21 Oct 2026 07:28:00 GMT`).

- **HTTP layer:** when the header is present, its value replaces the computed backoff. HubSpot's minimum wait is respected and no jitter is added. If it exceeds `HUBSPOT_RETRY_MAX_DELAY_MS`, the call fails immediately instead of blocking the request.
- **Order layer:** the next attempt is scheduled at `max(backoff, Retry-After)`, capped at 24 hours.

### Idempotency during retries

- **Safe calls are retried directly.** These are GET reads, Contact search, scope introspection, the Contact PATCH (same properties every time) and the association PUT.
- **Creates are reconciled before any repeat.** A 5xx or timeout on `POST /contacts` or `POST /deals` is ambiguous, because HubSpot may already have created the record. Before trying again, the service waits out the backoff and then looks the record up:
  - Deals by the unique `optima_order_id`, using direct `idProperty` lookup, which does not depend on the search index.
  - Contacts by email, which HubSpot keeps unique, using search plus direct lookup.

  Only if nothing is found is the create sent again. Even then, HubSpot rejects a second Deal with the same `optima_order_id` (or a second Contact with the same email) with 400/409, and the existing conflict handler reconciles it.
- Contact and Deal IDs are still checkpointed as soon as they are known, so an order-level retry continues from where the last attempt stopped.
- This gives effectively-once Deal creation, not exactly-once delivery. Contact updates may be repeated, and records changed or deleted in HubSpot are not repaired.

### Scheduling, locking and restarts

- When an attempt fails with a transient error, the order is marked `failed`, with `next_retry_at` set and `last_error` filled in. Permanent failures leave `next_retry_at` NULL.
- The poller in the API process selects orders where `status = 'failed' AND next_retry_at <= now()`, plus pending or processing orders not updated for `SYNC_AUTO_RETRY_STALE_AFTER_MS`. Those are orders interrupted by a crash or restart, including an order accepted just before the process died. Only orders still within their automatic budget are selected.
- Each selected order goes through `OrderSyncService.synchronize(orderId, { trigger: 'automatic' })`. That takes the same non-blocking advisory lock as webhooks and manual retries, then re-checks eligibility under the lock (status, due time, budget).
- Synced orders are never touched. If another worker holds the lock, the poller skips the order and finds it again on a later poll.
- No transaction or lock is held while an order waits for its next retry. Only the short in-request HTTP delays (at most 30s each) happen inside a running attempt, outside any database transaction.
- **Restarts:** because the schedule is in PostgreSQL, scheduled retries survive restarts and run on the next poll after startup. A poll runs every `SYNC_AUTO_RETRY_POLL_INTERVAL_MS`. Ticks never overlap, and each poll processes up to 10 orders sequentially.
- **Exhaustion:** after `SYNC_AUTO_RETRY_MAX_ATTEMPTS` automatic attempts, the order stays `failed` with `next_retry_at` NULL, and the error ends with "automatic retries exhausted". Nothing else runs until someone uses the dashboard Retry or `npm run sync:order`. Every failed attempt stays in history.
- Only the long-running API (`npm start` / `dev:api`) runs the poller. The CLI commands and tests never start it.

Operator commands:

```powershell
npm.cmd run sync:order -- <order_id>    # process a pending/failed/interrupted order
npm.cmd run sync:verify -- <order_id>   # read-only check of local state against HubSpot; prints record links
```

## Tests and verification

```powershell
npm.cmd test                 # all backend suites (database, webhooks, sync, dashboard): real PostgreSQL, mocked HubSpot
npm.cmd run test:database
npm.cmd run test:webhooks
npm.cmd run test:sync
npm.cmd run test:dashboard   # dashboard API: auth, latest-50 ordering, retry eligibility, concurrency, redaction
npm.cmd run build; node --test tests/retry.test.cjs   # automatic retries only (also included in npm test)
npm.cmd run typecheck        # API tsc build + Next.js typegen + tsc --noEmit
npm.cmd run lint             # ESLint (dashboard)
npm.cmd run build:dashboard  # Next.js production build
npm.cmd run db:verify
npm.cmd run test:ui          # Playwright; requires both servers running and apps/dashboard/.env.local
```

If Playwright's browser is missing, install it with `npx.cmd playwright install chromium`.

`tests/retry.test.cjs` uses injected sleep and random functions, so it runs in seconds. It covers:

- backoff values and jitter bounds, and Retry-After in seconds and HTTP-date form;
- 429, 500, 502, 503, 504 and timeout followed by success, plus exhaustion after 5 tries;
- no retry on 400, 401, 403, 404 or 409;
- ambiguous Deal and Contact creates reconciled without duplicates;
- partial success followed by an automatic retry, and the order-level budget running out;
- concurrent manual and automatic retries;
- synced orders never being resynced, stale-order recovery, and the schedule surviving a restart.

The backend tests create uniquely named test orders, delete only those rows afterwards, and never contact HubSpot. Test rows get retry schedules a day in the future, so a dev API running against the same database never retries them. Still, prefer a separate test database. The browser tests use the real API for the demo-order history, login and cross-origin checks. They mock the dashboard routes for the loading, empty, outage and retry-flow cases, so they never trigger a live HubSpot write.

DBeaver checks (read-only):

```sql
SELECT order_id, status, hubspot_contact_id, hubspot_deal_id, last_error, synced_at
FROM public.orders WHERE order_id = 'ORD-WEBHOOK-DEMO-20261018';

SELECT id, status, hubspot_contact_id, hubspot_deal_id, error, started_at, finished_at
FROM public.sync_attempts WHERE order_id = 'ORD-WEBHOOK-DEMO-20261018' ORDER BY id;
```

## Milestone 7 — HubSpot Deals CSV Exporter

Requirement 28 asks for *"a small script that exports all deals created in the last 7 days from HubSpot to a CSV file for the client's accounting team"*, written in a second language. This is a standalone C# console app in `tools/hubspot-deals-exporter`.

- It is **read-only**: its only HubSpot call is the Deals search endpoint, and it never creates, updates or deletes records.
- It does not need NestJS, Next.js or PostgreSQL to be running.
- Following the brief literally, it exports **all** Deals in the account created in the window, not just Deals created by this integration.

### Requirements and layout

- **.NET SDK 10.0 (LTS)**. `global.json` pins `10.0.100` with `rollForward: latestFeature`, so any 10.0.x SDK works. Install it with `winget install Microsoft.DotNet.SDK.10`, or from https://dotnet.microsoft.com/download/dotnet/10.0.
- **Runtime dependencies:** none outside the base class library (`HttpClient`, `System.Text.Json`, `TimeProvider`).
- **Test dependencies:** xUnit, `xunit.runner.visualstudio` and `Microsoft.NET.Test.Sdk`.

```text
tools/hubspot-deals-exporter/
  HubSpotDealsExporter.sln, global.json
  src/HubSpotDealsExporter/          # console app
    Program.cs, Cli.cs               # arguments, exit codes, orchestration
    ExporterSettings.cs              # env var / root .env loading
    HubSpotDealsClient.cs            # search, pagination, retries
    DealCsvWriter.cs                 # RFC 4180 CSV, formula-injection guard
    Models.cs                        # export window, Deal, retry policy, errors
  tests/HubSpotDealsExporter.Tests/  # xUnit tests with a mocked HttpMessageHandler
  output/                            # default CSV location (git-ignored)
```

### Authentication

The exporter reuses the existing private-app token, `HUBSPOT_ACCESS_TOKEN`. It looks for it in two places:

1. A process environment variable.
2. Otherwise, the repository's **root `.env`** file, the same file the API uses. Nothing extra needs configuring.

`HUBSPOT_ORDER_ID_PROPERTY` (default `optima_order_id`) is read the same way. The token is sent only in the `Authorization` header. It is never printed, logged, or written to the CSV; the exporter only prints *where* the token came from.

**Required scope:** `crm.objects.deals.read`, which is already granted for the sync. No new key is needed.

To override the token for one PowerShell session without touching `.env`:

```powershell
$env:HUBSPOT_ACCESS_TOKEN = '<your private app token>'   # current session only
```

### Running

From the repository root, once the .NET 10 SDK is on PATH:

```powershell
dotnet run --project tools/hubspot-deals-exporter/src/HubSpotDealsExporter
dotnet run --project tools/hubspot-deals-exporter/src/HubSpotDealsExporter -- --output C:\Exports\deals.csv
dotnet run --project tools/hubspot-deals-exporter/src/HubSpotDealsExporter -- --output C:\Exports\
dotnet run --project tools/hubspot-deals-exporter/src/HubSpotDealsExporter -- --help
```

If you used the per-user SDK install instead, replace `dotnet` with `& "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe"`.

| Option | Meaning |
| --- | --- |
| *(none)* | Export the last 7 days to `tools/hubspot-deals-exporter/output/hubspot-deals-<UTC date>.csv`. A rerun on the same day replaces that file |
| `-o, --output <path>` | CSV file to write. An existing directory, or a path ending in `\` or `/`, gets the default file name inside it. Relative paths resolve from the current directory. Missing folders are created |
| `-h, --help` | Show usage |

| Exit code | Meaning |
| --- | --- |
| 0 | CSV written |
| 1 | Export failed: HubSpot temporary errors after retries, invalid response, or file write error |
| 2 | Invalid arguments |
| 3 | Configuration error, such as a missing or malformed token |
| 4 | HubSpot denied access (401 invalid/expired token, 403 missing scope) |

Example console output:

```text
Token source: D:\...\optima-hubspot-assessment\.env
Exporting Deals created from 2026-10-11T15:13:55.443Z (inclusive) to 2026-10-18T15:13:55.443Z (exclusive)...
Exported 1 deal(s) from 1 page(s) to D:\...\tools\hubspot-deals-exporter\output\hubspot-deals-2026-10-18.csv
```

### Time window

- The end time `now` is captured **once, in UTC**, at startup and truncated to whole milliseconds. The window is `[now − 7 days, now)`: 168 hours exactly, since UTC has no daylight saving.
- HubSpot filters it server-side as `createdate GTE start` AND `createdate LT end`, with both values as epoch milliseconds. The start is inclusive and the end exclusive, so back-to-back runs never double-count a Deal.
- The filter is on `createdate`, HubSpot's Deal creation timestamp. It never uses the close date or the last-modified date.
- Every page uses the same window. The machine's local time zone (e.g. Asia/Manila) plays no part.
- Results are checked against the window again on the client side, as a safety net.

### CSV format

| Column | Source |
| --- | --- |
| Deal ID | the record's `id` (HubSpot record ID) |
| Deal Name | `dealname` |
| Amount | `amount`, copied exactly as HubSpot returns it. No rounding, locale formatting or currency conversion |
| Currency | `deal_currency_code` (e.g. `PHP`) |
| Pipeline ID | `pipeline` (internal ID) |
| Deal Stage ID | `dealstage` (internal ID) |
| Created At (UTC) | `createdate`, ISO 8601 `yyyy-MM-ddTHH:mm:ss.fffZ` |
| Close Date (UTC) | `closedate`, same format; empty if unset |
| Optima Order ID | `optima_order_id`; empty for Deals not created by this integration |

- **Encoding and layout:** UTF-8 with a byte-order mark (BOM), so Excel opens names such as "Peña" correctly. Comma separators and CRLF line endings follow RFC 4180, and there is always a header row.
- **Quoting:** fields containing a comma, quote, CR or LF are quoted, with embedded quotes doubled. Missing properties become empty cells.
- **Row order:** sorted by creation time, then ID.
- **Formula injection:** text cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading `'`, so spreadsheets display them instead of running them. Plain numeric amounts such as `-50.5` are left untouched.
- **Safe writes:** the file is written to a temporary file and then renamed, so a failed export never leaves a partial CSV. A failed export writes no file at all.

Example, with synthetic values:

```csv
Deal ID,Deal Name,Amount,Currency,Pipeline ID,Deal Stage ID,Created At (UTC),Close Date (UTC),Optima Order ID
1000000001,Order ORD-10482,900,PHP,default,appointmentscheduled,2026-10-15T06:32:00.000Z,2026-09-20T06:32:00.000Z,ORD-10482
1000000002,"Bulk order, ""rush""",12500.50,PHP,default,closedwon,2026-10-16T01:05:12.000Z,,
1000000003,'=HYPERLINK(...),0,USD,default,qualifiedtobuy,2026-10-17T23:59:59.999Z,,
```

### Pagination, errors and retries

- **Pagination:** the exporter calls `POST /crm/v3/objects/deals/search` with 100 results per page, sorted by `createdate` ascending, and follows `paging.next.after` until there is no next page. Deal IDs are deduplicated across pages. A repeated or malformed cursor stops the export instead of looping. Pages are spaced 250 ms apart to stay under HubSpot's search rate limit.
- **10,000-result cap:** HubSpot search can't page past 10,000 results for one query. At that point the exporter restarts the query from the last `createdate` it has seen, keeping the same end time, and removes the overlap by ID.
- **Retries:** HTTP 429, 500, 502, 503, 504, network errors and the 30-second per-request timeout are retried. There are up to 5 attempts in total. The waits follow the same equal-jitter formula as the API: caps of 1, 2, 4 and 8 seconds, at most 30 seconds. `Retry-After` (seconds or HTTP-date) is honored. If it asks for more than 30 seconds, the export fails with a clear message instead of waiting.
- **No retries:** 401, 403 and any other 4xx fail immediately with a specific message. HubSpot response bodies are never shown, because they can echo request data.
- **Invalid responses:** invalid JSON, a missing `results` array, or a Deal without a numeric `id` or valid `createdate` is an error. Missing optional properties are fine.

### Tests

```powershell
cd tools\hubspot-deals-exporter
dotnet test
```

The 101 tests run in about a second and never call HubSpot. They use a scripted `HttpMessageHandler`, a fake `TimeProvider` and an injected delay. They cover:

- **Retrieval:** successful and empty results, multi-page pagination with a fixed window, duplicate IDs across pages, and the 10,000-result restart.
- **Time window:** exact seven-day UTC filter values, start-inclusive/end-exclusive boundaries, independence from the local time zone, and millisecond truncation.
- **Data handling:** missing optional properties, amounts preserved exactly, and CSV escaping of commas, quotes and newlines, checked by parsing the output back.
- **Spreadsheet safety:** formula injection.
- **Errors and retries:**
  - 401/403/400/404 are not retried; 429 and 5xx are retried with backoff.
  - `Retry-After` works in both formats, including the too-long case.
  - Retry exhaustion; timeouts and network errors; caller cancellation.
  - Invalid JSON, missing fields and bad cursors.
- **Files:** output-directory creation, and no partial files after a failure.
- **Configuration and CLI:** configuration precedence and validation; every exit code; confirmation that only the search endpoint is called; and that the token never leaks into output, errors or the CSV.

### Live verification (2026-10-18)

- **Export:** the read-only export against the test portal succeeded: 1 page, 1 Deal (`355622721260`, "Order ORD-WEBHOOK-DEMO-20261018", `900` `PHP`, created `2026-10-18T13:48:19.604Z`).
- **Completeness:** an independent `GET /crm/v3/objects/deals` listing confirmed the account holds exactly that one Deal, so the export is complete.
- **CSV validity:** Python's `csv` module parsed the file as 2 rows of 9 columns, with no duplicate IDs and the timestamp inside the window.
- **Not live-tested:** multi-page pagination. It is covered by the automated tests, but exercising it live would mean creating Deals.

### Exporter limitations

- **Search-index lag:** a Deal created in the last few seconds before a run may not appear in search results yet.
- **IDs, not labels:** pipeline and stage are exported as internal IDs. Converting them to display names would need the pipelines API.
- **Same-day reruns:** the default file is per UTC date, so a rerun on the same day replaces it. Use `--output` to keep both.
- **Fixed window:** it is always 7 days, as the brief requires. There is no option for other ranges.
- **No npm script:** there is no root npm script. This machine's default `dotnet` on PATH is an older SDK, so a wrapper wouldn't work reliably until .NET 10 is installed system-wide.

## Security considerations

- HubSpot and PostgreSQL credentials and `WEBHOOK_SECRET` are loaded only by NestJS and never sent to Next.js or the browser.
- `DASHBOARD_API_KEY` lives only in server-side env files. The browser never sees it, because `lib/backend.ts` imports `server-only` and every privileged call runs in a route handler. A scan of the built `.next/static` assets found none of the configured secret values.
- Every dashboard page and route requires HTTP Basic credentials, enforced by `proxy.ts` with constant-time comparison. Retry POSTs must also carry an `Origin` equal to `DASHBOARD_ORIGIN`, which blocks cross-site request forgery, since browsers attach cached Basic credentials automatically.
- NestJS compares the dashboard API key in constant time, and a missing or wrong key gets 401.
- Error text shown in the dashboard is redacted for configured secrets and `Bearer …` tokens. Logs contain no tokens, signatures, payloads or SQL parameters.
- `.env`, `.env.*` (except `.env.example`), `.next/`, `dist/`, `node_modules/`, test output, the exporter's `bin/`/`obj/` folders and generated `hubspot-deals-*.csv` files (they contain CRM data) are listed in `.gitignore`.
- The C# exporter is read-only, sends the token only in the `Authorization` header with redirects disabled, and never prints the token or HubSpot response bodies.

### Limitations

This setup suits a local take-home assessment, not production:

- There is a single shared username and password, with no user accounts, roles, logout or session expiry. HTTP Basic sends credentials with every request, and the browser caches them until it closes. There is no rate limiting or lockout on failed logins.
- All traffic is plain HTTP on loopback. Production would need HTTPS, a real identity provider, per-user audit of who retried, and a secret manager.
- The API key is a static shared secret with no rotation mechanism.

## Known limitations

- HTTP-level retries run inside the webhook or manual-retry request, so a slow HubSpot outage lengthens those responses. Worst case is about 65s per call: 5 tries × 10s timeout plus about 15s of backoff. If the dashboard's 180s proxy timeout is reached, it reports that the retry may still be running.
- There is a single poller per API process with no leader election. Running several API instances is still safe, because the advisory lock and the under-lock re-check prevent double processing, but each instance polls.
- Pending or processing orders are recovered only after `SYNC_AUTO_RETRY_STALE_AFTER_MS` (5 minutes by default).
- `association_not_verified` (a possible read-after-write lag) is treated as permanent and needs a manual retry.
- There is no alerting when retries are exhausted. It is visible only in the dashboard and in `orders.last_error`.
- The dashboard shows only the latest 50 attempts, with no pagination, and search and filter apply to those rows only. Summary counts also cover only those 50 attempts, except "In progress".
- The page does not refresh automatically; use the Refresh button.
- A manual retry runs synchronously within the request, with a timeout of up to 180 seconds. If the browser connection drops, the retry may still finish on the server; refresh before trying again.
- Contact updates may be repeated on retries. Remote deletions and merges are not repaired.
- The dashboard must be opened at the `DASHBOARD_ORIGIN` host (`localhost`) for retries to be accepted.

## Assessment requirements completed so far

| # | Requirement | Status |
| --- | --- | --- |
| 22 | Webhook receiver with validation and HMAC verification | ✅ |
| 23 | HubSpot Contact search/upsert, Deal creation, association | ✅ live-verified |
| 24 | Idempotency on `order_id` (no duplicate Deals) | ✅ local unique key + HubSpot unique property |
| 25 | 429/5xx retry with backoff; failures logged | ✅ HTTP retries with exponential backoff, jitter and Retry-After; durable order-level retries; every attempt persisted |
| 26 | Persistence of every attempt (order ID, status, IDs, error, timestamp) | ✅ PostgreSQL |
| 27 | Dashboard: last 50 attempts, status, Retry for failed | ✅ |
| 28 | Python/PHP/C# CSV export of the last 7 days of Deals | ✅ C# / .NET 10 exporter, 101 tests, live export verified |
| 29 | README: setup, architecture, assumptions, improvements | ✅ (to be finalized at submission) |
| Bonus | Automated tests | ✅ 110 backend tests + 7 Playwright browser tests + 101 C# exporter tests |

## Assumptions

- The Deal close date is the order's `created_at`, converted to UTC, because the payload has no separate close date. New Deals start in Sales Pipeline → Appointment Scheduled.
- The Deal amount is the order `total`, in the order currency. The HubSpot test account is configured for PHP.
- Signature convention: `sha256=` followed by a hex HMAC over the raw body. The brief does not specify one.

## HubSpot APIs used

| API | Usage |
| --- | --- |
| `POST /oauth/v2/private-apps/get/access-token-info` | Verify scopes |
| `GET /account-info/v3/details` | Portal ID and enabled currencies |
| `GET /crm/v3/pipelines/deals[/<id>]` | Validate pipeline and stage |
| `GET/POST /crm/v3/properties/deals[/<name>]` | Verify the unique property (create only on explicit setup) |
| `POST /crm/v3/objects/contacts/search`, `GET /crm/v3/objects/contacts/<email>?idProperty=email` | Find a Contact |
| `POST /crm/v3/objects/contacts`, `PATCH /crm/v3/objects/contacts/<id>` | Create or update a Contact |
| `GET /crm/v3/objects/deals/<orderId>?idProperty=optima_order_id`, `POST /crm/v3/objects/deals` | Reuse or create a Deal |
| `PUT /crm/v4/objects/deals/<id>/associations/default/contacts/<id>`, `GET /crm/v4/objects/deals/<id>/associations/contacts` | Associate and verify |
