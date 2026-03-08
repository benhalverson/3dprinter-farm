import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { openAPI } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../src/db/schema';
import type { Bindings } from '../src/types';
import {
  hashPassword as hashLegacyPassword,
  verifyPassword as verifyLegacyPassword,
} from '../src/utils/crypto';

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

async function hashWorkerPassword(password: string) {
  const { salt, hash } = await hashLegacyPassword(password);
  return `${salt}:${hash}`;
}

async function verifyWorkerPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}) {
  const [salt, derivedHash] = hash.split(':');

  if (!salt || !derivedHash) {
    return false;
  }

  return verifyLegacyPassword(password, salt, derivedHash);
}

export function createAuth(database: Bindings['DB'], env?: Bindings) {
  const db = drizzle(database, { schema });
  const baseURL = env?.DOMAIN || 'http://localhost:8787';
  const passkeyOrigin = env?.PASSKEY_ORIGIN?.trim();

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
      password: {
        hash: hashWorkerPassword,
        verify: verifyWorkerPassword,
      },
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
        ...(passkeyOrigin ? { origin: passkeyOrigin } : {}),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
