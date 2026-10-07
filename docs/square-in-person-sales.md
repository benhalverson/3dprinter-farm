# Seller-created in-person sales

These endpoints require an authenticated catalog administrator. They use the same Square sandbox/production, merchant, location and webhook configuration as [online checkout](square-online-checkout.md). Apply the organization authorization fix in #249 before enabling seller access.

`POST /admin/in-person-sales` accepts a UUID `requestKey` and `items: [{productId, quantity}]`. Quantities are integers from 1–100; one request supports at most 100 distinct products. Prices come exclusively from each product's In-Person Price. Caller-supplied totals, duplicate products, missing prices and unknown fields are rejected.

A successful response (201) contains `saleId`, `lines` (product ID, name, quantity, unit amount in cents), `totalCents`, `currency: "USD"`, `paymentStatus`, `outcome`, and `paymentUrl`. The URL is specific to the saved sale and can be encoded as a QR by the client. Shipping, tips, coupons and loyalty are excluded. Preserve the request key before sending; an identical retry reuses the saved snapshot and Square idempotency key. A changed item list or different creating administrator using that key receives 409. Later catalog edits do not change the saved amount.

`GET /admin/in-person-sales/:id` returns the same representation without contacting Square. `paymentStatus` is `pending`, `failed`, `cancelled` or `paid`. `outcome: "unknown"` means a pending sale has no acknowledged payment URL; retry creation with its original request key to recover the same checkout. A 502 is not proof that Square rejected the checkout. An abandoned link remains pending until authoritative provider evidence changes its state. Paid responses hide the payment URL.

The existing signed `/webhook/square` ingress handles `payment.created` and `payment.updated`. It retrieves payment and order evidence and verifies seller, location, sale reference, currency and amount. Only verified completion produces an admin-visible order with `source: "qr"`, `fulfillmentType: "in_person"`, and handed-over fulfillment. Customer identity, email, print file and shipping fields are null. These sales are excluded from customer-owned order reads. In-person retry/reconcile never contacts Slant.

## Schema upgrade

Apply all three generated migrations in order: `0027_in_person_detach_history`, `0028_in_person_sales`, `0029_in_person_restore_history`. They temporarily detach dependent order-history foreign keys, rebuild nullable order identity/address storage, and restore those foreign keys. D1 does not honor disabling foreign keys inside its migration transaction; rebuilding the parent directly would cascade-delete history. The migration test uses the actual D1 migrator to verify retained customer, catalog, order and event records. Do not stop the migration sequence after its intermediate detach step.

## Square phone/POS ingestion

The same signed payment webhook imports completed `application_details.square_product: "SQUARE_POS"` payments for the configured merchant/location, after checking API-created online and QR references. Square identifies the application product, not the physical device: `source: "phone"` means this supported Square POS path, not independently verified phone hardware. Other Square products are excluded. See [Square's application product values](https://developer.squareup.com/reference/square/enums/ApplicationDetailsExternalSquareProduct).

Every line must have a saved catalog variation mapping for this seller/location/environment, a positive integer quantity and USD amounts. Names, quantities, base unit prices and final line totals are copied from the retrieved Square order rather than repriced locally. Supported totals must match the single completed payment and the sum of final line amounts. Unrecognized order references, unmapped lines, split payments and unsupported order-level adjustments remain unmatched; they never manufacture or create a guessed sale.

Successful records appear in the existing admin order list/detail with `source: "phone"`, `fulfillmentType: "in_person"`, paid payment and handed-over fulfillment. Missing account, email and shipping fields remain null. Payment and order uniqueness prevent duplicate intake. Replayed or older events do not regress a recorded sale.

`GET /admin/square-phone-intake/:paymentId` exposes a staff-only intake record: pending evidence, unmatched with a stable diagnostic code, or recorded with its local order ID. `POST /admin/square-phone-intake/:paymentId/reconcile` retrieves fresh authoritative Square evidence, allowing recovery after a provider outage or corrected catalog mapping. Reads/retries require the same staff authorization as sales. Neither path calls Slant. Non-2xx webhook responses may be redelivered by Square; pending/unmatched records also support explicit staff reconciliation. No raw provider payload or payment credentials are stored in this diagnostic record.
