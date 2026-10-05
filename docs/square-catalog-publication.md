# Catalog publication to Square (#177)

The API owns the Catalog Item. Saving it never publishes to Square. Square publication does not contact Slant3D, refresh Print Files, or import Square edits into the local catalog.

## Prices and local catalog routes

`POST /add-product` and `POST /v2/add-product` require `inPersonPrice` in USD. `price` remains the deprecated alias for the **markup percentage** on creation; `markupPercentage` takes precedence. Manufacturing estimates still determine the stored Online Price. V2 still requires the confirmed durable `publicFileServiceId`.

`PUT /update-product` and `PUT /v2/update-product` retain its required catalog fields and accepts `inPersonPrice`. Positive numeric USD amounts up to 99,999,999.99 with at most two decimal places are accepted. Storage uses integer cents. Existing records may return `inPersonPrice: null` until explicitly priced. Both prices are required on full update; omitted or null prices are rejected. In-Person Price cannot be cleared. There is no fallback to Online Price. `price` on update/read remains Online Price in USD. Create/read responses return `inPersonPrice` as USD, including list, pagination, search, and individual reads.

Catalog mutations and publication endpoints require an authenticated shared-organization admin or owner, using the existing catalog authorization policy. Customer/member callers receive 403; unauthenticated callers receive 401.

## Explicit price backfill

`PATCH /admin/catalog/:id/in-person-price` accepts only `{ "inPersonPrice": 12.34 }` and returns `{ "id": 1, "price": 19.95, "inPersonPrice": 12.34 }`. These are illustrative amounts, not seller defaults. This admin/owner operation sets an owner-supplied USD amount without estimating markup, changing Online Price, replacing print metadata, or publishing to Square. Invalid/missing/null prices and extra fields return 400; missing items return 404; a concurrent catalog edit returns 409 and requires reload/retry. Ordinary 401/403 authorization applies.

Identify unpriced records through the existing product reads (`inPersonPrice: null`), then provide a legitimate amount for each item through this endpoint. No owner prices or markup can be recovered from rounded Online Prices. Unknown prices remain null and block publication; no price backfill is required merely to preserve existing records during migration.

## Explicit publication

| Endpoint | Contract |
| --- | --- |
| `GET /admin/catalog/:id/square` | Prices, status, mapping, pending operation, sanitized error |
| `POST /admin/catalog/:id/square/publish` | Publish/refresh current details, or resume the pending operation |
| `POST /admin/catalog/:id/square/unpublish` | Archive the mapped Item, or resume the pending operation |

The response includes `id`, `price`, `inPersonPrice`, `status`, nullable `mapping` (`environment`, `merchantId`, `locationId`, `itemId`, `variationId`), nullable `pendingOperation` (`id`, `kind`, `createdAt`), and nullable `error` (a fixed sanitized code). Tokens, upstream response bodies and request snapshots are never exposed.

- `unpublished`: no confirmed active publication, including archived Items. A pending publish may already have reached Square: always inspect `pendingOperation`.
- `published`: the confirmed publication matches locally owned name, description, SKU, material, color, and In-Person Price.
- `needs_update`: those local details differ from the confirmed publication. Online Price, images, categories and Print Files are outside Square publication and do not mark it dirty.

One Square Item and one fixed-price In-Person variation are initially created. Material/color appear in the variation name. Both are restricted to the configured location; inventory tracking is disabled. Refresh retrieves the complete Item and current nested variation versions, preserving unowned fields and any additional remote variations. It replaces the owned sales details; local data never changes from a Square read.

Unpublication sets `item_data.is_archived`, retaining Item and variation IDs. Republish clears that archive flag using the same mappings. A published Item or any unresolved operation blocks local deletion with 409. The module includes these guards in conditional Drizzle writes, so concurrent publication cannot slip between a check and mutation. After confirmed unpublication, local deletion retains a detached historical mapping and operation history.

## Failure and retry

Every operation's exact serialized request, target snapshot and UUID idempotency key are committed to D1 before the Square write. A new row begins in inert `prepared` state, which cannot authorize any Square request. A conditional Drizzle update activates it as `pending` only if the product revision, attached mapping generation, and absence of another pending operation still match. Abandoned prepared rows never block publication or deletion. A partial unique index allows one pending operation per mapping. Conditional reservation detects concurrent local edits, deletion, and completed operations; conflicting preparation returns 409 (`catalog_changed_retry`). Completion is conditional on the operation still being pending, in a D1 transaction. Late responses cannot overwrite a newer operation, and edits made during publication remain `needs_update`.

A timeout, transport error, oversized/malformed response, 408, 429, or 5xx leaves the operation pending. Repeat either action to replay that exact saved payload/key. It resolves the old operation only: inspect the returned state and invoke the desired action again to publish newer changes or archive after a pending publish. Replays never allocate a fresh key for an uncertain operation, even if a later replay is rejected. A definitive rejection of a newly reserved first attempt records a failed operation; the next explicit request retrieves current versions and prepares a fresh operation. A crash after reservation is handled as an uncertain operation.

Square failures return 502 with sanitized codes, also visible through status. Missing configuration returns 503, invalid ID or publish price/name returns 400, missing local item returns 404, and a mapping/configuration mismatch returns 409 without contacting Square. Reads show the persisted mapping scope even when configuration changes; changing credentials does not silently remap existing items. Recovery is synchronous; no scheduler or queue is involved. Operators must restore the correct credentials/configuration for an unresolved operation; do not delete pending rows to force a new listing.

## Configuration and forward migration

Configure all four values explicitly for each Worker environment:

- `SQUARE_ENVIRONMENT`: `sandbox` or `production`, selecting the fixed Square API origin.
- `SQUARE_ACCESS_TOKEN`: Worker secret; never committed. Requires catalog read/write and location-read access.
- `SQUARE_MERCHANT_ID`: seller whose catalog is managed.
- `SQUARE_LOCATION_ID`: active USD location belonging to that merchant.

Each mutation validates the returned location ID, merchant association, USD currency, and active status. Requests pin `Square-Version: 2026-09-16`, have a 10-second timeout including response reads, and accept at most 2 MiB of response data. See [Square upsert semantics](https://developer.squareup.com/reference/square/catalog-api/upsert-catalog-object) and [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

`0018_square_catalog.sql` adds nullable In-Person Price, a catalog revision, and Square mapping/operation tables, and removes the obsolete Stripe product identifier. Generate increments against the latest accepted snapshot with `pnpm db:generate`; retain published migrations and verify preservation on a populated disposable copy before applying an upgrade.

The inherited historical chain cannot bootstrap an empty database: `0002` adds `cart.user_id`, `0003` adds `filament_id`, and `0004` repeats both additions. Its journal also contains non-monotonic timestamps. A later forward migration cannot repair a replay that fails before reaching it. Before any existing-database upgrade, establish the target schema and actual migration tracking from an authorized copy; do not infer applied state or edit tracking records to skip failures. A fresh installation needs a separately generated baseline/bootstrap strategy, preserving the legacy history for existing targets. Do not run both histories against the same database.

No new products receive Stripe identifiers and no catalog creation invokes Stripe. Existing checkout/readiness still consumes `stripe_price_id` until #178 replaces checkout; newly created items therefore cannot use that unfinished Stripe checkout. #179–#182 implement dependent payment, webhook, QR and order behavior. No checkout, refunds, inventory synchronization, image/category synchronization, frontend work, credential provisioning, live transactions, or deployment is included here.
