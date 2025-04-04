import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import { D1Database } from '@cloudflare/workers-types';

const db = drizzle({} as D1Database);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'sqlite',
  }),
});

// This is stupid I shouldnt need to do this...
