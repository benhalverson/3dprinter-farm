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
`pnpm run db:migrate:local`. The generated draft migration preserves existing
history. Current local application is blocked by existing schema/migration tracking mismatch: Drizzle reports `table account already exists` before the new migration. Historical migrations and local data are not reset or rewritten.

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
revision; once claimed, new reference creation is rejected. Existing catalog
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

JSON attachment requests retain the 256 KiB limit. Mocked Hono endpoint tests
exercise ownership, revisions, bytes, recovery, and observable provider calls;
they do not prove live D1 races or provider behavior. This feature has not been
deployed and makes no live-commerce calls.
