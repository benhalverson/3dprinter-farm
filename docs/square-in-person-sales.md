# Seller-created in-person sales

These endpoints require an authenticated catalog administrator. They use the same Square sandbox/production, merchant, location and webhook configuration as [online checkout](square-online-checkout.md). Apply the organization authorization fix in #249 before enabling seller access.

`POST /admin/in-person-sales` accepts a UUID `requestKey` and `items: [{productId, quantity}]`. Quantities are integers from 1–100; one request supports at most 100 distinct products. Prices come exclusively from each product's In-Person Price. Caller-supplied totals, duplicate products, missing prices and unknown fields are rejected.

A successful response (201) contains `saleId`, `lines` (product ID, name, quantity, unit amount in cents), `totalCents`, `currency: "USD"`, `paymentStatus`, `outcome`, and `paymentUrl`. The URL is specific to the saved sale and can be encoded as a QR by the client. Shipping, tips, coupons and loyalty are excluded. Preserve the request key before sending; an identical retry reuses the saved snapshot and Square idempotency key. A changed item list or different creating administrator using that key receives 409. Later catalog edits do not change the saved amount.

`GET /admin/in-person-sales/:id` returns the same representation without contacting Square. `paymentStatus` is `pending`, `failed`, `cancelled` or `paid`. `outcome: "unknown"` means a pending sale has no acknowledged payment URL; retry creation with its original request key to recover the same checkout. A 502 is not proof that Square rejected the checkout. An abandoned link remains pending until authoritative provider evidence changes its state. Paid responses hide the payment URL.

The existing signed `/webhook/square` ingress handles `payment.created` and `payment.updated`. It retrieves payment and order evidence and verifies seller, location, sale reference, currency and amount. Only verified completion produces an admin-visible order with `source: "qr"`, `fulfillmentType: "in_person"`, and handed-over fulfillment. Customer identity, email, print file and shipping fields are null. These sales are excluded from customer-owned order reads. In-person retry/reconcile never contacts Slant.

## Schema upgrade

Apply all three generated migrations in order: `0027_in_person_detach_history`, `0028_in_person_sales`, `0029_in_person_restore_history`. They temporarily detach dependent order-history foreign keys, rebuild nullable order identity/address storage, and restore those foreign keys. D1 does not honor disabling foreign keys inside its migration transaction; rebuilding the parent directly would cascade-delete history. The migration test uses the actual D1 migrator to verify retained customer, catalog, order and event records. Do not stop the migration sequence after its intermediate detach step.
