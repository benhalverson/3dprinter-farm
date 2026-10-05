# Checkout quote contract

Authenticated customers create an owned quote with `POST /cart/:cartId/quotes`
and an empty JSON object. No client address, price, amount, currency or channel is
accepted. Update the saved profile first (`POST /profile/:id`); `GET /profile`
returns its street as `address`, while the save field is `shippingAddress`.
The quote maps first/last name to `address.name`, shippingAddress to `line1`,
zipCode to `zip`, and uppercases the two-letter country code. City and state map
by name; `line2` is empty because the profile has no second street field.

`GET /cart/:cartId/quotes/:quoteId` returns the immutable snapshot and current
`status`: `valid`, `expired` or `stale`. Both endpoints require the customer
session and send `Cache-Control: no-store`. Inaccessible identifiers return 404.
Malformed requests return 400; unready cart/profile/prices return 409; provider
shipping failures return 502; unavailable configuration or filament verification
returns 503. No quote is issued if shipping fails. A quote read can fail closed
rather than reporting validity while availability is unknown.

Amounts `unitAmountCents`, line `totalAmountCents`, `subtotalCents`,
`shippingCents` and `totalCents` are safe integer USD cents. The immutable lines
include Catalog Item ID, SKU, name, quantity, fixed material, selected filament
ID/color and durable Slant File ID. `products.price` is the Online Price in major
USD; In-Person Price never participates. Shipping uses the existing Slant3D draft
estimate and its validated exact-cent conversion, separately from item amounts.
No tax, discount or additional charge policy is introduced.

`createdAt` and `expiresAt` are epoch milliseconds. Quotes have a 15-minute
technical review window, not a guarantee of provider rate availability.
Creation rechecks saved inputs after the shipping estimate. Reads recheck
ownership, selected address, cart lines, Online Prices, Print File identity and
fixed-material filament availability. Any observed mismatch permanently marks
the quote stale; the original evidence remains immutable. Input checks compare
current snapshots; they do not record every intermediate edit between reads.
The snapshot is encrypted at rest using the existing profile encryption key.
A new POST creates a new review identity; retries never charge or manufacture.

## Square consumption dependency: issue 178

This slice creates no payment, order, fulfillment, reservation or quote-consumption
endpoint. A successful read is **not** payment authorization. The later Square
integration must accept an owned quote ID, revalidate it immediately before
payment initiation and durably bind one consumption/payment attempt to the quote.
It must atomically protect the current-input comparison and consumption against
cart/profile/catalog writes; calling this GET and later creating a payment is
insufficient. Concurrent attempts and ambiguous provider outcomes require durable
idempotency and reconciliation under #178.

Square's requested amount and currency must come from the bound immutable
`totalCents` and `currency`, and the stored order must retain the same encrypted
snapshot, item subtotal and separate shipping. Later edits must not reprice the
bound payment/order. Verified payment association must include quote identity,
Square order/payment identifiers, amount/currency and configured seller/location.
Only verified completion may authorize the separate fulfillment boundary.

Lulu #5 can review quotes from this API but its payment-association acceptance
criterion remains blocked by #178 until an isolated payment/order integration
proves that binding. Mocked quote HTTP responses do not establish Square payment
association or production deployment.

## Isolated persistence validation

`pnpm test:quotes` generates a disposable schema from the current Drizzle schema
and applies it to isolated SQLite databases. It exercises the quote HTTP routes,
real persistence/primary-key constraints and controlled provider responses.
`pnpm test:ci` includes this suite. Published migration history is not rewritten:
its existing duplicate cart columns in migrations 0002/0004 prevent claiming a
clean historical replay. Disposable schema tests validate the current model,
not an already deployed database or production migration.
