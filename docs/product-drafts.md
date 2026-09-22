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
| `DELETE /admin/product-drafts/:id?expectedRevision=1` | Required positive integer revision | `204`, no body |

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
`updatedAt`, and `context`. Timestamps are application-provided Unix milliseconds.
List summaries contain the same metadata without state or context. Context is
`{ status: "new" }`, `{ status: "available", product, categories }`, or
`{ status: "unavailable", productId }`. Product and category values come directly
from current database reads, including legacy and linked categories, and never
overwrite supplied answers. Deleting a referenced product preserves the draft
and its existing-product target. Saving and discarding still work when context is
unavailable.

Drafts have no inactivity expiry. Reading/resuming does not update the draft or
execute anything. Explicit discard deletes conversation data only. History,
including old deletion confirmations, is never execution authority. These routes
do not publish products, mutate catalog records, call providers or inference,
enqueue operations, expose customer tools, or clean up uploads.

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
history. Current local application is blocked by the pre-existing duplicate
`cart.user_id` migration; that history is not rewritten by this feature.
