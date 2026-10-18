# n8n Bonus — Order Webhook to HubSpot

This folder rebuilds the core integration as **n8n workflows**, as the assessment's bonus asks:

1. Receive the signed `order.created` webhook.
2. Find the HubSpot Contact by email, then update it or create it.
3. Create the Deal, or reuse it if one exists.
4. Associate the Deal with the Contact.
5. Send a notification through an Error Trigger workflow when anything fails.

It is an **independent demonstration**. The NestJS service in `apps/api` remains the production path, and nothing here changes it. Both use the same signing convention, HubSpot endpoints, property mapping and the unique `optima_order_id` Deal property.

| File | Purpose |
| --- | --- |
| `optima-order-hubspot-workflow.json` | Main workflow, "Optima Order to HubSpot" (22 nodes) |
| `optima-error-notification-workflow.json` | Error workflow, "Optima Error Notification" (5 nodes) |
| `start-n8n.ps1` | Starts a local n8n with the required settings (reads the root `.env` without printing values) |
| `test/mock-hubspot.mjs` | Local HubSpot stand-in with unique constraints and fault injection; test use only |
| `test/run-tests.mjs` | End-to-end scenarios against a running n8n and the mock |
| `test/send-order.mjs` | Sends one signed order to the workflow |

**Tested with:** n8n **2.43.7** (stable, Oct 2026) on Node.js 24.22.0, Windows 11. n8n 2.x requires Node.js ≥ 24.

## How the main workflow works

```text
Order Webhook (POST /webhook/optima-order, Raw Body on, respond via node)
  → Verify Signature & Validate (Code: HMAC over raw bytes, timingSafeEqual, payload rules)
  → Valid Request? ──no──→ Reject Request (401 bad signature / 400 invalid payload)
        │yes
  → Search Contact (POST /crm/v3/objects/contacts/search, email EQ)
  → Contact Exists? ──yes→ Update Contact (PATCH /crm/v3/objects/contacts/{id}) ─────────────┐
        │no                                                                                │
  → Create Contact (POST /crm/v3/objects/contacts) ──ok────────────────────────────────────┤
        │error (e.g. 409, or create succeeded but the response was lost)                    │
  → Find Contact After Conflict (GET /crm/v3/objects/contacts/{email}?idProperty=email) ─────┤
                                                                                Contact Ready
  → Search Deal (POST /crm/v3/objects/deals/search, optima_order_id EQ)
  → Deal Exists? ──yes→ Existing Deal (dealReused = true) ──────────────────────────────────┐
        │no                                                                                │
  → Create Deal (POST /crm/v3/objects/deals) ──ok──→ New Deal (dealReused = false) ──────────┤
        │error (unique optima_order_id already taken, or ambiguous 5xx)                     │
  → Find Deal After Conflict (GET /crm/v3/objects/deals/{orderId}?idProperty=optima_order_id)│
  → Recovered Deal (dealReused = true) ─────────────────────────────────────────────────────┤
                                                                                   Deal Ready
  → Associate Deal with Contact (PUT /crm/v4/objects/deals/{id}/associations/default/contacts/{id})
  → Read Deal Associations (GET /crm/v4/objects/deals/{id}/associations/contacts)
  → Confirm Association (Code: throws if the Contact is not linked)
  → Respond Synced (200)
```

A successful response looks like this:

```json
{"order_id":"ORD-10482","result":"synced","contactId":"572136771318","dealId":"355634565843","dealReused":false}
```

Rejections return `{"error":"Invalid or missing signature"}` (401) or `{"error":"Invalid payload: …"}` (400). Neither ever includes credentials.

If a HubSpot step fails after its retries, n8n ends the run with a generic 5xx response, and the **error workflow** sends the alert.

### Mapping (identical to the NestJS service)

| Order field | HubSpot |
| --- | --- |
| `customer.email` (lower-cased) | Contact `email` (lookup key) |
| `customer.first_name`, `last_name`, `phone` (if present) | Contact `firstname`, `lastname`, `phone` |
| `"Order " + order_id` | Deal `dealname` |
| `total` | Deal `amount` (string, unchanged) |
| `currency` | Deal `deal_currency_code` |
| `created_at` converted to UTC ISO | Deal `closedate` |
| `HUBSPOT_PIPELINE_ID` / `HUBSPOT_DEAL_STAGE_ID` (defaults `default` / `appointmentscheduled`) | Deal `pipeline` / `dealstage` |
| `order_id` | Deal `optima_order_id` (unique property) |

