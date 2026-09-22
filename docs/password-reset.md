# Password-reset API and rollout

The backend uses Better Auth's existing Drizzle verification records. No production schema change or migration is required. Password hashing and the existing 8–128 character password limits are unchanged; a successful reset consumes the token and revokes all sessions.

## API contract

- `POST /api/auth/request-password-reset`: JSON `{ "email": "customer@example.com", "redirectTo": "https://luluspeedworks.com/reset-password" }`. `redirectTo` is optional, but browser clients should supply it. Registered and unknown addresses receive the same `200` body: `{ "status": true, "message": "If this email exists in our system, check your email for the reset link" }`. Provider failures do not change that response.
- The email links to `GET https://api.benhalverson.dev/api/auth/reset-password/:token?callbackURL=...`. A valid token redirects to `https://luluspeedworks.com/reset-password?token=...`. An expired or invalid token redirects to `https://luluspeedworks.com/reset-password?error=INVALID_TOKEN`. Opening a valid link does not consume the token.
- `POST /api/auth/reset-password`: JSON `{ "token": "...", "newPassword": "..." }`. Success returns `{ "status": true }`. Invalid, expired, or previously consumed tokens and invalid passwords return `400`.

Tokens expire after one hour. Better Auth checks trusted origins on both the initial request and callback; untrusted destinations return `403`. Without `redirectTo`, Better Auth's email callback redirects to `/api/auth/error?error=INVALID_TOKEN`; clients can still submit the token directly. The storefront callback screen is a separate requirement and is not implemented here.

The existing KV limiter allows five reset requests and ten password submissions per IP, each with a 900-second TTL. Each accepted request refreshes the TTL, consistent with the existing middleware. Counters are best-effort, non-atomic KV counters, not a strict distributed security boundary. Limits return `429` and do not depend on account existence.

## Email and logging

`AUTH_EMAIL` uses Cloudflare's structured sending API with text and HTML bodies, restricted to `Lulu Speedworks <noreply@luluspeedworks.com>`. Better Auth schedules delivery through the Worker execution context's `waitUntil`. Delivery exceptions produce only `auth.password_reset.email_delivery_failed`; provider exception details and reset credentials are never logged. Better Auth's logger emits only severity categories because its default messages can contain callback URLs.

Application request logs exclude password-reset routes, including token-bearing callback paths and query tokens. Cloudflare invocation logs are disabled because they include request URLs; other application logs remain enabled. Any separately configured proxy, Logpush, or tracing sinks should also exclude these URLs before rollout.

`AUTH_BASE_URL=https://api.benhalverson.dev` is the canonical API origin. Existing `DOMAIN`, `RP_ID`, and `PASSKEY_ORIGIN` settings retain their storefront/passkey purposes. Copy the `AUTH_BASE_URL=http://localhost:8787` override from `.dev.vars.example` into local configuration. `AUTH_EMAIL` has `remote=false`, so ordinary local development uses local email simulation and does not deliver real email. Do not enable remote bindings for automated tests.

## Verification

`pnpm test` and `pnpm test:ci` retain their existing behavior and run the Worker suite. Drizzle and Vitest configuration and package dependencies are unchanged. The existing suite mocks Better Auth and Drizzle; it does not provide end-to-end password-reset validation.

Run `pnpm test:project-notes` under Node 22 (the CI version; its existing script uses a flag removed in Node 24), `pnpm exec tsc --noEmit`, and `pnpm exec wrangler deploy --dry-run` before release.

## Rollout steps

1. Onboard `luluspeedworks.com` for Cloudflare Email Sending and verify all required DNS records. At implementation time, `wrangler email sending list` showed only `chassisnotes.com` enabled. Confirm Lulu's status before attempting live delivery.
2. Deploy the backend with the restricted `AUTH_EMAIL` binding and canonical `AUTH_BASE_URL`, preserving the current passkey settings and auth secret. No production migration is needed for this feature.
3. With an explicitly chosen controlled inbox and registered test account, request a reset. Confirm actual inbox receipt separately from provider acceptance; inspect sender, text/HTML link, and expiry wording. Never paste the full link or token into logs or issue comments.
4. Complete a reset and verify old-password rejection, new-password sign-in, session revocation, expired-link handling, and token-reuse rejection.
5. Deliver the storefront reset screen before advertising customer-facing recovery. Backend completion alone does not make the full customer journey available.

Domain onboarding, deployment, and real inbox delivery testing are pending rollout actions, not claims established by the automated suite or dry run.

References: [Better Auth options](https://better-auth.com/docs/reference/options), [Cloudflare Workers email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
