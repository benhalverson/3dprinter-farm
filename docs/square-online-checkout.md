# Square online checkout and durable fulfillment

This API replaces Stripe online checkout. The storefront must integrate the new contract separately. No live provider setup, deployment, payment, manufacture, email, or production migration is part of this change.

## Prerequisites and configuration

Requires the actual authentication/cart implementation from PR222 (`ab7d14284534b4964b5a076d3f7e0980de08a624`) and quote implementation from PR227 (`11399e1c90e74e253cc90aa599f4aeed5c6e789a`). Both are integrated locally on this branch. Merge them in the parent's serialized queue before rebasing this PR and regenerating its unpublished migration. Published catalog migration0018 is unchanged. Do not apply competing unpublished generated increments from PR224.

Set `SQUARE_ENVIRONMENT` explicitly to `sandbox` or `production`, `SQUARE_ACCESS_TOKEN`, `SQUARE_MERCHANT_ID`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, and `SQUARE_WEBHOOK_NOTIFICATION_URL`. The location must belong to the configured merchant and be active with USD currency. Subscribe to `payment.created` and `payment.updated` at the exact externally registered `/webhook/square` URL. Signature verification uses that configured fixed URL and the exact raw request bytes; request Host, forwarding headers, browser redirects and client paid flags are never payment authority. `SLANT_WEBHOOK_SECRET` is required to accept Slant status callbacks; missing configuration fails closed.

## Online initiation

Authenticated `POST /cart/{cartId}/checkout` accepts only:

```json
{"quoteId":"reviewed-quote-uuid","requestKey":"client-generated-uuid"}
```

Quotes come from the existing owned `/cart/{cartId}/quotes` API. Amounts are integer USD cents. Only Online Prices participate; a separate Slant shipping line makes the quote, Square requested total, and local order total equal. Quote consumption checks the saved address/profile, each exact cart line and catalog price/print identity, expiry and permanent invalidation. Conditional consumption and checkout insertion run in an atomic Drizzle batch with a composite foreign key; one quote cannot authorize multiple logical checkouts.

Response: `attemptId`, `quoteId`, `state`, `paymentUrl`, `squareOrderId`. A URL or `initiating` state does not prove payment. Persist and reuse `requestKey` after timeout or reload; identical initiation returns/replays the original attempt with Square's stable idempotency key and immutable payload. Changed quote/cart/owner conflicts. Subsequent cart/catalog/profile changes cannot mutate this bound payment snapshot. Caller totals, channel, address, shipping and redirect URLs are rejected.

Errors: 400 malformed input; 401 no session; 404 unavailable owned quote/cart; 409 stale quote, consumption race or conflicting key; 502 rejected/uncertain Square operation (retry the same key); 503 required provider configuration missing. Public attempt-status discovery is deferred to issue190; durable identities and same-key recovery are implemented here.

## Verified payment and fulfillment

`POST /webhook/square` verifies HMAC-SHA256 before parsing. Unsupported event types return200 without effects. A signed payment event causes authoritative payment/order/location retrieval. Only `COMPLETED`, exact payment and order USD totals, the configured merchant/location, and the original order reference authorize payment. Pending, failed and canceled payments do not create paid orders. Wrong association returns400; invalid signature403; unavailable provider502 (redeliver); missing signature configuration503.

The durable attempt stores payment/order identities. The local order is inserted uniquely by checkout, Square order and Square payment before Slant work. It stores source=`online`, fulfillmentType=`slant`, paymentStatus=`paid`, immutable item/address snapshots, separate shipping and full total. Published account and shipping constraints remain intact for online orders. Future in-person intake requires a separate data-preserving storage migration; a generated nullable order-table rebuild was rejected because local D1 cascaded deletion into dependent order history. Customer and admin reads expose Square identifiers and separate payment/fulfillment status.