### HMAC verification

- **Header:** `X-Webhook-Signature: sha256=<64 lowercase hex>`, the same convention as the NestJS receiver.
- **Raw bytes:** the Webhook node has **Raw Body** enabled. In n8n 2.43.7, n8n's body parser reads the request stream with `raw-body` before any JSON parsing, and the node passes those exact bytes on as binary data. I confirmed this in the n8n source and by testing.
- **Comparison:** the Code node computes HMAC-SHA256 over that buffer and compares it with `crypto.timingSafeEqual`. Only after the signature matches does it parse **the same bytes** and validate them.
- **Proof it uses the original bytes:** a request whose signature was computed over differently formatted JSON is rejected.
- **The secret:** comes from the environment variable `OPTIMA_WEBHOOK_SECRET`. It never appears in the workflow. `start-n8n.ps1` fills it from `WEBHOOK_SECRET` in the root `.env`, so `npm run webhook:send`-style signing works against both receivers.
- **Required n8n settings** (set by `start-n8n.ps1`): `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.

### Idempotency and concurrency

- **Same order twice:** `Search Deal` finds the existing Deal, which is reused (`dealReused: true`).
- **Race conditions and search lag:** HubSpot search can lag a few seconds behind writes, and two deliveries can race. In both cases the second `Create Deal` is **rejected by HubSpot**, because `optima_order_id` is a unique property. The node's error output then leads to `Find Deal After Conflict`, a direct lookup by `idProperty` that doesn't depend on the search index, and the existing Deal is reused.
- **Contacts:** handled the same way through HubSpot's unique email, using a 409 and then a direct lookup by email.
- **Ambiguous failures:** a create that succeeded but returned 5xx is retried. The retry is rejected as a duplicate and then reconciled the same way, so it never produces a second Deal.
- **Association:** uses the idempotent `PUT … /associations/default/…`, so repeating it never creates a second association.

What n8n does **not** provide, compared with the NestJS service:
- no PostgreSQL row lock, and no `orders` or `sync_attempts` audit tables;
- no durable retry schedule.

Correctness rests on HubSpot's uniqueness constraints, and this is **not** exactly-once processing. Concurrent deliveries for the same email can each update the Contact, and the last write wins.

### Retries

- **Settings:** every HubSpot node has **Retry On Fail**, with 4 tries and 2 seconds between them.
- **Fixed interval:** n8n's built-in retry waits the same time between tries. It doesn't do exponential backoff with jitter, and it ignores `Retry-After`.
- **Retries everything:** it repeats any error, including permanent 4xx errors, before giving up.
- **Comparison:** the NestJS service implements proper exponential backoff, `Retry-After` handling and durable order-level retries (see the root README). This workflow covers short HubSpot hiccups (429/5xx). Longer outages end in the error workflow.

## Error notification workflow

```text
Error Trigger → Build Safe Summary (Code) → Alert Destination Set? ──yes→ Send Alert (POST $env.OPTIMA_ALERT_WEBHOOK_URL)
                                                        └──no──→ Alert Not Configured (Stop and Error)
