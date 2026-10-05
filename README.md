# 3D Printer Web API

A Cloudflare Workers-based API for managing 3D printer products, built with Hono, Drizzle ORM, and Cloudflare D1 database.

## Features

- Product management (CRUD operations)
- Search functionality with pagination
- Authentication middleware
- Image gallery support
- Stripe integration for payments
- STL file processing and pricing
- Project notes sync pipeline for `benhalverson-blog`

## Project Notes Pipeline

This repo can generate the Markdown content for the `On-Demand 3D Printer Platform` page in `benhalverson-blog`.

- Stable project metadata and roadmap state live in `project-notes.config.json`
- PR authors fill out the project-notes sections in `.github/pull_request_template.md`
- `tools/project-notes/validate-pr-notes.ts` validates PR bodies in CI
- `tools/project-notes/generate-project-notes.ts` rebuilds the final Markdown page from config plus merged PR history
- `.github/workflows/project-notes-publish.yml` opens or updates a PR in `benhalverson-blog`

Useful commands:

```bash
pnpm run test:project-notes
pnpm run generate:project-notes -- --output .generated/project-notes/on-demand-3d-printer-platform.md
```

### Secrets and tokens

The cross-repo publish workflow uses two kinds of GitHub credentials:

- GitHub's built-in workflow token `${{ github.token }}` to read pull request history from this repository
- a custom secret named `BLOG_REPO_TOKEN` to check out `benhalverson/benhalverson-blog` and open or update a PR there

Set up `BLOG_REPO_TOKEN` in this repository, `3dprinter-farm`.

Recommended token shape:

- fine-grained personal access token or GitHub App token
- repository access limited to `benhalverson/benhalverson-blog`
- minimum permissions:
  - `Contents: Read and write`
  - `Pull requests: Read and write`

You do not need to add a matching secret in `benhalverson-blog` for the current design. The workflow in this repo pushes the change by opening a PR into the blog repo using `BLOG_REPO_TOKEN`.

If `benhalverson-blog` has branch protection or PR restrictions, make sure the token's user or app is allowed to open pull requests there.

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **ORM**: Drizzle ORM
- **Authentication**: Better Auth with session cookies and passkeys/WebAuthn
- **Payment Processing**: Stripe
- **Validation**: Zod
- **Testing**: Vitest

## Authentication

The API now uses Better Auth for session-based authentication.

- Browser sessions use the `better-auth.session_token` cookie.
- Compatibility routes remain available at `/auth/signup`, `/auth/signin`, and `/auth/signout`.
- Native Better Auth routes are mounted under `/api/auth/*`.

### Storefront origin and session contract

`src/config/browserOrigins.ts` is the exact allowlist shared by CORS and Better Auth. It includes `https://luluspeedworks.com`, the existing RC storefront/admin, API and Race Forge origins, and local development ports 3000, 4200, 5173 and 8787. Unrelated origins (including `null`, lookalike suffixes, and unlisted subdomains) receive 403 before route execution. Credentialed preflights permit `Content-Type`, `Authorization` and `X-Cart-Token`. Originless non-browser clients still require each route's authentication/capability checks.

Use `credentials: 'include'` for signup, signin, profile and **POST** signout. GET signout is not supported because link navigation must not revoke a session. A rejected signout remains an error; clients must not claim that the server session was cleared. Auth, profile, cart and other private responses, including errors and credentialed responses, carry `Cache-Control: private, no-store` and vary by Origin, Cookie, Authorization and X-Cart-Token.

`AUTH_BASE_URL` identifies the API origin (local default `http://localhost:8787`), independently of the storefront `DOMAIN`. The prepared production configuration uses the owner-approved `https://api.luluspeedworks.com`, which is same-site with `https://luluspeedworks.com` over HTTPS. Frontend requests remain cross-origin and must include credentials. HTTPS sessions use host-only HttpOnly cookies with Secure and SameSite=None; local HTTP uses SameSite=Lax without Secure. No shared cookie domain is configured. API cookies are not readable by storefront JavaScript or shared between API hostnames; customers must sign in again when moving from the old API hostname.

Routing/DNS/TLS for `api.luluspeedworks.com`, deployment of this configuration, and the frontend API-base update are separate release prerequisites. This code does not provision DNS or change dashboard-managed Worker routes. Preserve the existing `api.benhalverson.dev` route for RC-store clients. Both API origins and the RC storefront remain in the exact allowlist. The old API hostname is cross-site from Lulu: third-party-cookie restrictions in Chromium or WebKit can prevent sessions there despite correct CORS. Do not use the old hostname as a silent fallback for Lulu authentication.

