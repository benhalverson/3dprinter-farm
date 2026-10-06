# Private admin product conversation drafts

These API-only conversations belong to the verified Better Auth user. Every
endpoint also requires the existing catalog mutation role (organization admin or
owner). Another privileged account cannot access the conversation. All responses
use `Cache-Control: no-store`.

Shared Zod schemas and inferred TypeScript contracts live in
`src/modules/productDraftContracts.ts`; `/open-api` describes the HTTP contracts.

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /admin/product-drafts` | `{ target, state? }` | `201`, saved draft at revision 1 |
| `GET /admin/product-drafts` | None | `200`, `{ drafts: [...] }`, newest updated first |
| `GET /admin/product-drafts/:id` | UUID path parameter | `200`, saved draft and current context |
| `PUT /admin/product-drafts/:id` | `{ expectedRevision, state }` | `200`, saved draft with next revision |
| `DELETE /admin/product-drafts/:id?expectedRevision=1` | Required positive integer revision | `200`, discard tombstone and cleanup state |

`target` is either `{ "kind": "new" }` or
`{ "kind": "existing", "productId": 42 }`. Existing targets require an actual
positive numeric Catalog Item ID, not a SKU or provider identifier. Starting a
missing product returns `404`. A target cannot change after creation; another
POST always creates another UUID, even for the same product.

Conversation state is a complete replacement on save:

```json
{
  "answers": { "name": "Possible new part" },
  "pendingQuestions": [{ "id": "material", "prompt": "Which material?" }],
  "history": [{ "role": "user", "content": "I have an idea for a part." }]
}
```

Answers allow optional `name`, `description`, `categoryIds`, `filamentType`,
`color`, and `notes`. Empty answers are valid; no publishable product is required.
History preserves array order and accepts `user` and `assistant` text messages.
Omitting state on POST creates empty answers, questions, and history. Request
bodies are limited to 256 KiB; field and array limits are defined by the schemas.
Unknown fields are rejected, including owner IDs, authoritative context, target
changes, server revisions, submission IDs, and confirmation tokens.

Saved responses contain `id`, immutable `target`, `state`, `revision`, `createdAt`,
`updatedAt`, `status`, `cleanupPending`, `attachments`, and `context`. Timestamps are application-provided Unix milliseconds.
List summaries omit state, attachments, and context, but include discarded tombstones so cleanup is discoverable after reload. Context is
`{ status: "new" }`, `{ status: "available", product, categories }`, or
`{ status: "unavailable", productId }`. Product and category values come directly
from current database reads, including legacy and linked categories, and never
overwrite supplied answers. Deleting a referenced product preserves the draft
and its existing-product target. Saving and discarding still work when context is
unavailable.

Drafts have no inactivity expiry. Reading/resuming does not update the draft or
execute anything. Explicit discard clears conversation data and active associations, retaining transfer recovery identities and cleanup. History,
including old deletion confirmations, is never execution authority. These routes
do not publish products, mutate catalog records, call inference, or expose customer tools. Attachment endpoints use R2 and the existing Slant file adapter.

Saves and discards match UUID, authenticated owner, and expected revision in one
Drizzle conditional mutation. Saves replace the entire state and set revision to
`expectedRevision + 1`; there is no automatic conflict merge or upsert. Replaying
an old save returns `409` while the draft exists. After discard, reads and saves
return `404` and cannot recreate it. Persistence is awaited before success. If a
response is lost or a later context read fails, read the draft to determine
whether the save committed before retrying.

Errors: `400` invalid input, `401` missing/invalid session, `403` insufficient
organization role, `404` missing or another owner's draft (also a missing product
on begin), `409` stale revision, and `500` persistence/context failure. A race
that removes the draft can return `404` instead of `409`.

Endpoint unit tests use the existing mocked Better Auth and Drizzle setup:
`pnpm exec vitest run test/routes/productDrafts.spec.ts`. They verify HTTP
contracts and failure behavior; mocks do not establish real D1 durability or
concurrency guarantees.

Migration generation/application use `pnpm run db:generate` and
`pnpm run db:migrate:local`. Migration `0016_plain_supreme_intelligence.sql`
adds reference-attempt recovery records and asset lookup indexes. It was generated
with Drizzle; historical migrations and the confirmed local database configuration
are unchanged. Apply the new migration before rolling out the code.

## Durable attachments

Shared schemas are in `src/modules/productAttachmentContracts.ts`. Attachment
writes return `{ draft }`; intent/retry returns `{ draft, transfer: { id, upload } }`.
`upload` is either `{ method: "PUT", url, headers }` or null when recovery cannot
safely offer another upload. Every write requires the latest `expectedRevision`;
one request may durably advance multiple transfer phases, so use its returned
revision. Reload after an ambiguous response or 409, without replaying an intent.

All paths below start with `/admin/product-drafts/:id`:

| Method and suffix | Input | Behavior |
| --- | --- | --- |
| `POST /attachments/intents` | `{ expectedRevision, kind: "photo" or "print", name, size, replacesId? }` | 201; reserves durable identity before provider calls |
| `PUT /attachments/transfers/:transferId/content?expectedRevision=N` | Raw photo bytes | Detects and decodes PNG/JPEG/WebP, then saves photo |
| `POST /attachments/transfers/:transferId/confirm` | `{ expectedRevision }` | Confirms same Slant placeholder, or checks uncertain photo write |
| `POST /attachments/transfers/:transferId/retry` | `{ expectedRevision }` | Explicit file re-selection; resumes transfer with a fresh generation when an earlier print outcome is unresolved |
| `PATCH /attachments` | `{ expectedRevision, primaryPhotoId?, photoOrder? }` | Independent primary selection/order, no model inference |
| `DELETE /attachments/:attachmentId?expectedRevision=N` | None | Removes saved attachment or safe incomplete transfer; retries cleanup |
| `GET /attachments/:attachmentId/image` | None | Authorized decrypted image with detected MIME |
| `GET /cleanup` | None | Active or discarded recovery state |
| `POST /cleanup/retry` | `{ expectedRevision }` | Retries cleanup independently |

Cleanup reads/retries and discard return `{ id, revision, status, cleanup }`;
status is active or discarded. Normal draft reads/saves return 404 after discard.
Confirm can resolve a previously started transfer on a tombstone, but never
reattaches it to that discarded conversation.
Deterministic finalization failures (including revision conflicts or an asset
already claimed by cleanup) return `409`. Uncertain provider or persistence
outcomes retain unresolved recovery state.
Cleanup retry also reconciles the tombstone's current unresolved photo writes
and known print placeholders, so recovery after reload needs only the cleanup
response. Missing bytes and unavailable providers remain protected for retry.

Photo upload URLs and image URLs are relative to the API origin; Slant presigned
URLs are absolute. Direct print upload is a browser PUT followed by confirm.
Full draft responses preserve unrelated answers and contain saved photos, a
saved printFile or null, independent primaryPhotoId and photoOrder, transfer
history, targeted validation, and cleanup. Saved transfer history never asks for
bytes again. Pending transfers resume as incomplete with requiresReselection;
known invalid bytes become failed. Unknown storage/provider outcomes stay
unresolved; a successful HTTP response alone does not mean the transfer saved.
Unknown Slant allocations are not automatically repeated. Explicit print
re-selection retains the transfer ID, reserves a new asset generation before
allocation, and keeps the earlier operation protected in visible cleanup.
Confirmation retries remain separate and reuse the known placeholder. Late
completion of an abandoned generation cannot replace the current print file.
Cleanup can reconcile known abandoned placeholders and delete unreferenced Slant
files; unknown allocations remain protected. An expired presigned URL can
be abandoned through safe transfer removal and a new explicitly selected intent.
When recovery finds no photo bytes, it does not assume the original PUT stopped:
the transfer retains its ID but receives a fresh asset generation for re-selection.
The old generation remains protected cleanup. Late completion cannot reattach it;
cleanup can reconcile it once its immutable encrypted bytes are observable and
validate against its retained transfer metadata. An unproven outcome stays visible.
Removal preserves the removed transfer identity before releasing its references,
so cleanup can recover an interruption between those steps.

Paid order fulfillment reserves asset references before awaiting Slant order
creation. Reservations compete with deletion claims on the same asset revision.
A persisted order snapshot then protects the asset; definitive draft rejection
releases only its own attempt's reservations. Ambiguous provider or persistence
outcomes retain their references for recovery.

Five photo slots include pending additions; replacement reserves the existing
slot and keeps its old saved asset until replacement succeeds. Each photo is at
most 5,000,000 bytes. Photon validates actual image decoding independently of
MIME headers and filenames. A single photo is automatically primary; adding a
second without an explicit primary choice clears that implicit designation and
returns primary_required. Reordering never changes primary. Removing primary
requires a new selection when multiple photos remain.

Private photo bytes are AES-GCM encrypted in the existing public PHOTO_BUCKET,
using a random per-asset key stored only in private D1 records. Unique UUID object
keys and conditional R2 puts prevent overwrite. Public bucket URLs expose only
ciphertext; the owner/admin checked API decrypts and serves the detected MIME.
The same genuine JPEG/PNG/WebP fixtures decode and roundtrip through endpoint
tests. This addresses new attachment serving relevant to storefront issue #16;
it does not assert that previously deployed public assets are repaired.

Assets, associations, transfer attempts, and cleanup use durable Drizzle records.
Cleanup checks retained drafts, catalog items, orders, and unresolved operations.
Reference reservations and deletion claims conditionally update the same asset
revision; once claimed, new reference creation is rejected. V2 catalog
writers reserve matching assets before mutation. Ambiguous catalog reservations
are conservatively retained. Reservations have individual request identities;
confirmed success and known rejection release only that request's reservation,
preserving other attempts and actual catalog references. R2 and Slant file deletion
are retryable. Slant cleanup calls the authenticated `DELETE /files/{publicFileId}`
endpoint after claiming the asset. Only a successful provider acknowledgement or
a confirmed missing file completes cleanup; an ambiguous DELETE 404 is checked
with GET before treating the file as absent. Missing identities, authorization
failures, unavailable providers, and failed persistence remain visibly pending.
Pending operations remain protected until recovery resolves them, including when
discard races an upload. Cleanup retries preserve newly added cleanup candidates.

Reference attempts persist their token and immutable candidate asset IDs before
any reservations or downstream work. They start `unresolved`; known completion,
rejection, or partial reservation failure records `release_pending` before
removing references. Each release removes only its own token, retries revision
conflicts with fresh reads up to three times per asset, and continues other
assets after an individual failure. Completed releases become `released`.
`POST /admin/product-drafts/:id/cleanup/retry` also retries pending releases for
that draft's assets. Missing records and uncertain outcomes never permit deletion.
Failed release bookkeeping does not turn a saved catalog item or order into an
error, and order event recording continues.

Unfinished transfers and releases are `pending` cleanup; `protected` denotes
retained draft, catalog, or order references. Draft list summaries include
unfinished work without running cleanup during reads. Asset identity queries use
IDs, object keys, Slant IDs, and stored file URLs. Legacy reference checks use
existence queries over relevant columns without truncating the checked records.

## V2 catalog mutations

`POST /v2/add-product` retains its existing create payload, estimate, pricing,
authorization, and response behavior. `PUT /v2/update-product` uses
`updateProductSchema`, the same authorization and response envelopes as
`PUT /update-product`. It validates the product exists, retains both category
input aliases and category validation, and preserves fields outside that update
contract, including SKU, print-file identity and payment-provider IDs. The supplied
`price` remains the update price; there is no new estimate or print replacement.
As on the original update endpoint, omitting `imageGallery` stores an empty gallery,
and omitting categories preserves the existing category associations.

Both V2 mutations reject private draft-photo references in `image` and
`imageGallery` with a field-specific `400` before provider calls or writes. This
includes relative/absolute draft URLs, draft object keys, and identities resolving
to draft photos. Draft photos remain private; public promotion and repair of
existing catalog images are outside this feature.

The original `/add-product` and `/update-product` keep their base-branch behavior.
Existing catalog/order references still protect retained assets, but unmodified
legacy writers do not participate in the V2 reservation protocol; this change
does not claim concurrency protection for those writers. No frontend catalog-write
migration is required by the current draft workspace.

JSON attachment requests retain the 256 KiB limit. Mocked Hono endpoint tests
exercise ownership, revisions, bytes, recovery, and observable provider calls;
they do not prove live D1 races or provider behavior. This feature has not been
deployed and makes no live-commerce calls.

## Authoritative pricing preparation

Conversation `POST /:id/prepare` retains its existing answer/interpretation payload.
Pricing preparation is a separate `POST /:id/pricing/prepare` with
`{ expectedRevision, action?: "create" | "update" | "delete" }`. The optional
action chooses preparation only; it grants no mutation authority. Without it,
the current interpretation intent or draft target determines preparation. It does not advance the draft revision or authorize a
catalog mutation. `GET /:id/preparation` returns `{ preparation: null }` before
preparation, or the current `{ preparation }` without calling providers.

`productPreparationContracts.ts` defines the shared contract:
`id`, `draftRevision`, `preparedAt`, `status` (`ready`, `blocked`, `unavailable`,
`stale`), `readiness: { ready, submissionAuthorized: false }`, field-specific
`validation`, `pricing`, and a private immutable `snapshot` when ready. A snapshot also binds its `action`; submission cannot
reuse an unpriced delete snapshot for creation or update.
Pricing uses USD numeric `productionCost`, retained nullable `markupPercentage`,
`onlinePrice`, and independent `inPersonPrice`. Unknown legacy markup stays null
and needs an explicit answer. The production basis names the confirmed
`publicFileServiceId`, exact available Slant3D `filamentId`, material, color, and
quantity 1. A cost of 1 with 50% markup yields 1.50 using existing rounding.

Preparation validates current categories (including normalized name identity),
required facts, independent channel prices, owned active attachments, primary
selection and photo order. It reads the confirmed Slant file and estimates the
selected material/color's exact filament; errors and mismatched estimate identities
return `unavailable` without creating a Catalog Item. Unsupported or ambiguous
material/color returns `blocked` without estimating a different configuration.

Preparation binds the draft revision, complete existing product state, current
category identities/names and active asset revisions, including retained catalog
assets. Reads and submission invalidate changed inputs as `stale`; callers must
prepare again. Submission needs the current preparation ID and the explicit
Create product or Save changes action. Saved history and final answer text are
never authorization. Preparation snapshots and binding data are private owner/admin
responses and have no storefront exposure.

Delete preparation binds the current product identity/version and retained assets
without Slant calls or required markup, photos, or categories. `productionCost`
and `basis` are null. Known channel values remain independent and nullable.
The explicit delete submission still requires confirmed Square unpublication;
missing Square linkage is a reconciliation blocker. Snapshot `assetIds` names
assets used by the prepared product; `cleanupAssetIds` also includes replaced
assets. All retained revisions are bound, and cleanup remains reference-guarded.

## Explicit product mutations

The conversation registers three explicit card actions through `POST /admin/product-drafts/:id/submit`: `{ expectedRevision, preparationId, action: 'create' | 'update' | 'delete' }`. The action must match the current persisted preparation snapshot. Draft saves, model interpretation, restored history, preparation, and complete answers never authorize execution. Delete preparation binds the existing product/version without requesting Slant pricing or requiring missing legacy markup. A new-product draft keeps its immutable target after creation; the returned catalog identity can start a separate existing-product draft.

`GET /admin/product-drafts/:id/operation` returns `{ operation, product, readiness, storefrontVisible }`. `POST /admin/product-drafts/:id/reconcile` accepts `{ operationId }` and resumes that saved operation only. Product/readiness are read from the current catalog following a succeeded operation; a pending operation never claims storefront completion. A mappingless existing item remains blocked with `square_mapping_required` rather than guessing a remote identity.

Private operation states are `prepared`, `pending`, `item_confirmed`, `square_confirmed`, `repair_required`, `succeeded`, and `failed`. A prepared record is inert until a conditional authorization checks the draft revision, product revision, mapping generation, categories, and reserved assets. Explicit reconciliation of an interrupted inert record retires it and requires fresh preparation. Provider uncertainty retains the immutable request and idempotency key. An overlapping replay prevents a late rejection from incorrectly retiring an operation. After Square confirmation, recovery retries only the local snapshot commit; a changed catalog/category binding remains visible repair work.

Square receives the item name/description, stable SKU, material/color variation name, configured location, independent USD in-person price, and primary image. Primary photos are uploaded with multipart `CreateCatalogImage`, `object_id`, and `is_primary: true`, using a separate stable key; a readback must confirm that image is first in the item's image IDs. WebP bytes are converted deterministically to PNG for Square, without rewriting the encrypted original. Online price, retained markup, category memberships, Slant file/basis, and full photo gallery/order are local fields with no Square representation in this workflow. Existing remote fields and unrelated variations are preserved.

The local product, categories, and Square linkage commit together through conditional Drizzle writes. Creation uses a unique operation provenance column to prevent duplicate products on reconciliation. Update/delete use the prepared catalog revision and mapping generation. Square failures or unconfirmed item/image results leave the catalog unchanged; a successful Square item is never automatically removed after a local failure. Anonymous `/catalog/assets/:assetId/image` access requires an active photo and an exact current catalog image/gallery reference; private draft URLs remain private.

Asset operation holds protect current and replaced files until terminal evidence. Successful updates retain only assets still used by the catalog and release replaced catalog references. Deletion captures cleanup candidates before removing catalog associations. Cleanup checks remaining orders, products, drafts, and unresolved operations; `operation.cleanup` reports protected, deleted, or retryable pending results separately from product completion. Reconciliation retries failed cleanup without another Square item mutation.