```

The alert is a JSON POST to any incoming-webhook URL, such as Slack, Microsoft Teams, Discord, webhook.site or your own endpoint. Here is a real example captured during testing:

```json
{
  "source": "optima-n8n", "severity": "error",
  "workflowName": "Optima Order to HubSpot", "workflowId": "OptimaOrderSync1",
  "executionId": "47", "executionUrl": "http://localhost:5678/workflow/OptimaOrderSync1/executions/47",
  "mode": "webhook", "failedNode": "Search Contact", "httpCode": "401",
  "errorSummary": "Authorization failed - please check your credentials",
  "timestamp": "2026-10-18T16:47:27.943Z"
}
```

**What the summary removes:** bearer tokens, HubSpot `pat-…` tokens, email addresses and long hex strings such as signatures. It also never includes the request body. It is truncated to 300 characters.

**Destination:** `OPTIMA_ALERT_WEBHOOK_URL`, passed with `start-n8n.ps1 -AlertWebhookUrl …`. No URL or address is hard-coded. For email instead, replace **Send Alert** with n8n's **Send Email** node and an SMTP credential.

The main workflow's **Settings → Error workflow** points at this workflow. Its JSON ID is `OptimaErrNotify1`.

> **n8n 2.x:** the error workflow must be **published**. Otherwise n8n logs "Workflow … is not active and cannot be executed" and no alert is sent. I confirmed this in the n8n source and in testing.

## Local setup (Windows 11, PowerShell)

1. **Install Node.js 24 and n8n** in their own folder, outside the repository:
   ```powershell
   fnm install 24                    # or install Node.js 24 LTS from nodejs.org
   New-Item -ItemType Directory -Force $env:USERPROFILE\n8n-local | Out-Null
   Set-Location $env:USERPROFILE\n8n-local
   npm.cmd init -y | Out-Null
   fnm exec --using=24 npm.cmd install n8n@2.43.7    # takes several minutes; omit "fnm exec --using=24" if node -v is 24+
   ```
   Data, including the SQLite database and n8n's encryption key, lives in `%USERPROFILE%\n8n-local\.n8n`. To uninstall, delete that folder.

2. **Start n8n** from the repository root:
   ```powershell
   .\n8n\start-n8n.ps1                                                 # real HubSpot, no alert destination
   .\n8n\start-n8n.ps1 -AlertWebhookUrl 'https://<your incoming webhook>'  # real HubSpot + alerts
   .\n8n\start-n8n.ps1 -MockHubSpot                                    # local mock HubSpot + alerts captured by the mock
   ```
   The editor is at **http://localhost:5678**. The port can be changed with `-Port`. Port 5679 is n8n's internal task broker, so the mock uses **5680**. On first visit, n8n asks you to create the local owner account.

3. **Import the workflows.** Import the error workflow first.
   - **Editor:** *Create workflow* → **⋯** → **Import from File…**, choose `optima-error-notification-workflow.json`, then save and **Publish**. Repeat for `optima-order-hubspot-workflow.json`. The editor may assign new IDs, so open the main workflow → **Settings** → **Error workflow** and select *Optima Error Notification*.
   - **CLI** (keeps the IDs, so the error link works without changes). Stop n8n first:
     ```powershell
     $env:N8N_USER_FOLDER = "$env:USERPROFILE\n8n-local"; $n8n = "$env:USERPROFILE\n8n-local\node_modules\.bin\n8n.cmd"
     fnm exec --using=24 $n8n import:workflow --input=n8n\optima-error-notification-workflow.json
     fnm exec --using=24 $n8n import:workflow --input=n8n\optima-order-hubspot-workflow.json
     fnm exec --using=24 $n8n publish:workflow --id=OptimaErrNotify1
     fnm exec --using=24 $n8n publish:workflow --id=OptimaOrderSync1
     ```

4. **Create the HubSpot credential.**
   1. Go to **Credentials** → **Create** → **HubSpot Service Key**.
   2. Paste your private-app access token, the same one as `HUBSPOT_ACCESS_TOKEN`.
   3. Name it **HubSpot Service Key (Optima)**.
   4. Open the main workflow. If any HubSpot node shows a credential warning, select this credential in it. There are 9 HTTP Request nodes; all of them use the same credential.

   **Required scopes:** `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`. The Deal property `optima_order_id` must exist with unique values; the NestJS setup already created it. In production, set the credential's **Allowed domains** to `api.hubapi.com`.

5. **Publish the main workflow.** n8n 2.x uses a *Publish* button instead of the 1.x "Active" toggle. Then:
   - **Production URL:** `http://localhost:5678/webhook/optima-order`
   - **Test URL:** `http://localhost:5678/webhook-test/optima-order`, which works only while the editor is listening after you click *Execute workflow*.

6. **Send a test order.** Use synthetic emails, never `maria.santos@example.com`, which belongs to the demo record:
   ```powershell
   node n8n/test/send-order.mjs ORD-N8N-0001 n8n-demo-0001@example.com
   node n8n/test/send-order.mjs ORD-N8N-0001 n8n-demo-0001@example.com   # duplicate: same dealId, dealReused true
   ```
   For a test-URL run, add the URL as the third argument.

7. **View execution logs** in the editor, under **Overview → Executions** or the workflow's **Executions** tab. Each run shows per-node input and output and the retry attempts. Failed runs link from the alert's `executionUrl`.

## Testing

### Automated scenarios (mock HubSpot, no live writes)

```powershell
node n8n/test/mock-hubspot.mjs                  # terminal 1: mock on http://127.0.0.1:5680
.\n8n\start-n8n.ps1 -MockHubSpot                # terminal 2: workflows imported + both published (step 3)
node n8n/test/run-tests.mjs                     # terminal 3
```

