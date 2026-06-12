import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite', // "mysql" | "sqlite" | "postgresql"
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: './.wrangler/state/v3/d1/miniflare-D1DatabaseObject/07ea714d68aae2552dfa4e8d9a26eec21fff446097f8bebf5021b7eebda92aa7.sqlite',
  },
});
