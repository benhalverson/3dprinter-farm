import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  driver: 'durable-sqlite',
  schema: './src/shopping/storage/ledger-schema.ts',
  out: './drizzle/shopping-ledger',
});
