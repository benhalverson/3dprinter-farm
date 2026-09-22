# Read-only shopping agent contract (#192)

Backend handoff for [Lulu #8](https://github.com/benhalverson/luluspeedworks/issues/8).
Live inference is **disabled by default** (`AGENT_ENABLED="false"`). Acceptance uses
mock inference and catalog fixtures in a local Workers runtime. No deployment or
paid inference is part of this change. Real model quality, tool behavior, latency,
usage reporting and cancellation must be evaluated before enabling it.

## Versioned interfaces

- Agents SDK `agents@0.24.0`, using named per-visit SQLite Durable Objects and their
  HTTP request handler. There is no public generic SDK router, WebSocket, state
  writer, callable method, or ledger endpoint.
- AG-UI `@ag-ui/core@1.0.0` and `@ag-ui/encoder@1.0.0`; UTF-8 SSE over POST fetch.
- A2UI wire version `v0.9.1`; catalog
  `https://luluspeedworks.com/catalog/scaffold/v1`, surface `storefront`.
- Workers AI model `@cf/zai-org/glm-5.3-flash`; non-streaming OpenAI-style
  `choices[].message`/`usage` response. Provider output stays server-side until
  fully validated. SSE streams lifecycle/progress, never provider JSON or reasoning.
- `lulu.a2ui.v1`, `lulu.progress.v1`, and `lulu.fallback.v1` are **application
  extensions**, not a standardized binding between AG-UI and A2UI.

## HTTP contract

All responses use `Cache-Control: no-store`. Request bodies are limited to **32 KiB
of UTF-8**, including chunked requests. The storefront's existing CORS allowlist
permits `https://luluspeedworks.com` and local frontend origins. Login is unnecessary.

### Create a visit

`POST /agent/sessions`, empty body, returns `201 application/json`:

```json
{
  "sessionId": "73f4ebed-0967-4112-8484-ed0263749e61",
  "capability": "opaque-random-bearer-capability",
  "expiresAt": 1790037000000,
  "absoluteExpiresAt": 1790049600000
}
```

Times are UTC epoch milliseconds. Visits expire after 30 minutes without an
authenticated request, or four hours after creation. Only a SHA-256 capability
digest is stored. Keep the capability in frontend memory; send it only in the
Authorization header. Query parameters and upgrades are rejected.

Session creation requires `AGENT_NETWORK_SECRET` (at least 32 characters) and the
Cloudflare-provided `CF-Connecting-IP`; missing identity configuration returns
`503 {"error":"identity_unavailable"}`. Production must enter through Cloudflare
so the header is trusted. Local tests explicitly inject an identity. Never use
user-supplied forwarding headers as production identity.

### Start a run

`POST /agent/sessions/:id/runs` with `Authorization: Bearer <capability>`:

```json
{
  "runId": "cbbe9c31-c30d-46e4-acbe-c6a05e50be9c",
  "uiRevision": 12,
  "message": "Show me pit tools",
  "context": [{ "role": "user", "content": "I need to organize small parts" }]
}
```

`runId` is a UUID. `uiRevision` is a nonnegative safe integer. `message` is nonempty
and at most 8,192 UTF-16 code units. `context` defaults to `[]`; at most 20 entries,
each `user` or `assistant` with at most 8,192 code units. No other roles or fields
are accepted. The total byte ceiling still applies. Context is request-scoped and
is never persisted as conversation history.

A new run returns `200 text/event-stream`. Repeating a run ID returns `200
application/json` with its original revision and known status; it never retries
inference or replays a surface:

```json
{ "runId": "cbbe9c31-c30d-46e4-acbe-c6a05e50be9c", "uiRevision": 12, "status": "completed", "reason": null }
```

Statuses: `running`, `completed`, `fallback`. New runs supersede older active runs.
After an object restarts, an unfinished run becomes `fallback/interrupted`; its
ID cannot trigger another paid invocation. Existing reservations remain durable.

Errors before the stream: `400 invalid_request/invalid_session`, `401 unauthorized`,
`410 session_expired`, `413 body_too_large`, or `503 agent_unavailable`.
Transport/infrastructure failure may prevent a body: retain the previous surface
and retry status with the **same run ID**, not an automatic new paid run.

### Cancel

`POST /agent/sessions/:id/runs/:runId/cancel` with the same Authorization header.
Returns known run status as JSON. Cancellation is idempotent. A cancellation that
arrives before its run creates a tombstone (`uiRevision: 0`) so that run cannot
start later. Cancelling a completed run returns its completed status.

Cancelling an active run closes its stream with a cancellation fallback and
suppresses any later composition. A disconnect also stops output. Valid usage
reported late can still settle; aborting does not itself release budget.

## Stream ordering and frontend handling

Each SSE frame is `data: <one AG-UI JSON event>\n\n`:

1. `RUN_STARTED` with `threadId=sessionId`, `runId`, and `metadata.uiRevision`.
2. `CUSTOM lulu.progress.v1` with `{runId, uiRevision, stage:"admission", invocation:0}`.
3. Zero to three inference progress events with `stage:"inference"`, invocation 1–3.
4. Exactly one validated `lulu.a2ui.v1` batch **or** `lulu.fallback.v1`.
5. `RUN_FINISHED`, with run/thread IDs and `result: {uiRevision,status,reason}`.

Disconnected clients cannot receive terminal events; inspect duplicate-run status
if necessary. A successful result omits `reason` in `RUN_FINISHED`.

Example batch envelope (the fixtures contain a complete runnable component graph):

```json
{
  "type": "CUSTOM",
  "name": "lulu.a2ui.v1",
  "value": {
    "runId": "cbbe9c31-c30d-46e4-acbe-c6a05e50be9c",
    "uiRevision": 12,
    "catalogId": "https://luluspeedworks.com/catalog/scaffold/v1",
    "messages": [{ "version": "v0.9.1", "updateComponents": { "surfaceId": "storefront", "components": [] } }],
    "limitations": ["Compatibility is not supplied by this catalog. Verify fit before purchasing."]
  }
}
```

The empty `components` above illustrates envelope fields only; it is not a valid
model composition. [Wire fixtures](shopping-agent-fixtures.json),
[test fixtures](../test/shopping/fixtures.ts) and
[composition tests](../test/shopping/composition.spec.ts) provide full valid
browse/focus arrangements and invalid examples.

Frontend #8 must:

- Increment the UI revision on direct catalog/product/configuration interactions;
  remember the current run ID and starting revision.
- Apply a batch atomically only when both still match. Cancel on navigation or a
  superseding interaction; still check revision because packets can race.
- Initialize the trusted storefront surface before applying updates. The server
  updates `products` and `focus` plus `agent-*` leaf nodes only; it never creates,
  deletes or replaces the shell, configuration, bag or purchase controls.
- Treat agent focus as read-only guidance. Follow its authoritative product link
  to change the actual selected product and deterministic configuration.
- Preserve the last valid surface on all fallbacks or transport failures. Show
  limitations separately if needed; never render raw model content.

Fallback reasons are the exported `fallbackSchema` in `src/shopping/contracts.ts`:
`disabled`, `inference_unavailable`, `accounting_unavailable`, `budget_exhausted`,
`rate_limited`, `invalid_output`, `catalog_unavailable`, `timeout`, `cancelled`,
`superseded`, `disconnected`, `interrupted`, `tool_limit`.

## Catalog and composition boundaries

The only tools are `catalog_list {}`, `catalog_search {query}` (1–128 characters),
and `catalog_detail {id}` (positive safe integer). Queries use Drizzle, explicit
public fields, deterministic ID ordering and a 12-row limit. Visibility matches
current `/products` and `/product/:id`. Print files and provider credentials are
never projected. This branch does not assume unmerged Square catalog semantics.

The model selects catalog product IDs and builds a strict component graph:
one `ProductRail` at `products`, one `ProductFocus` at `focus`, up to 12
`ProductEntry` leaves, and optionally one matching `DetailImage`. Maximum 16
nodes; every leaf ID starts `agent-`. References must resolve with the expected
types, be unique and reachable. Unknown fields, arbitrary bindings, actions,
components, URLs, text, facts and root replacements are rejected.

The server hydrates names, descriptions, USD prices, HTTPS imagery, SKU, product
links and fit text from catalog DTOs. The current database has no structured fit
field, so compatibility is explicitly unknown. Policy answers are also explicit
limitations. There is no free-form generated factual prose. Existing catalog text
is untrusted context, never privileged model instructions.

## Inference and durable budget

At most three invocations, sequential tools, 2,048 completion tokens per call,
32-KiB assembled request, and a 30-second run deadline. History is truncated oldest
first, then catalog results from the end, deterministically. Tool results are
bounded to 4 KiB each. No provider retry, repair call, mutation tool, web browsing,
customer order, payment, cart mutation or alert email exists in this slice.

ShoppingAgent remains a named Durable Object for Agents SDK execution, streaming,
cancellation and invocation schedules. All application records live in the existing
D1 binding `env.DB`: visits, session-scoped runs and pending usage, admissions,
reservations, budget alerts and accounting revisions. Runs and pending usage use
session/record composite primary keys; every session query includes its session ID.
The SDK retains its own internal storage for execution and schedules.

D1 accounting reads the append-only revision before reading accounting data, then
inserts the next unique revision in the same Drizzle batch as admission, reservation,
settlement and threshold-alert mutations. A conflicting revision rolls back the
whole batch and retries the decision up to five times. Other D1 failures and exhausted
retries fail closed without invoking inference. Queries use D1's primary database.
Short session request setup is serialized across asynchronous D1 operations;
inference and streaming run outside that queue. Persisted run identities and
cancellation tombstones prevent repeated inference, including after restart.

Version `glm-5.3-flash-2026-09-21` records 150 nanodollars/input token and 500
nanodollars/output token. Admission reserves the documented 1,310,720-token context
plus 2,048 output tokens: **197,632,000 nanodollars ($0.197632) per invocation**.
The monthly cap is 20,000,000,000 nanodollars. This intentionally conservative
reservation avoids tokenizer assumptions and charges uncached input rates.

Settled cost + outstanding reservations + new reservation must not exceed the cap.
Repeated reservation identities cannot authorize another provider call. Records
persist identity, session/run/invocation, month, model, price version/rates, maximum,
reported usage and settlement status. Valid usage settles once and releases excess.
Missing/invalid usage and uncertain provider failures retain the maximum reservation.
Session expiry never releases it. Late settlement applies to the originating month.
Usage reconciliation and budget email retries are described below; retention policy remains separate.

The same accounting module atomically admits six starts per rolling minute and 60 per rolling
day for the visit's HMAC network identity. A new session cannot reset that allowance.
Raw IPs and capabilities are not stored or logged. Structured logs include only
run correlation, latency, invocation count, usage and fallback/validation reason.
Agent routes bypass the general request logger to avoid logging accidental URL
capabilities or user input. Keep the network HMAC secret stable across deployments.

Unknown pricing, missing accounting, or accounting errors stop inference while
ordinary commerce endpoints remain available. Leave `AGENT_ENABLED=false` until
the separate live evaluation/release gate is satisfied. Configure the HMAC secret
through the existing secret provisioning process, never source control.

## Verification and maintenance

```sh
pnpm test:ci
pnpm exec tsc --noEmit
pnpm test:project-notes
pnpm cf-typegen
pnpm exec wrangler deploy --dry-run
```

Shopping schemas are exported from `src/db/schema.ts`. Run `pnpm run db:generate`
and commit the generated D1 migration, snapshot and journal. Apply migrations using
Drizzle tooling (`pnpm run db:migrate:local` for a local SQLite database).
There is no application DO migration config, bundle, startup migrator or SQL
bundling rule. Historical Wrangler class migrations remain unchanged; the ledger
class, export and binding are removed without a destructive deletion migration.
This change does not deploy, reset running databases or transfer existing DO data.

Snapshot `0010_snapshot.json` fills the pre-existing metadata gap after snapshot
`0006`: migrations 0007–0010 were already present in the journal and SQL history.
The repaired snapshot prevents regeneration of those existing commerce changes.

Fresh local D1 migration currently stops with `duplicate column name: user_id`:
existing migrations 0002 and 0004 both add `cart.user_id` (0003 and 0004 also
overlap on `filament_id`). That history needs a separate repair. Historical SQL
is unchanged; migration 0014 defines the shopping schema changes.

Route tests import the Hono application separately from the production Worker
entrypoint and exercise the session handler with typed storage mocks. They cover
authentication, duplicate runs, cancellation races, storage failures, restart
interruption and usage reconciliation without repeated inference.

`pnpm test:ci` runs the existing Workers test suite. Storage, SDK scheduling and
email delivery use controlled test boundaries; no remote AI or email calls are
made. The production Worker dry run verifies bundling separately.

## Budget alerts and reconciliation

Budget alerts use Cloudflare Email Service through the `BUDGET_EMAIL` Workers
binding. Configure `AGENT_BUDGET_FROM` with an address on a domain onboarded to
Cloudflare Email Sending and `AGENT_BUDGET_TO` with the owner's recipient address.
There is no default address. Missing configuration leaves alerts pending for retry.
Restrict the binding's allowed sender/recipient addresses once those addresses are
selected. Local tests use a fake binding and never send email.

D1 accounting creates one durable logical alert for each UTC month and
50%/75%/100% threshold. Its amount includes settled usage plus conservative
reservations. The 100% alert also fires when the remaining amount cannot admit one
maximum-size invocation, even if the numeric total is slightly below $20. Each
reservation transaction can insert every crossed threshold. Settlement never
deletes alerts or creates a new monthly budget bucket for old usage.

A Worker cron runs every minute and conditionally claims pending D1 alerts using
their attempt count and retry timestamp. It sends outside the database update and
acknowledges acceptance only while holding the matching lease. Retries back off from one minute to one hour.
The sender and recipient are retained on the first configured attempt, so a
configuration change cannot redirect retries. Cloudflare's returned message ID
records acceptance, not inbox delivery. One database row represents each logical
alert. The binding has no documented idempotency key: a lost acknowledgement or a
crash after provider acceptance can cause a duplicate physical email on retry.
`X-Lulu-Budget-Alert` and the text reference identify that same logical alert;
they are correlation metadata, not provider deduplication guarantees.

Validated token counts and the reservation ID are first persisted as an Agents SDK
interval payload, then saved in the session-scoped D1 outbox before attempting
settlement. Each invocation has its own idempotent minute schedule, so a crash
between scheduling and the outbox write still retains the usage. The task retries
D1 accounting outages without re-running inference. Repeated settlement is idempotent and uses
the reservation's original month. Missing or invalid token counts retain the full
reservation; they are never guessed or reclaimed just because time passed. Each
task is cancelled only after its settlement succeeds, independently of other late
results or visit expiry. Tests inject storage, scheduler and email boundaries.

Email failures do not change spending or admission. Cost, retry and fallback
telemetry omit email addresses, credentials, prompts and order details. The $20
admission cap applies only to this accounting module's model calls and conservative prices;
it is not a provider billing guarantee. Production sender onboarding, configured
recipient and actual delivery remain operational acceptance requirements.

## Primary references

- [Agents request handler](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Model parameters, context and prices](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/)
- [AG-UI events and custom events](https://docs.ag-ui.com/concepts/events)
- [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Drizzle batch API](https://orm.drizzle.team/docs/batch-api)
- [Named Durable Object runtime support](https://developers.cloudflare.com/changelog/post/2026-03-15-durable-object-id-name/)
- [Cloudflare email sending binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Agents SDK persisted schedules](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)