`DOMAIN=https://rc-store.benhalverson.dev`, `RP_ID=rc-store.benhalverson.dev`, and `PASSKEY_ORIGIN=https://rc-store.benhalverson.dev` remain unchanged to preserve RC-store behavior and its existing passkey credentials. Lulu's supported account flow uses passwords; changing AUTH_BASE_URL does not make RC-bound passkeys usable from Lulu. A future Lulu passkey rollout requires a separate relying-party/credential design and must not overwrite the RC configuration. Existing RC clients can continue using their old API hostname and its own host-only cookie; the configured base URL for generated auth links is now the Lulu API hostname.

On a 401 profile/cart response, clients must recover through signin and retain only the local cart/return intent, without serving another account's cached private data. Mocked route tests or local HTTP checks alone do not establish browser acceptance of the HTTPS origin/session topology.

### Route auth policy

The API uses the following route protection rules:

- **Public read routes**: product browsing and read-only catalog endpoints such as `GET /products`, `GET /products/search`, `GET /product/:id`, `GET /categories`, and public printer metadata endpoints.
- **Authenticated user routes**: profile endpoints, saved upload endpoints, shipping/payment-intent helpers tied to a signed-in user, and product/category mutation routes such as `POST /add-product`, `POST /v2/add-product`, `PUT /update-product`, `DELETE /delete-product/:id`, and `POST /add-category`.
- **Ownership checks**: authenticated upload lookup endpoints also enforce that a user can only access their own uploaded files.

When adding new routes, apply `authMiddleware` directly on the protected route or protected route group before the handler declaration. Do not rely on later middleware registration order.

### Native Better Auth reference docs

When the local dev server is running, Better Auth exposes an interactive native API reference at:

- `http://localhost:8787/api/auth/reference`

If you are using the dev server on a different host, use that host with the same path.

### Native auth endpoints

Common native auth endpoints exposed by this API include:

- `GET /api/auth/get-session`
- `POST /api/auth/sign-in/email`
- `POST /api/auth/sign-out`

### Passkey endpoints

Passkey routes are exposed under `/api/auth/passkey/*`.

- `GET /api/auth/passkey/generate-register-options`
- `POST /api/auth/passkey/verify-registration`
- `GET /api/auth/passkey/generate-authenticate-options`
- `POST /api/auth/passkey/verify-authentication`
- `GET /api/auth/passkey/list-user-passkeys`

Notes:

- `POST /api/auth/passkey/verify-registration` is handled directly by Better Auth.
- Validation errors and response payloads for registration verification follow Better Auth defaults.
- `/api/auth/passkey/register` and `/api/auth/passkey/authenticate` are client helper names in Better Auth, not server routes in this API.

## Database Migrations

Use Drizzle schemas and query APIs for all persistence, including database initialization and data corrections. Generate and apply migrations with the repository Drizzle commands below.

1. Change `src/db/schema.ts` (which also exports the Durable Object schemas).
2. Run `pnpm run db:generate` and review the generated migration and metadata in `drizzle/migrations`.
3. Apply locally with `pnpm run db:migrate:local`. Verify the database path in `drizzle.config.ts`; use a disposable copy when validating existing history.
4. When remote migration is explicitly authorized, use `pnpm run db:migrate:remote`. This preserves the existing Wrangler application command and its migration tracking. Check the target environment and binding before running it. Deployment requires separate authorization.

Do not hand-write SQL, use schema push, paste SQL into a dashboard, directly execute migration files, or create custom migration loaders. If Drizzle cannot support an operation, explain the limitation and ask before using another approach. Do not reset data or rewrite published migration history to hide replay failures.

`pnpm run check:sql` inspects authored TypeScript/JavaScript and permits SQL files only under the configured Drizzle migration directory. Placement does not prove generation: retain evidence of `db:generate`, inspect its output and metadata, and compare with the base history. Generated declarations and Drizzle introspection artifacts are excluded. This static check resolves known SQL APIs through TypeScript symbols; dynamic code and erased types still require review.

Timestamp defaults are supplied by Drizzle's `$defaultFn`: UTC text uses `YYYY-MM-DD HH:mm:ss`; integer timestamp columns retain their seconds/milliseconds modes and Date mappings. Explicit values and nullable columns remain supported. These defaults apply on insert only. After the generated migration removes database defaults, inserts outside Drizzle must supply timestamps. No automatic update timestamps are introduced.

### Checks and diagnostics

