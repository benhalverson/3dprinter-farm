# Read-only shopping agent contract (#192)

Backend handoff for [Lulu #8](https://github.com/benhalverson/luluspeedworks/issues/8).
Live inference is **disabled by default** (`AGENT_ENABLED="false"`). Acceptance uses
mock inference, persistence and catalog fixtures. No deployment or
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
- `lulu.a2ui`, `lulu.progress`, and `lulu.fallback` are **application
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

Every run uses the public-catalog binding contract below. There is no contract
negotiation field or alternate literal batch. Current cart/selection request
fields and commerce tools remain supported; see [cart](shopping-cart-agent.md) and
[checkout](shopping-checkout-agent.md) contracts.

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
2. `CUSTOM lulu.progress` with `{runId, uiRevision, stage:"admission", invocation:0}`.
3. Zero to three inference progress events with `stage:"inference"`, invocation 1–3.
4. Exactly one validated `lulu.a2ui` batch
   **or** `lulu.fallback`.
5. `RUN_FINISHED`, with run/thread IDs and `result: {uiRevision,status,reason}`.

Disconnected clients cannot receive terminal events; inspect duplicate-run status
if necessary. A successful result omits `reason` in `RUN_FINISHED`.

Example batch envelope (the fixtures contain a complete runnable component graph):

```json
{
  "type": "CUSTOM",
  "name": "lulu.a2ui",
  "value": {
    "runId": "cbbe9c31-c30d-46e4-acbe-c6a05e50be9c",
    "uiRevision": 12,
    "catalogId": "https://luluspeedworks.com/catalog/scaffold/v1",
    "messages": [
      { "version": "v0.9.1", "updateDataModel": { "surfaceId": "storefront", "path": "/agentCatalog", "value": { "products": {} } } },
      { "version": "v0.9.1", "updateComponents": { "surfaceId": "storefront", "components": [] } }
    ],
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
- Treat agent focus as read-only guidance. Its server-bound `href` is the
  authoritative product link (empty when no product is focused). Follow it
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

The model selects public catalog record paths and builds a strict component graph:
one `ProductRail` at `products`, one `ProductFocus` at `focus`, up to 12
`ProductEntry` leaves, and optionally one matching `DetailImage`. Maximum 16
nodes; every leaf ID starts `agent-`. References must resolve with the expected
types, be unique and reachable. Unknown fields, arbitrary bindings, actions,
components, URLs, text, facts and root replacements are rejected.

The server binds names, descriptions, USD prices, HTTPS imagery, SKU, product
links and fit text from catalog DTOs. The current database has no structured fit
field, so compatibility is explicitly unknown. Policy answers are also explicit
limitations. There is no free-form generated factual prose. Existing catalog text
is untrusted context, never privileged model instructions.

### Public catalog bindings (`lulu.a2ui`)

Persist the original request body for uncertain-run recovery; never change its
identity on retry. Duplicate-run status remains metadata only.

The model selects and orders the approved components using a record binding:

```json
{
  "id": "agent-mount",
  "component": "ProductEntry",
  "product": { "path": "/agentCatalog/products/42" }
}
```

`ProductFocus.product` may be `null` for ambiguity or absent matches. Otherwise
the focus and its optional `DetailImage` must select the same public product.
Only canonical positive safe-integer IDs present in the server's catalog results
are allowed. Relative paths, field paths, encoded paths, other namespaces,
model-supplied facts, extra fields, and actions are rejected. No model output can
read private state, change configuration, or redefine payment controls.

The compiler supplies one complete `CUSTOM lulu.a2ui` value with the same
`runId`, `uiRevision`, `catalogId`, and `limitations` envelope. Its `messages`
contains exactly these two A2UI `v0.9.1` messages, in order:

1. `updateDataModel: { surfaceId: "storefront", path: "/agentCatalog", value: { products } }`.
   This replaces the namespace with only the referenced public records keyed by
   their numeric ID strings. Each record has exactly `id`, `name`, `description`,
   `image`, formatted USD `price`, `sku`, local `href`, and `compatibility`.
2. `updateComponents: { surfaceId: "storefront", components }` with the validated
   graph. Each bound value is exactly `{ path: "/agentCatalog/products/<id>/<field>" }`.

The field allowlist is fixed by the compiler:

| Component | Component field → public record field |
| --- | --- |
| ProductEntry | name → name; description → description; image → image; price → price; href → href |
| ProductFocus | selectedTitle → name; selectedDescription → description; price → price; sku → sku; href → href; compatibility → compatibility |
| DetailImage | src → image; name → name |

All bound fields on one component must use the same record. The remaining fields
retain the trusted literals and actions; the client still restores direct
category controls. Public records are derived only from validated catalog DTOs,
never copied from model values or unprojected database rows. Missing fit remains
explicitly unknown. Image URLs are HTTPS or empty. A record name is at most 512
characters, description 4,096, image 2,048, price 128, and SKU/compatibility 8,192.
The graph permits at most 16 nodes, 12 rail entries, one focus and one image;
there can be at most 13 distinct product records. The compiled batch is at most
32 KiB of UTF-8 before the run/revision envelope. Invalid or oversized output
emits only the normal fallback;
no partial data or component update is streamed.

The client must validate both messages, every record, exact field paths, matching
record IDs/product links, graph reachability and focus/image consistency before
calling the renderer. Do not render the data message as it arrives: wait for the
matching successful terminal event and clean stream EOF, recheck the active
run/revision, then apply both messages together. A failed validation or stale run
preserves the entire prior surface. The shapes above match the installed
`@a2ui/web_core@0.11.0` v0.9 schema's `UpdateDataModelMessageSchema` and
`DynamicStringSchema`; the namespace and path allowlist are Lulu restrictions.

`test/shopping/composition-bindings.spec.ts` and transport tests exercise synthetic
tool holders, pit stands, 1/10 mounts, MBX8 mounts and B6.4/B7 shrouds, plus ambiguous
and unsupported-fit arrangements, hostile paths, private-field exclusion,
cancellation and fallback. These verify controlled contracts and authoritative
hydration, not model selection quality or production catalog/fit claims. The
Lulu consumer and API use this single contract and must be released together.
Live model evaluation and deployment remain separate gates.

## Inference and durable budget

At most three invocations, sequential tools, low reasoning effort, 2,048 completion tokens per call,
32-KiB assembled request, and a 30-second run deadline. History is truncated oldest
first, then catalog results from the end, deterministically. Tool results are
bounded to 4 KiB each. No provider retry, repair call, mutation tool, web browsing,
customer order, payment or cart mutation exists in this slice. Budget alert
delivery runs separately from inference through the ledger's durable outbox.

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
Reconciliation preserves the first valid usage report and its original price and
month. Reservations and alert rows are retained across month boundaries; no
automatic deletion of these records is implemented.

The ledger atomically queues one logical alert per UTC month at 50%, 75% and 100%
of the USD 20 allowance ($10/$15/$20). The 100% alert also records exhausted
admission capacity when the next full reservation cannot fit, even if accounted
usage is below $20. A single update can enqueue all crossed thresholds. Later
usage reconciliation never erases a threshold crossing or its delivery state.
These admission controls are not a provider billing guarantee.

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

## Budget email configuration and recovery (#193)

The accounting and outbox implementation is merged. [Issue #193](https://github.com/benhalverson/3dprinter-farm/issues/193)
remains open for verified sender/owner configuration and actual delivery evidence.
Passing local tests or a Worker build does not establish either.

| Setting | Required value |
| --- | --- |
| `BUDGET_EMAIL` | Cloudflare `send_email` binding on the Worker hosting `SHOPPING_LEDGER`. |
| `AGENT_BUDGET_FROM` | Sender email address on a domain onboarded to Cloudflare Email Service. |
| `AGENT_BUDGET_TO` | Explicitly authorized owner email address, verified in the Cloudflare account and permitted by the binding. |

There are no default addresses. The application validates address syntax; it
cannot verify domain onboarding, destination verification or mailbox ownership.
Provision both address values for the selected Worker through the normal secure
configuration process. `.dev.vars` supplies local values only. The checked-in
Wrangler file declares only the top-level Worker, with no named nonproduction
environment; do not assume a staging environment exists.

Match the binding's `allowed_sender_addresses` and
`allowed_destination_addresses` to those approved addresses. Restrictions do not
onboard the sender domain or verify the recipient. Named Wrangler environments
must declare their own `send_email` bindings and configuration; bindings are not
inherited. Regenerate binding types with `pnpm cf-typegen` after configuration
changes. See Cloudflare's [send binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
and [Wrangler environment rules](https://developers.cloudflare.com/workers/wrangler/environments/).

`remote = false` on `BUDGET_EMAIL` keeps `wrangler dev` delivery simulated. It is
not a deployed email kill switch. Setting it to `true` sends real email during
local development. `AGENT_ENABLED=false` prevents new inference but does not stop
alarms from delivering already queued alerts. See [local email behavior](https://developers.cloudflare.com/email-service/local-development/sending/).

Alerts pin both addresses at the first attempt with syntactically valid
configuration, even if the binding is missing or the send fails. Changing
environment values later does not retarget a pinned alert. If addresses were
missing or invalid, the row remains unpinned and can adopt valid configuration on
a later attempt. Confirm the intended addresses before allowing pending alerts
to run; fixing a mistakenly pinned address needs a separately reviewed data
correction through Drizzle, not an outbox reset.

Each attempt persists a lease and its next retry time before sending. Retry
delays are 1, 2, 4, 8, 16 and 32 minutes, then one hour, without an attempt limit.
A send times out after 15 seconds; an alarm drains at most ten due alerts and
schedules the next pending attempt. Missing configuration, provider rejection,
timeout or failure to persist acknowledgement retains the logical alert and
spend. Recovery re-arms pending alerts when the ledger activates.

The `shopping_budget_alert` log event exposes only month, threshold, status
(`retry` or `accepted`) and latency. Provider errors and addresses are omitted.
For repeated retries, check sender onboarding, recipient verification, binding
restrictions and Cloudflare delivery logs through authorized account access.
Restore valid configuration and let the existing alarm retry. Do not delete
reservations, recreate the ledger or clear alerts to retry delivery.

A nonempty provider `messageId` plus successful local acknowledgement ends
application retries. This records provider acceptance, not owner receipt; later
bounces need investigation in Cloudflare's email logs. A timeout or crash after
provider acceptance can produce a duplicate physical email on retry. The body
and `X-Lulu-Budget-Alert` header carry the stable logical alert reference
`lulu-inference-YYYY-MM-50`, `-75` or `-100` for correlation.

### Remaining operational acceptance

Before a live run, select the nonproduction Worker/ledger, verified sender and
authorized owner recipient, and obtain authorization for actual email delivery.
Use isolated accounting state and controlled inference; no paid model call is
needed to exercise budget alerts. There is no public alert-trigger endpoint.
An operator harness for the selected environment must drive the existing
reservation/coordinator path without exposing the private ledger over HTTP.

Verify a threshold crossing reaches the owner's mailbox with the expected
sender, recipient and logical reference. Exercise an approved transient delivery
failure, restore delivery, and confirm the same logical alert is retried without
changing spend or creating a second logical row. Confirm acknowledgement stops
further application attempts. Record the target Worker/version, UTC time,
threshold/reference, provider delivery result, owner receipt and retry outcome
in #193, without credentials or private email content. Keep the issue open until
that evidence exists; mocked sends, simulated local email and provider acceptance
alone do not satisfy owner receipt. Production release remains separate scope.

## Verification and maintenance

Focused budget checks use mocked storage, runtime scheduling and email delivery:

```sh
pnpm exec vitest run test/shopping/budget-alerts.spec.ts test/shopping/budget-coordinator.spec.ts test/shopping/ledger.spec.ts
pnpm exec tsc --noEmit
pnpm test:project-notes
pnpm cf-typegen
pnpm exec wrangler deploy --dry-run
```

`pnpm test:ci` also invokes real database suites through `test:database` and
`test:quotes`; it is not a mocked-only budget check. Run those suites only when
real database testing is authorized.

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

The focused budget tests load no migration files and configure no shopping
Durable Objects or remote AI bindings. They run in Node with explicit storage,
runtime and provider mocks. Unexpected network requests fail immediately.
These tests verify application behavior; they do not verify
SQLite atomicity, durable restart recovery, migration execution, or real model
quality and latency. The production Worker dry run checks bundling separately.

## Primary references

- [Agents request handler](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Model parameters, context and prices](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/)
- [AG-UI events and custom events](https://docs.ag-ui.com/concepts/events)
- [SQLite Durable Object transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Drizzle Durable Object support](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do)
- [Named Durable Object runtime support](https://developers.cloudflare.com/changelog/post/2026-03-15-durable-object-id-name/)
