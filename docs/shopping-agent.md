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

The private `ShoppingLedger` instance named `deployment-account` coordinates this
deployment's UTC monthly buckets. All reads/writes use Drizzle; admission and
settlement use synchronous SQLite storage transactions with no external I/O.
The shopping schemas in `src/shopping/storage` are exported by `src/db/schema.ts`.
Drizzle generates their migrations into the existing `drizzle/migrations` history.
The TypeScript loader in `src/shopping/storage/migrations.ts` selects only the
shopping migrations from that history for Drizzle's Durable Object migrator.
Each Durable Object applies that shared shopping schema to its private database;
session and budget records remain isolated by object. The standard D1 migration
path also creates these tables, but the agent does not store shopping state in D1.

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
Reconciliation, record retention policy and email alerts remain #193.

The same ledger atomically admits six starts per rolling minute and 60 per rolling
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

For any schema change, use only `pnpm run db:generate` and
`pnpm run db:migrate:local`. Keep shopping schema changes in their own generated
migration, then add that import to `src/shopping/storage/migrations.ts` so each
Durable Object applies it on startup. There are no separate shopping migration
configs, directories under `drizzle`, or JavaScript loaders. Do not handwrite
storage queries or SQL migrations. The normal `cf-typegen` command remains
`wrangler types`.

Snapshot `0010_snapshot.json` fills the pre-existing metadata gap after snapshot
`0006`: migrations 0007–0010 were already present in the journal and SQL history.
The repaired snapshot prevents regeneration of those existing commerce changes.

Fresh local D1 migration currently stops before the shopping migration with
`duplicate column name: user_id`: existing migrations 0002 and 0004 both add
`cart.user_id` (0003 and 0004 also overlap on `filament_id`). This pre-existing
history needs a separate repair. Historical SQL was not changed.

Route tests import the Hono application separately from the production Worker
entrypoint. Mocked Agent lookup forwards requests to the real session handler,
with typed in-memory storage, catalog fixtures and mocked inference. Budget tests
exercise the real budget rules against storage mocks. Migration imports and
Drizzle initialization remain directly in the production Durable Objects, and budget
operations retain synchronous SQLite transactions.

Tests load no migration files and configure no shopping Durable Objects or remote
AI bindings. The Vitest pool uses its matching Miniflare dependency and default
storage isolation. These tests verify application behavior; they do not verify
SQLite atomicity, durable restart recovery, migration execution, or real model
quality and latency. The production Worker dry run checks bundling separately.

## Primary references

- [Agents request handler](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Model parameters, context and prices](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/)
- [AG-UI events and custom events](https://docs.ag-ui.com/concepts/events)
- [SQLite Durable Object transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Drizzle Durable Object support](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do)
- [Named Durable Object runtime support](https://developers.cloudflare.com/changelog/post/2026-03-15-durable-object-id-name/)