Run `pnpm run check`, `pnpm run test:project-notes`, and `pnpm run test:ci`. Biome lint keeps existing severities and warnings; generated Worker declarations are excluded. CI uses the same checks, including branches and PR targets with slashes.

For Worker failures, use the global [$worker-diagnostics](../../.codex/skills/worker-diagnostics/SKILL.md) skill. Identify the URL/environment, local revision and active deployment, bindings, request identifiers and structured errors. Treat mocked tests, local preview, and deployed observations as separate evidence.

Migration inspection must be read-only. The installed Wrangler migration-list command initializes its tracking table, so do not use it for diagnostics. Use existing migration logs/history or Drizzle-based reads of existing tracking tables. Report missing or inaccessible applied/pending state as **unverified**; do not apply migrations to discover it.

## Better Auth Organization Setup

This project now uses Better Auth's organization plugin for catalog-management permissions.

### Shared organization model

The application uses a single shared organization for catalog administration:

- organization id: `org_shared_catalog`
- organization name: `3D Printer Web API`
- organization slug: `3dprinter-web-api`

Catalog mutation routes check the caller's shared-organization role, not only the legacy `users.role` field.

### First admin bootstrap

The admin promotion endpoint can promote other users, but the very first admin must exist first.

For an authorized first-admin bootstrap, use the existing Drizzle schema and query APIs after applying generated migrations:

1. Find the target user's `id` in the `users` table.
2. Ensure the shared organization row exists in `organization`.
3. Ensure the user has a row in `member` for `org_shared_catalog`.
4. Set that membership's `role` to `admin`.
5. For compatibility with the current transitional code, also set `users.role` to `admin`.
6. Have the user sign out and sign back in so a fresh session is issued.

Recommended values:

- `organization.id`: `org_shared_catalog`
- `organization.name`: `3D Printer Web API`
- `organization.slug`: `3dprinter-web-api`
- `organization.metadata`: `{"type":"shared"}`
- `member.id`: `member:org_shared_catalog:<USER_ID>`
- `member.organization_id`: `org_shared_catalog`
- `member.user_id`: `<USER_ID>`
- `member.role`: `admin`

### Ongoing admin management

After the first admin exists, future promotions and demotions should go through the application endpoint instead of direct database edits:

- `POST /users/:id/organization-role`

Request body:

```json
{
	"role": "admin"
}
```

Valid roles for this endpoint are:

- `admin`
- `member`

### Troubleshooting organization setup

If Better Auth organization endpoints fail, verify all of the following in the target database:

- the `organization` table exists
- the `member` table exists
- the `invitation` table exists
- the `session` table has `active_organization_id`
- the shared organization row exists
- the intended admin user has a `member` row for `org_shared_catalog`
- the intended admin user also has `users.role = 'admin'` during the transition period

### Troubleshooting

Use [$worker-diagnostics](../../.codex/skills/worker-diagnostics/SKILL.md) to compare the requested environment, active deployment, bindings, and verified migration history. Check organization and membership records through Drizzle reads. Leave unavailable evidence unverified rather than forcing schema synchronization.

## Development Setup

1. Clone the repository
2. Install dependencies: `pnpm install`
3. Set up environment variables (copy `.dev.vars.example` to `.dev.vars`)
4. Add a strong `BETTER_AUTH_SECRET` and set `DOMAIN` for local Better Auth callbacks/docs
	 - Example local values:
		 - `BETTER_AUTH_SECRET=<random 32+ byte secret>`
		 - `DOMAIN=http://localhost:8787`
		 - `RP_ID=localhost`
		 - Optional when frontend runs on another origin (for example `http://localhost:3000`): `PASSKEY_ORIGIN=http://localhost:3000`
5. Apply generated migrations: `pnpm run db:migrate:local`
6. Start development server: `pnpm run dev`

After the dev server starts, you can open:

- App docs: `http://localhost:8787/docs`
- Better Auth native reference: `http://localhost:8787/api/auth/reference`

## Deployment

```bash
pnpm run deploy
```

Notes:

- `pnpm run deploy` deploys the default Wrangler worker (`name = "3dprinter-web-api"`).
- Ensure passkey variables are set in `wrangler.toml` under `[vars]`:
	- `DOMAIN=https://rc-store.benhalverson.dev`
	- `RP_ID=rc-store.benhalverson.dev`
	- `PASSKEY_ORIGIN=https://rc-store.benhalverson.dev`

## API Endpoints

