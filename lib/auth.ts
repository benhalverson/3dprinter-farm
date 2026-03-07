import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { openAPI } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../src/db/schema';
import type { Bindings } from '../src/types';

function getAuthSecret(env?: Bindings) {
  const secret = env?.BETTER_AUTH_SECRET?.trim();

  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is required');
  }

  if (secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters long');
  }

  return secret;
}

function getCookieAttributes(baseURL: string) {
  const isSecure = new URL(baseURL).protocol === 'https:';

  return {
    sameSite: isSecure ? ('none' as const) : ('lax' as const),
    secure: isSecure,
  };
}

export function createAuth(database: Bindings['DB'], env?: Bindings) {
  const db = drizzle(database, { schema });
  const baseURL = env?.DOMAIN || 'http://localhost:8787';

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        ...schema,
        user: schema.users,
      },
    }),
    secret: getAuthSecret(env),
    baseURL,
    emailAndPassword: {
      enabled: true,
    },
    user: {
      modelName: 'users',
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'user',
          input: false,
        },
        firstName: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
        lastName: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
        shippingAddress: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
        billingAddress: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
        city: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
        state: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
        zipCode: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
        country: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
        phone: {
          type: 'string',
          required: false,
          defaultValue: '',
        },
      },
    },
    trustedOrigins: [
      'http://localhost:3000',
      'http://localhost:4200',
      'http://localhost:5173',
      'http://localhost:8787',
      'https://rc-store.benhalverson.dev',
      'https://rc-admin.pages.dev',
      'https://race-forge.com',
    ],
    advanced: {
      defaultCookieAttributes: getCookieAttributes(baseURL),
    },
    plugins: [
      openAPI(),
      passkey({
        rpID: env?.RP_ID || 'localhost',
        rpName: env?.RP_NAME || '3D Printer Web API',
        origin: baseURL,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
