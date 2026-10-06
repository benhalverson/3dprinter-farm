# Local admin demo fixture

Run from this checkout with dependencies installed and Node 24:

```sh
node --experimental-strip-types tools/admin-demo/serve.ts
```

The API listens at `http://localhost:8790`. Set `DEMO_PORT` to choose another local port. Stop with Ctrl+C; the generated temporary D1 and R2 directories are removed. Each start creates fresh demo state. No Cloudflare account, Slant account, Square account, API key, or email connection is required.

Use `localhost` for both the frontend and API hostnames, such as frontend `http://localhost:3000` and API `http://localhost:8790`. Mixing `127.0.0.1` and `localhost` changes browser cookie site handling. Credentialed CORS permits local origins only. Resolve returned relative upload and image paths against the API origin, not the frontend origin. Provider upload and file URLs use the actual selected API port.

Establish the test-only administrator session once:

```js
await fetch('http://localhost:8790/__fixture/login', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'x-demo-fixture-token': 'lulu-local-demo',
  },
  body: JSON.stringify({ role: 'admin' }),
});
```

Use `credentials: 'include'` for subsequent API requests. Choosing `member` instead verifies that the production catalog role middleware returns 403. An absent session returns 401. `GET /api/auth/get-session` exposes the selected fixture session. The fixture replaces only the BetterAuth session boundary during bundling; production organization membership and catalog role checks still run against real D1. The fixed fixture token and cookie belong exclusively to this localhost harness.

Seeded records are product 1, an existing mapped Square product; product 2, an unmapped legacy product with unknown retained markup; and category 1, `Mounts`. The available Slant material/color is `PLA`/`Black`, production cost is USD 4.50, and the seeded independent in-person price for product 1 is USD 12.00. Existing catalog photos are stored encrypted in real local R2 and served through the production catalog image route. `GET /products`, `GET /categories`, and the production Square catalog routes are mounted.

The draft APIs are the production routes:

- `POST /admin/product-drafts` begins a new or existing-target draft.
- `POST /:id/attachments/intents` reserves a photo or print transfer. PUT bytes to the returned `transfer.upload.url`. Print uploads then require `POST /:id/attachments/transfers/:transferId/confirm`.
- `POST /:id/prepare` saves supplied answers and optionally interprets the current message.
- `POST /:id/pricing/prepare` accepts `{expectedRevision, action}` and returns `{preparation}`. Preparation never authorizes submission.
- `POST /:id/submit` accepts `{expectedRevision, preparationId, action}`.
- `GET /:id/operation` and `POST /:id/reconcile` inspect and resume durable operation state.

For interpretation, send a current message containing a JSON object of corrections, for example `{"name":"Desk bracket","markupPercentage":"50","inPersonPrice":"12.00"}`. The exact phrase `Delete this product` proposes deletion for an existing target. Other free-form messages produce clarification with no invented corrections. This fixture interpretation boundary is deterministic; production parsing, substring validation, draft history persistence, and readiness checks remain active. Its in-process ledger adapter exercises the production accounting call path without consuming a live AI budget.

Provider requests are intercepted in process. Slant file upload/confirmation and estimates, Square validation/retrieval/upsert/image creation, idempotency, and version checks use isolated local state. Unknown outbound destinations return a local failure. No external catalog, payment, email, or file service is contacted.

Run the real HTTP integration proof:

```sh
node --experimental-strip-types --test test/integration/adminDemo.integration.ts
```

The test starts on a random local port, signs in, checks 401/403 and credentialed CORS, proves an unmapped legacy update stays blocked without automatic publication, checks ambiguous-message clarification and interprets a correction, uploads and decodes a photo into encrypted R2, uploads/confirms a print file, prepares USD pricing, injects one lost Square upsert acknowledgement, proves passive inspection then same-operation reconciliation creates exactly one offering through Square image confirmation, reads the public decrypted photo, then updates and deletes through fresh drafts, explicitly discards the upload-owning draft, retries cleanup, and confirms the UUID-keyed R2 photo and Slant file are deleted. It uses actual HTTP requests and real D1 batches.

To trigger this recovery manually, POST `/__fixture/lose-upsert-ack` with the same fixture token before the next submission. The next Square upsert is committed in the local provider state but its acknowledgement is lost; inspect the operation, then reconcile it. This endpoint is part of the fixture only.
