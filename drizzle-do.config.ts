import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  driver: 'durable-sqlite',
  schema: './src/shopping/storage/*-schema.ts',
  out: './drizzle/durable-objects',
});
