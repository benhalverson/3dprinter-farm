import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import { passkey } from 'better-auth/plugins/passkey';
import { Bindings } from './types';

export const createAuth = (env: Bindings) => {
  const db = drizzle(env.DB);

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
    }),
    emailAndPassword: {
      enabled: true,
    },
    plugins: [passkey()],
  });
};
