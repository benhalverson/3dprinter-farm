# Square online checkout and durable fulfillment

This API replaces Stripe online checkout. The storefront must integrate the new contract separately. No live provider setup, deployment, payment, manufacture, email, or production migration is part of this change.

## Prerequisites and configuration

Checkout uses the existing authenticated cart ownership and [shipping-inclusive quote](checkout-quotes.md) contracts. Apply the committed generated migrations in order before enabling these routes; see the [integration rollout guidance](square-integration.md#removals-and-schema-rollout).

Set `SQUARE_ENVIRONMENT` explicitly to `sandbox` or `production`, `SQUARE_ACCESS_TOKEN`, `SQUARE_MERCHANT_ID`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, and `SQUARE_WEBHOOK_NOTIFICATION_URL`. The location must belong to the configured merchant and be active with USD currency. Subscribe to `payment.created` and `payment.updated` at the exact externally registered `/webhook/square` URL. Signature verification uses that configured fixed URL and the exact raw request bytes; request Host, forwarding headers, browser redirects and client paid flags are never payment authority. `SLANT_WEBHOOK_SECRET` is required to accept Slant status callbacks; missing configuration fails closed.

## Online initiation

Authenticated `POST /cart/{cartId}/checkout` accepts only:

```json
{"quoteId":"reviewed-quote-uuid","requestKey":"client-generated-uuid"}
```

Quotes come from the existing owned `/cart/{cartId}/quotes` API. Amounts are integer USD cents. Only Online Prices participate; a separate Slant shipping line makes the quote, Square requested total, and local order total equal. Quote consumption checks the saved address/profile, each exact cart line and catalog price/print identity, expiry and permanent invalidation. Conditional consumption and checkout insertion run in an atomic Drizzle batch with a composite foreign key; one quote cannot authorize multiple logical checkouts.

Response: `attemptId`, `quoteId`, `state`, `paymentUrl`, `squareOrderId`. A URL or `initiating` state does not prove payment. Persist and reuse `requestKey` after timeout or reload; identical initiation returns/replays the original attempt with Square's stable idempotency key and immutable payload. Changed quote/cart/owner conflicts. Subsequent cart/catalog/profile changes cannot mutate this bound payment snapshot. Caller totals, channel, address, shipping and redirect URLs are rejected.

Errors: 400 malformed input; 401 no session; 404 unavailable owned quote/cart; 409 stale quote, consumption race or conflicting key; 502 rejected/uncertain Square operation (retry the same key); 503 required provider configuration missing. Use the owner-scoped [attempt recovery endpoints](#recovering-a-customer-checkout) after a timeout or reload.

## Verified payment and fulfillment

`POST /webhook/square` verifies HMAC-SHA256 before parsing. Unsupported event types return200 without effects. A signed payment event causes authoritative payment/order/location retrieval. Only `COMPLETED`, exact payment and order USD totals, the configured merchant/location, and the original order reference authorize payment. Pending, failed and canceled payments do not create paid orders. Wrong association returns400; invalid signature403; unavailable provider502 (redeliver); missing signature configuration503.

The durable attempt stores payment/order identities. The local order is inserted uniquely by checkout, Square order and Square payment before Slant work. It stores source=`online`, fulfillmentType=`slant`, paymentStatus=`paid`, immutable item/address snapshots, separate shipping and full total. Published account and shipping constraints remain intact for online orders. The shared order schema also supports [QR and phone sales](square-in-person-sales.md), which permit absent customer/shipping fields and never enter Slant fulfillment. Customer and admin reads expose Square identifiers and separate payment/fulfillment status.

Slant stages: `ready` → `drafting` → `drafted` → `processing` → `processed`. Compare-and-swap claims allow one external draft/process effect. The draft ID is saved before process. Lost/crashed draft or process outcomes remain `drafting`/`draft_unknown` or `processing`/`process_unknown`; they never authorize blind repeat manufacture. Payment evidence remains visible as paid even when fulfillment status is `paid_fulfillment_failed`. Definitively rejected draft requests retain paid evidence and return to `ready` for authorized retry; timeouts, throttling, server failures and malformed responses remain uncertain. Snapshot-aware cart cleanup and asset-hold release resume on replay/reconciliation after confirmed processing.

Existing authorized admin `/admin/orders/{id}/retry` retries only `ready` or `drafted`; ambiguous stages return409. `/admin/orders/{id}/reconcile` reads a retained Slant ID and recognizes active/terminal processing evidence without repeating manufacture. To recover a draft whose response/ID was lost, the operator inspects Slant using immutable `orderNumber` then supplies optional `{"slantPublicOrderId":"verified-candidate"}` to that existing reconcile endpoint. The API retrieves the candidate and requires the retained checkout-attempt and Square-payment metadata to match; a verified DRAFT can become `drafted`, while PROCESSING/SHIPPED/DELIVERED confirms fulfillment. Absence of a discoverable draft cannot prove no draft exists; it remains staged for operator recovery. This intentionally preserves ambiguity rather than issuing a second manufacturing operation. The [Square cancellation/refund operation](square-refunds.md) retains the existing eligibility and override policy. Reconciliation also resumes a saved refund operation for orders on refund hold; in-person recovery never calls Slant.

## Persisted events and notifications

Trusted producers are durable `order_events` rows with unique `dedupeKey`: `square_payment_verified` (`square-paid:{paymentId}`) and `square_fulfillment_processed` (`square-fulfilled:{attemptId}`), source=`square`, local orderId and externalEventId=`Square payment ID`. Payment notification consumers use the persisted paid order and immutable snapshot; fulfillment consumers use confirmed fulfillment state. Slant events enter through the signed webhook boundary described below.

The existing Cloudflare notification machinery deduplicates logical notifications. With order notifications enabled, refund recovery reconciles cancellation notifications and queues administrator attention for unknown or failed outcomes. A manufacturing cancellation message never establishes a successful financial refund. See the [refund contract](square-refunds.md) for recovery and customer-visible evidence.

Removed: `/webhook/stripe`, `/success`, `/cancel`, `/cart/{cartId}/stripe-items`, `/cart/{cartId}/payment-intent`, Stripe online checkout helpers and Stripe checkout-readiness requirements. The authenticated admin `/admin/orders/{id}/cancel-refund` operation uses the [Square refund contract](square-refunds.md); obsolete product/order/cancellation Stripe fields, credentials and the Stripe SDK dependency are removed without converting historical orders; no legacy checkout compatibility or historical order conversion is provided.

## Verification and migration limitations

Migration generation is Drizzle-managed. Apply committed forward migrations in order; preserve published migration history and existing catalog, accounts, and order records. The shared in-person schema uses the single generated `0029_in_person_sales_atomic` file; `0030` adds phone intake and `0031` adds refund recovery. Do not split the atomic file or regenerate published migrations as part of a checkout rollout. See the [schema upgrade contract](square-in-person-sales.md#schema-upgrade).

Current migration checks compare generated artifacts and script D1 adapter/ledger responses without executing those migrations. Existing request and persistence suites use controlled provider responses; they do not establish production migration safety or live Square/Slant behavior. Production rollout and provider acceptance require separate operational verification.

Primary provider references: [Square CreatePaymentLink](https://developer.squareup.com/reference/square/checkout-api/create-payment-link) and [Square webhook validation](https://developer.squareup.com/docs/webhooks/step3validate). No provider sandbox or production account is called by validation.

Trusted Slant lifecycle boundary: `/webhook/slant3d` verifies `X-Webhook-Signature-256: sha256=<hex>` using HMAC-SHA256 over `X-Webhook-Timestamp + "." + rawBody` with `SLANT_WEBHOOK_SECRET`, resolves the persisted Slant public order ID, and records `slant_status_changed` with source `slant3d` and the external event ID. Follow-on notification consumers must read the persisted transition; cancellation evidence (`CANCELED` / `canceledAt`) establishes manufacturing cancellation only and never proves a payment refund. The active admin cancellation/refund operation records `square_refund_requested` and deduplicated `square_refund_pending`, `square_refund_failed`, or `square_refund_completed` events as applicable. Only verified completed Square refund evidence sets `paymentStatus` to `refunded`; pending or unknown outcomes remain recoverable and must not be presented as refunded.

Admin order list filters use `squareOrderId` and `squarePaymentId`; detail responses expose both identifiers. Legacy Stripe identifiers are not accepted as payment evidence or retained in the current schema.

### Recovering a customer checkout

Retain the browser-generated `requestKey` before POSTing checkout. On a lost
response, `GET /checkout-attempts/by-request-key/:requestKey` recovers the durable
attempt; `GET /checkout-attempts/:attemptId` reads a known attempt. Both require
the owner session, return 404 for unknown/other-owner identities, and use no-store.
They remain available after cart cleanup and never call a provider or create a
payment. DTO: `{attemptId,quoteId,cartId,state,paymentUrl,order}`; `order` is null or
`{id,paymentStatus,fulfillmentState,status}`. No profile, payment credentials,
provider payloads or internal snapshots are returned.

`unknown` means no hosted-link acknowledgement is retained: retry checkout only
with the same quote/request key. `pending` means a link exists without verified
paid evidence. `failed`/`cancelled` require a retrieved, correlated provider
payment result; neither a redirect nor a local timeout establishes these states.
`paid` requires verified provider evidence and can coexist with pending or failed
manufacturing. A later completed payment can resolve a failed/cancelled attempt;
a delayed failure cannot regress paid state. Status reads never retry manufacture.

Slant V2 order adapter uses the same validated draft shape for shipping estimates
and paid fulfillment: `customer.platformId`, `customer.details.email/address`
(`line1`/`zip`), and `items[].type = PRINT`. Paid fulfillment reads the immutable
paid snapshot, with checkout/payment correlation in metadata. It retains
`data.order.publicId` before processing. Process confirmations require the same
`data.publicId` plus status/payment evidence; reconciliation validates the returned
nested order ID and both metadata identifiers. PAID, QUEUED, PRINTING and
AWAITING_SHIPMENT map to the existing local PROCESSING lifecycle so notification
and customer-order semantics remain stable. Invalid/mismatched responses remain
ambiguous and never authorize a second manufacturing call.

Slant webhooks require `SLANT_PLATFORM_ID` and accept the documented
`event_type`, `platform_id`, `data.order.public_id/status/tracking_number`
envelope. The delivery timestamp is Unix milliseconds and must be within five
minutes of server time. The shared-secret header/flat-body contract is retired.
Invalid signatures, tampering, stale/future timestamps, and wrong platforms are
rejected before lifecycle writes. Authenticated non-order events are acknowledged
with `{success:true,ignored:true}`. Without a provider event ID, deduplication uses
a digest of normalized order facts excluding delivery timestamps, so re-signing a
redelivery does not duplicate lifecycle events or emails. Existing monotonic
transitions and atomic persistence remain in force. Operators must separately
review and deliberately replay failed historical provider deliveries after rollout.