Slant stages: `ready` → `drafting` → `drafted` → `processing` → `processed`. Compare-and-swap claims allow one external draft/process effect. The draft ID is saved before process. Lost/crashed draft or process outcomes remain `drafting`/`draft_unknown` or `processing`/`process_unknown`; they never authorize blind repeat manufacture. Payment evidence remains visible as paid even when fulfillment status is `paid_fulfillment_failed`. Definitively rejected draft requests retain paid evidence and return to `ready` for authorized retry; timeouts, throttling, server failures and malformed responses remain uncertain. Snapshot-aware cart cleanup and asset-hold release resume on replay/reconciliation after confirmed processing.

Existing authorized admin `/admin/orders/{id}/retry` retries only `ready` or `drafted`; ambiguous stages return409. `/admin/orders/{id}/reconcile` reads a retained Slant ID and recognizes active/terminal processing evidence without repeating manufacture. To recover a draft whose response/ID was lost, the operator inspects Slant using immutable `orderNumber` then supplies optional `{"slantPublicOrderId":"verified-candidate"}` to that existing reconcile endpoint. The API retrieves the candidate and requires exact orderNumber association; a verified DRAFT can become `drafted`, while PROCESSING/SHIPPED/DELIVERED confirms fulfillment. Absence of a discoverable draft cannot prove no draft exists; it remains staged for operator recovery. This intentionally preserves ambiguity rather than issuing a second manufacturing operation. Refund adaptation remains issue181; no new refund policy is introduced.

## Trusted Cloudflare notification interface for PR165

PR165 remains separate. Trusted producers are durable `order_events` rows with unique `dedupeKey`: `square_payment_verified` (`square-paid:{paymentId}`) and `square_fulfillment_processed` (`square-fulfilled:{attemptId}`), source=`square`, local orderId and externalEventId=`Square payment ID`. Payment notification consumers must use the persisted paid order and immutable snapshot; fulfillment notification consumers must use confirmed fulfillment state. Slant events must enter through the configured shared-secret ingress. PR165 must deduplicate notification delivery using its durable infrastructure and Cloudflare email only; this implementation makes no email call and does not edit PR165.

Removed: `/webhook/stripe`, `/success`, `/cancel`, `/cart/{cartId}/stripe-items`, `/cart/{cartId}/payment-intent`, Stripe online checkout helpers and Stripe checkout-readiness requirements. The authenticated admin `/admin/orders/{id}/cancel-refund` operation returns410 without provider calls or persistence changes; Square cancellation/refund adaptation remains issue181; obsolete product/order/cancellation Stripe fields, credentials and the Stripe SDK dependency are removed without converting historical orders; no legacy checkout compatibility or historical order conversion is provided.

## Verification and migration limitations

Migration generation is entirely Drizzle-managed. The unpublished increments add durable quote/attempt/order/event fields, then remove obsolete Stripe fulfillment storage and seven Stripe columns without rebuilding orders. Separating additions from removal produces a narrowly reviewed removal increment. Existing account/address constraints avoid the destructive foreign-key cascades observed in a local D1 order-table rebuild. Disposable tests apply a schema-generated current-main baseline plus these generated increments while retaining an existing user. The historical bootstrap's duplicate cart columns remain preexisting; this change neither rewrites that published history nor claims an untouched historical full bootstrap succeeds. Regenerate the unpublished increments after prerequisite merges in the final queue.

Primary provider references: [Square CreatePaymentLink](https://developer.squareup.com/reference/square/checkout-api/create-payment-link) and [Square webhook validation](https://developer.squareup.com/docs/webhooks/step3validate). No provider sandbox or production account is called by validation.

Trusted Slant lifecycle boundary: `/webhook/slant3d` requires the configured `x-slant-webhook-secret`, resolves the persisted Slant public order ID, and records `slant_status_changed` with source `slant3d` and the external event ID. Follow-on notification consumers must read the persisted transition; cancellation evidence (`CANCELED` / `canceledAt`) establishes manufacturing cancellation only and never proves a payment refund. Issue181 must establish its own durable verified Square refund evidence before reporting refunded payment. The retired admin route emits no cancellation or refund event.

Admin order list filters use `squareOrderId` and `squarePaymentId`; detail responses expose both identifiers. Legacy Stripe identifiers are not accepted as payment evidence or retained in the current schema.
