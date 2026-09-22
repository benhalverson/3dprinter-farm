import { defineConfig } from 'drizzle-kit';

// Production history cannot bootstrap an empty DB: 0000 already includes the
// cart.user_id column added again by 0002. Generate an isolated test baseline.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './.wrangler/auth-test-migrations',
});
