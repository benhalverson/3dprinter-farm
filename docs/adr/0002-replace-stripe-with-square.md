# Replace Stripe with Square

Scope is API-only. The storefront, admin frontend, and native phone apps are consumers of the API contracts and are not implementation targets. Issue #177 implements the catalog-publication slice of this decision; dependent issues cover payments and order behavior.

In-person payment must not require separate Square hardware. Use Square's phone app for contactless Tap to Pay and the custom app for QR checkout, where the customer pays on their own device. Both paths represent in-person sales and must not trigger Slant3D fulfillment.

For QR checkout, the seller selects catalog items and quantities in the admin app, then displays a QR code for that specific sale and its exact in-person total. The QR code is not a reusable link to the online on-demand checkout.

Show sales taken through Square's phone app in the existing admin order list alongside online and QR sales. Identify completed in-person sales as handed over, and never submit them to Slant3D fulfillment.

Use Square for customer payments across online and in-person sales. Remove the application's Stripe integration completely, without a legacy compatibility path or order-data migration, because there are no existing orders to preserve.

The existing admin app owns the catalog, including print-file and Slant3D settings. Publish the sales details to Square's catalog for use in its POS app, rather than importing a Square-owned catalog into this application.

Each catalog item has separate online and in-person prices managed in the admin app. Phone contactless payments and in-person QR checkout use the in-person price; online on-demand checkout uses the online price. Preserve the existing separate Slant3D shipping charge and shipping-estimate flow when replacing checkout; do not fold shipping into item prices.

In-person sales hand over stock already printed by the seller and must not trigger Slant3D fulfillment. Those same catalog items are also sold online on demand, exclusively for Slant3D to print and ship; selling an item in person does not make it a separate catalog item. Online orders do not draw from seller-produced stock or offer local pickup.

## Catalog implementation decision (#177)

Catalog publication is an explicit admin/owner action, separate from local saves and manufacturing readiness. Preserve the existing Online Price/creation markup semantics and require both prices and store the In-Person Price as integer USD cents. Publish one location-scoped Item and fixed-price variation through a Workers fetch adapter pinned to Square API version 2026-08-19.

A single D1-backed catalog-publication module owns mappings, target snapshots, serialized requests, idempotency keys, status and retries. Resolve uncertain operations by replaying their exact request before applying newer edits. Preserve unowned remote fields and complete versioned variations on refresh. Archive/unarchive rather than delete Square objects; require confirmed unpublication before deleting locally, and retain detached historical mappings. Conditional Drizzle writes and atomic D1 batches enforce concurrency boundaries without queues or schedules. Always use Drizzle for persistence and schema generation; no custom SQL migrations or triggers.

This first slice removes Stripe catalog creation and its unused product identifier. The Stripe price identifier remains only for unfinished checkout/readiness consumers until #178; new Catalog Items never populate it. This is an intermediate implementation step toward complete Stripe removal, not authorization to deploy a mixed-provider system. See [catalog contracts and recovery](../square-catalog-publication.md).
