# Shopping-agent review and owned-order tools

Authenticated shopping runs expose `checkout_prepare_review`, `checkout_read_quote`, `checkout_attempt_status`, `customer_orders` and `customer_order`. Anonymous runs retain catalog/validated guest-cart tools only. No tool creates a Square checkout, charge, refund, cancellation or manufacturing order.

Send the normal verified session cookie alongside the visit capability. `X-Expected-Account-Id` is an optional account-change assertion: mismatch returns 409 before forwarding the run; it never grants identity or ownership. Model arguments cannot select another account. Quote preparation uses the run's `cart: {id, revision}`; order questions do not require a cart. Strict tool schemas reject injected identity, price and confirmation fields.

## Trusted review

`checkout_prepare_review` takes an empty object and calls the same authenticated, shipping-inclusive quote module as the deterministic quote route. It may prepare one quote per run. `checkout_read_quote` takes `{quoteId}` and revalidates the same owned quote against current cart, profile, price and filament state. A changed cart revision fails closed.

Successful preparation emits `lulu.commerce.v1` with the standard run/UI revision envelope and `result: {kind: "checkout_review", accountId, status: "review_required", review: {quoteId, cartId, currency, subtotalCents, shippingCents, totalCents, expiresAt, confirmationRequired: true}}`. Other statuses include `stale`, `expired`, `cart_required` and `review_already_prepared`; none authorize purchase. Discard stale UI revisions and account mismatches. Only `review_required` opens trusted review.

The client fetches the owned quote through the existing deterministic route to display complete review details and the authoritative total. The customer must explicitly confirm that displayed review in trusted controls before the client invokes the existing checkout contract. Natural-language text, model output and AG-UI completion cannot supply that confirmation. The hosted Square payment flow still requires its own customer action and signed authoritative payment evidence.

Profile/address fields, Print File identifiers, payment URLs and credentials remain outside model context. The tool receives only quote identity, current validity, currency/totals and expiry. Trusted UI reads retain their existing private contract.

## Recovery and order questions

`checkout_attempt_status` accepts exactly one of `{attemptId}` or `{requestKey}` and calls the same owner-scoped recovery module as the direct endpoints. It returns minimal persisted outcome/order state without provider calls or a hosted payment URL. `unknown` is neither failure nor payment; keep the original request identity and use deterministic recovery. The tool cannot create a replacement attempt.

`customer_orders` takes `{}` and returns up to ten recent owned orders. `customer_order` takes `{orderId}`. Both use the direct customer-order projection, reduced to order identity, payment/fulfillment state, amount/currency, shipment/delivery dates and refund summary. No account selector, profile, provider credential or raw event payload is exposed. Missing/foreign orders are unknown; policies and absent facts remain unknown.

Events have `kind: "owned_orders"` or `"checkout_attempt"` and include verified `accountId` only in the trusted client event. That identity is not added to the model's tool result. Every paid tool-loop invocation retains the existing budget reservation/settlement boundary. Unavailable inference, exhausted budget, disconnection and repeated run IDs cannot create purchases, and deterministic quote/order/recovery routes remain usable.

## Contract evaluation

`test/persistence/agentCheckout.spec.ts` exercises real isolated SQLite persistence and direct HTTP quote/order/recovery routes with controlled provider responses. Its seven scenarios cover review totals and redaction; injected identity/confirmation/payment tools; another user's order; stale/expired quotes; unknown payment recovery; budgeted tool-loop review; and unavailable inference with usable direct controls. Existing cart tests cover replay, cancellation, budget exhaustion and concurrent direct edits.

The recorded local review scenario completed with valid schema, two paid-call reservations/settlements, no repair attempt, and 10–15 ms measured fixture latency. At the repository's pinned test rates, reported fixture usage totals 13,000 nanodollars ($0.000013); actual provider spend is $0. The test emits `shopping_checkout_contract_evaluation` for reproducibility. These fixture measurements are not production performance or live-model quality claims. No live charge, refund, manufacture, inference or deployment was performed.
