# Square API integration

Square is the sole active payment provider. Storefront/admin/native integrations and provider provisioning are separate work; these API contracts do not complete the user-interface cutover.

## Configuration and ingress

Set `SQUARE_ENVIRONMENT` to `sandbox` or `production` and supply the matching `SQUARE_ACCESS_TOKEN`, `SQUARE_MERCHANT_ID` and `SQUARE_LOCATION_ID`. Catalog mappings and requests are scoped to that environment, seller and location. Never reuse sandbox credentials or mapping identities in production. The API verifies location/merchant evidence before accepting payments; it never accepts a caller-selected seller or payment amount.

Set `SQUARE_WEBHOOK_SIGNATURE_KEY` from the intended Square subscription and `SQUARE_WEBHOOK_NOTIFICATION_URL` to the exact externally registered HTTPS URL ending in `/webhook/square`. The signature covers that exact URL plus the original request body, so scheme, host, path and trailing slash must match the subscription. Subscribe to `payment.created` and `payment.updated`. The shared ingress verifies the signature before retrieving authoritative payment/order evidence. Do not configure separate competing online, QR and phone intake endpoints.

## Sale contracts

| Path | Initiation and recovery | Amount and fulfillment |
| --- | --- | --- |
| Online | [Quote, explicit review and checkout](square-online-checkout.md) | Catalog online price plus separately verified Slant shipping; paid evidence precedes manufacturing |
| QR | [Seller sale creation and status](square-in-person-sales.md) | Immutable In-Person Price snapshot; no shipping; handed over, no Slant |
| Phone/POS | [Signed intake and staff reconciliation](square-in-person-sales.md#square-phonepos-ingestion) | Actual mapped Square POS line/payment amounts; handed over, no Slant |

All paths share `ordersTable` and unique Square payment/order identities. API-created online/QR references take precedence over phone intake; unsupported references and incomplete/mismatched evidence remain unmatched. Admin list/detail exposes `source`, `fulfillmentType`, payment and fulfillment state with nullable customer/shipping fields for in-person sales. Anonymous in-person sales do not become customer-owned orders.

`POST /admin/orders/:id/retry` and `/reconcile` recover existing fulfillment identities. They never create Slant work for in-person sales. [Cancellation/refund](square-refunds.md) uses a durable Square idempotency identity, verifies the full refundable amount, and distinguishes pending/failed/completed financial outcomes. Unknown payment, draft, process or cancellation outcomes require reconciliation; do not replace keys to bypass ambiguity.

## Removals and schema rollout

The Stripe SDK, active schema fields, secrets, checkout/session/payment-intent helpers, catalog calls, webhook and health requirements are removed. Retired routes remain absent; there is no mixed-provider compatibility shim or historical order conversion. Historical ADRs and applied migration files remain historical evidence.

Apply the generated forward migrations in order on a backed-up existing database; do not reset catalog, Print Files, users or order history. For `0027`–`0029`, pause order writes/deletions until the entire detach/rebuild/restore sequence completes. Do not serve traffic with dependent foreign keys detached. `0030` adds phone intake and `0031` adds refund recovery. Separate features may append later migrations. Populate and test an isolated copy before a production rollout; this PR does not deploy.

The repository's isolated HTTP/persistence suites exercise all three sale paths, replay/concurrency, configured seller/location checks, price separation, shipping totals, admin visibility, refunds and forbidden in-person Slant effects. D1 upgrade tests retain representative customers, catalog and historical child records. These are source/mocked provider checks, not a claim of live Square sandbox certification. A real sandbox sale/refund and external subscription verification still require operator credentials and explicit execution scope.
