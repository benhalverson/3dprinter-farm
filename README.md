# 3D Printer Web API

A Cloudflare Workers-based API for managing 3D printer products, built with Hono, Drizzle ORM, and Cloudflare D1 database.

## Features

- Product management (CRUD operations)
- Search functionality with pagination
- Authentication middleware
- Image gallery support
- Stripe integration for payments
- STL file processing and pricing

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **ORM**: Drizzle ORM
- **Authentication**: JWT with signed cookies
- **Payment Processing**: Stripe
- **Validation**: Zod
- **Testing**: Vitest

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
4. Run migrations: `npx drizzle-kit push`
5. Start development server: `pnpm run dev`

## Deployment

```bash
pnpm run deploy
```

## API Endpoints

- `GET /products` - List all products (with optional pagination)
- `GET /products/search` - Search products (authenticated, with pagination)
- `GET /product/:id` - Get specific product
- `POST /add-product` - Add new product (authenticated)
- `PUT /update-product` - Update product (authenticated)
