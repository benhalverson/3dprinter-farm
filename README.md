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

This project uses Drizzle ORM for database schema management and migrations. Below are detailed instructions for running migrations both locally and on Cloudflare D1.

### Local Development Migrations

#### Prerequisites
- Ensure you have the project dependencies installed: `pnpm install`
- Make sure your local development environment is set up with `.dev.vars` file

#### 1. Generate Migration Files
When you make changes to the database schema in `src/db/schema.ts`, generate a migration file:

```bash
npx drizzle-kit generate
```

This will:
- Create a new migration file in `drizzle/migrations/`
- Generate the necessary SQL statements based on schema changes
- Update the migration metadata in `drizzle/migrations/meta/`

#### 2. Apply Migrations Locally
To apply migrations to your local development database:

```bash
# Option 1: Apply all pending migrations
npx drizzle-kit migrate

# Option 2: Push schema changes directly (development only)
npx drizzle-kit push
```

**Note**: `drizzle-kit push` is faster for development but doesn't create migration files. Use `generate` + `migrate` for production-ready changes.

#### 3. Verify Local Changes
Start your development server to test the changes:

```bash
pnpm run dev
```

### Cloudflare D1 Remote Migrations

#### Prerequisites
- Ensure you're authenticated with Cloudflare: `npx wrangler auth login`
- Have the correct database name configured in `wrangler.toml`

#### Cloudflare Dashboard workflow

If you prefer to apply changes from the Cloudflare dashboard instead of the CLI:

1. Open your D1 database in the Cloudflare dashboard.
2. Open the SQL editor for the target database.
3. Open the migration file you want to apply from `drizzle/migrations/`.
4. Copy the SQL from the migration file and paste it into the SQL editor.
5. Run each migration in chronological order.
6. Repeat for every environment you use separately, for example:
	- local preview database
	- remote production database
	- remote preview/staging database

For the Better Auth organization-role migration in this repository, make sure `drizzle/migrations/0001_jittery_peter_parker.sql` has been applied everywhere the app runs. That migration creates:

- `organization`
- `member`
- `invitation`
- `session.active_organization_id`

#### 1. Apply Individual Migration Files
For each migration file that needs to be applied to the remote database:

```bash
npx wrangler d1 execute DATABASE_NAME --remote --file=drizzle/migrations/MIGRATION_FILE.sql
```

**Example**:
```bash
npx wrangler d1 execute ecommerce --remote --file=drizzle/migrations/0002_uneven_glorian.sql
```

#### 2. Apply Multiple Migrations
If you have multiple migration files to apply, run them in order:

```bash
# Apply migrations in chronological order
npx wrangler d1 execute ecommerce --remote --file=drizzle/migrations/0001_initial.sql
npx wrangler d1 execute ecommerce --remote --file=drizzle/migrations/0002_add_column.sql
npx wrangler d1 execute ecommerce --remote --file=drizzle/migrations/0003_update_indexes.sql
```

#### 3. Execute Custom SQL Scripts
For data cleanup or custom operations:

```bash
# Create a temporary SQL file
echo "UPDATE products SET image_gallery = '[]' WHERE image_gallery IS NULL;" > cleanup.sql

# Execute the script
npx wrangler d1 execute ecommerce --remote --file=cleanup.sql

# Clean up
rm cleanup.sql
```

#### 4. Verify Remote Changes
Check that your migrations were applied successfully:

```bash
# View database schema
npx wrangler d1 execute ecommerce --remote --command="SELECT sql FROM sqlite_master WHERE type='table';"

# Check specific table structure
npx wrangler d1 execute ecommerce --remote --command="PRAGMA table_info(products);"
```

#### 5. Deploy Updated Code
After applying database migrations, deploy your updated application:

```bash
pnpm run deploy
```

### Migration Best Practices

#### Development Workflow
1. **Make schema changes** in `src/db/schema.ts`
2. **Generate migration** with `npx drizzle-kit generate`
3. **Test locally** with `npx drizzle-kit migrate` or `npx drizzle-kit push`
4. **Verify functionality** by running `pnpm run dev`
5. **Commit changes** including both schema and migration files

#### Production Deployment
1. **Review migration files** before applying to production
2. **Backup database** (if applicable) before running migrations
3. **Apply migrations** to remote D1 database using `wrangler d1 execute`
4. **Deploy application** with `pnpm run deploy`
5. **Test endpoints** to ensure everything works correctly

#### Important Notes
- **Order matters**: Apply migrations in chronological order (0001, 0002, 0003, etc.)
- **No rollbacks**: D1 doesn't support automatic rollbacks, plan migrations carefully
- **Downtime**: Remote migrations may cause brief downtime during execution
- **Testing**: Always test migrations locally before applying to production
- **Backup**: Consider exporting data before major schema changes

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

If you are setting up a fresh environment from the Cloudflare dashboard, do these steps after applying the migrations:

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

#### Common Issues

**Migration file not found**:
```bash
# Check if migration files exist
ls -la drizzle/migrations/

# Ensure you're in the project root directory
pwd
```

**Database connection errors**:
```bash
# Verify wrangler authentication
npx wrangler auth whoami

# Check database configuration
npx wrangler d1 list
```

**Schema sync issues**:
```bash
# Force regenerate migration
npx drizzle-kit generate --force

# Check current schema state
npx drizzle-kit introspect
```

### Database Commands Reference

```bash
# Development
npx drizzle-kit generate              # Generate migration files
npx drizzle-kit migrate               # Apply migrations locally
npx drizzle-kit push                  # Push schema changes directly (dev only)
npx drizzle-kit introspect           # Inspect current database schema

# Production (Cloudflare D1)
npx wrangler d1 list                                    # List databases
npx wrangler d1 execute DB_NAME --remote --file=FILE    # Execute migration file
npx wrangler d1 execute DB_NAME --remote --command=SQL  # Execute SQL command
npx wrangler d1 export DB_NAME                         # Export database
```

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
5. Run migrations: `npx drizzle-kit push`
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
- `GET|POST /auth/signout` - Clear the current session cookie
- `GET /api/auth/get-session` - Return the active Better Auth session