In mock mode the credential's token can be any placeholder. The runner signs with `OPTIMA_WEBHOOK_SECRET`, or with `WEBHOOK_SECRET` from the root `.env`, which is the same value `start-n8n.ps1` gives n8n.

### Results (2026-10-18, n8n 2.43.7)

| # | Scenario | How | Result |
| --- | --- | --- | --- |
| 1 | Valid signed webhook | mock | ✅ 200 `synced`, exact Deal properties |
| 2 | Invalid / missing / malformed signature, and a signature over different bytes | mock | ✅ 401, zero HubSpot calls |
| 3 | Missing required fields | mock | ✅ 400 for invalid fields; malformed JSON is answered **422 by n8n's body parser** before the workflow runs |
| 4 | New Contact creation | mock + live | ✅ |
| 5 | Existing Contact update (PATCH, no second Contact) | mock | ✅ |
| 6 | New Deal creation | mock + live | ✅ |
| 7 | Existing Deal reuse on redelivery | mock + live | ✅ same `dealId`, `dealReused: true` |
| 8 | 5 simultaneous deliveries | mock | ✅ 1 Contact, 1 Deal, 1 association |
| 9 | Association created and read back | mock + live | ✅ |
| 10 | HubSpot 429 (twice) then success | mock | ✅ retried, 3 searches |
| 11 | 503/500 on reads; **502 after the Deal was created**; 409 on Contact create | mock | ✅ retried; ambiguous create reconciled with no duplicate |
| 12 | HubSpot 401 (bad token) | mock | ✅ run fails after 4 tries |
| 13 | Error workflow execution | mock | ✅ Error Trigger ran (once published) |
| 14 | Notification delivery and content | mock capture endpoint | ✅ one alert; no email, token or secret in it |
| 15 | Export and re-import | n8n CLI | ✅ exported nodes, connections and settings identical to these files; both re-imported into a fresh empty n8n |

**Live check against the real HubSpot test portal:** one synthetic order (`N8N-LIVE-20261018165026`, `n8n-bonus-test-…@example.com`) was sent twice.
- Both calls returned 200 with the same Deal `355634565843`; the second had `dealReused: true`.
- HubSpot shows exactly one Deal with that `optima_order_id`, with the correct properties, associated with Contact `572136771318`.
- The demo Contact and Deal were not modified.

**Not run live:** the 429, 5xx and 401 cases and alert delivery to a real Slack/Teams/email destination. Those were exercised against the mock and its capture endpoint. To check a real destination, start with `-AlertWebhookUrl <url>` and send an order while the HubSpot credential holds an invalid token.

## Security considerations

- **No secrets in the JSON files:** I scanned them for the configured values. The HubSpot token lives in an n8n credential, encrypted in n8n's database. The webhook secret and alert URL come from environment variables.
- **Environment access:** `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` lets *any* workflow on this instance read environment variables. That's acceptable for a dedicated local instance. In production, use n8n external secrets or a dedicated instance.
- **Webhook security:** signature checks happen before any HubSpot call. Responses never echo payloads or HubSpot errors, and `NODE_ENV=production` keeps n8n from returning stack traces.
- **Personal data:** n8n stores execution data, including the customer payload, in its database by default. In production, set **Settings → Save successful executions** to *Do not save* or configure pruning.
- **Test hook:** `OPTIMA_HUBSPOT_BASE_URL` exists only to point the workflow at the mock. Leave it unset in real use, and restrict the credential to `api.hubapi.com`.
- **Network:** `start-n8n.ps1` binds n8n to `127.0.0.1`. Exposing it publicly would need HTTPS, a reverse proxy, and n8n user management.

## Known limitations

- **Retry behaviour:** fixed-interval retries that ignore Retry-After and also retry 4xx errors. There is no durable retry queue or audit history; use the NestJS service for those.
- **Concurrency:** depends on HubSpot's unique `optima_order_id` and email constraints rather than a lock.
- **Failure response:** a failed run returns n8n's generic 5xx to the sender, and the details go to the error workflow.
- **Malformed JSON:** rejected by n8n itself (422) before the HMAC check. Nothing is processed.
- **Compressed bodies:** n8n decompresses gzip/deflate bodies before capturing the raw bytes, so the signature applies to the decompressed body. The NestJS receiver rejects compressed bodies instead.
- **Association check:** it reads the first 500 Contact associations of the Deal, far more than a single-order Deal has.
- **Deprecation warning:** n8n 2.x logs that running outside its Docker image is deprecated. The npm install still works, and Docker Compose is a separate bonus.
