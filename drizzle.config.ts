import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

const miniflareDbDir = './.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const miniflareDbFile = existsSync(miniflareDbDir)
  ? readdirSync(miniflareDbDir).find(entry => entry.endsWith('.sqlite'))
  : undefined;
const fallbackDbUrl = join(miniflareDbDir, 'local.sqlite');

export default defineConfig({
  dialect: 'sqlite', // "mysql" | "sqlite" | "postgresql"
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url:
      process.env.DRIZZLE_DB_URL ??
      process.env.LOCAL_DB_PATH ??
      (miniflareDbFile ? join(miniflareDbDir, miniflareDbFile) : fallbackDbUrl),
  },
});