- `GET /products` - List all products (with optional pagination)
- `GET /products/search` - Search products (authenticated, with pagination)
- `GET /product/:id` - Get specific product
- `POST /add-product` - Add new product (authenticated)
- `PUT /update-product` - Update product (authenticated)
- `POST /auth/signup` - Create a user and issue a session cookie
- `POST /auth/signin` - Sign in and issue a session cookie
- `POST /auth/signout` - Clear the current session cookie
- `GET /api/auth/get-session` - Return the active Better Auth session

## Cart ownership contract

Cart ownership is persisted in `shopping_carts` independently of cart lines. It uses the existing Better Auth session, with no separate identity store. All cart responses are private and non-cacheable; requests must include credentials for account-owned carts.

- `POST /cart/create` persists an empty cart and returns `{ cartId, ownerId, message }` for a verified account, or `{ cartId, guestToken, ownerId: null, message }` for a guest. Store the guest capability locally with its cart ID; it is returned only at creation and only its SHA-256 hash is persisted. Body fields such as `userId` and `ownerId` do not assign ownership. An optional `{ expectedUserId: string | null }` body asserts the account the UI observed (null for a guest); a changed session returns 409 before creating a cart. The response `ownerId` always reflects the verified session.
- `GET /cart/:cartId`, `POST /cart/add`, `PUT /cart/update`, and `DELETE /cart/remove` require either the owning account's session cookie or `X-Cart-Token: <guestToken>` for an unclaimed cart. A cart ID alone grants no access. An account may access an unclaimed guest cart only with that capability.
- `POST /cart/:cartId/claim` requires both a verified account session and the unclaimed guest capability. It binds the entire cart, including an empty cart, to that account, clears the capability hash, and rotates the authorization version atomically. Existing lines follow the rotated version through the database foreign key. Subsequent claims by the same owner succeed idempotently; other accounts and the old token cannot access the claimed cart. The required JSON body is `{ expectedUserId: string }`: this is a stale-session guard checked against the verified account, never an ownership credential. A shared-cookie account switch returns 409 before transfer. Success is `{ message: "Cart claimed", ownerId: string }`, reporting the verified account that owns the cart.
- Shipping and the existing payment preparation routes additionally require the owning account session; sign in and claim first. This work adds no checkout or payment implementation.
- Reads return `{ items, total }`; an authorized empty cart returns an empty `items` array and zero total. Item `name`, `price`, and `stripePriceId` may be null when their catalog product is absent. These browsing values are not an authoritative quote or payment contract.
- Addition validates the stored product SKU and fixed material against an available provider filament UUID. Add quantities are integers from 1 through 69; update quantities are integers from 0 through 69, where zero removes the line. Concurrent additions use a conditional quantity update or a unique configuration insertion; a losing request returns 409 instead of dropping an addition or exceeding the limit.
- Ownership denial returns 404 without disclosing whether the cart exists. Missing required account authentication returns 401; invalid input returns 400; unavailable filament verification returns 503. A lost claim/addition race returns 409 and requires reloading before retrying. Updates/removals return 404 when no line remains in the authorized version, including requests invalidated by a claim. Do not blindly retry additions because a transport failure may conceal a completed mutation.

Legacy lines without an authorization version are inaccessible through this contract; the API never trusts or infers ownership from a line or a client assertion. Existing generated migrations `0012` and `0013` are prerequisites for the durable cart and cascading authorization-version constraint. Committed migration history is unchanged, and no production database is migrated. Mocked Hono tests cover route authorization, parameter binding, and conflict responses. `pnpm run test:database` additionally executes the production ownership/mutation functions against a disposable SQLite/libsql database created using `drizzle-kit generate` and `drizzle-kit migrate` from the current schema. It verifies durable empty carts, real foreign-key cascades and stale insert rejection, two-account isolation, simultaneous competing claims, claims racing in-flight additions, unique configurations, and bounded concurrent quantities. This Node suite is separate from the mocked Hono/Workers suites and is included in `test:ci`; its scheduling barriers delay real operations without mocking SQL execution or results.

The database harness separately attempts committed-history replay on a different disposable database. At this revision that replay fails with `SQLITE_ERROR: duplicate column name: user_id` (the CLI exits 1 with only its progress spinner; the standard Drizzle migrator exposes the diagnostic). The generated-current-schema tests passing do not establish that existing history can bootstrap a database or that any deployed database has the required constraints. Applied production history remains unverified. Resolve the existing history/bootstrap discrepancy without rewriting applied history before provisioning or migrating a deployment; remote migration and deployment require separate authorization.
