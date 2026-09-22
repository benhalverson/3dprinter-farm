import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { openAPI, organization } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import { html } from 'hono/html';
import * as schema from '../src/db/schema';
import type { Bindings } from '../src/types';
import {
  hashPassword as hashLegacyPassword,
  verifyPassword as verifyLegacyPassword,
} from '../src/utils/crypto';

export type AuthBindings = Pick<
  Bindings,
  | 'AUTH_BASE_URL'
  | 'AUTH_EMAIL'
  | 'BETTER_AUTH_SECRET'
  | 'RP_ID'
  | 'RP_NAME'
  | 'PASSKEY_ORIGIN'
>;

function getAuthSecret(env?: AuthBindings) {
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

function isLocalHost(hostname: string) {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
}

function getPasskeyRpId(baseURL: string, env?: AuthBindings) {
  const configuredRpId = env?.RP_ID?.trim();

  if (configuredRpId) {
    return configuredRpId;
  }

  const baseHost = new URL(baseURL).hostname;

  if (isLocalHost(baseHost)) {
    return 'localhost';
  }

  throw new Error('RP_ID is required for non-local environments');
}

function validatePasskeyOrigin(rpID: string, passkeyOrigin?: string) {
  if (!passkeyOrigin) {
    return;
  }

  const originHost = new URL(passkeyOrigin).hostname;
  const isValidRpRelation =
    originHost === rpID || originHost.endsWith(`.${rpID}`);

  if (!isValidRpRelation) {
    throw new Error(
      `PASSKEY_ORIGIN host (${originHost}) must equal RP_ID (${rpID}) or be its subdomain`,
    );
  }
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

export function createAuth(
  database: Bindings['DB'],
  env?: AuthBindings,
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>,
) {
  const db = drizzle(database, { schema });
  const baseURL = env?.AUTH_BASE_URL || 'http://localhost:8787';
  const passkeyOrigin = env?.PASSKEY_ORIGIN?.trim();
  const rpID = getPasskeyRpId(baseURL, env);

  validatePasskeyOrigin(rpID, passkeyOrigin);

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        ...schema,
        user: schema.users,
        organization: schema.organizationTable,
        member: schema.memberTable,
        invitation: schema.invitationTable,
      },
    }),
    secret: getAuthSecret(env),
    baseURL,
    emailAndPassword: {
      enabled: true,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        try {
          if (!env?.AUTH_EMAIL) throw new Error('Missing email binding');
          await env.AUTH_EMAIL.send({
            from: {
              email: 'noreply@luluspeedworks.com',
              name: 'Lulu Speedworks',
            },
            to: user.email,
            subject: 'Reset your Lulu Speedworks password',
            text: `Reset your password: ${url}\n\nThis link expires in one hour. If you did not request a password reset, ignore this email.`,
            html: String(
              html`<p>Reset your Lulu Speedworks password:</p><p><a href="${url}">Reset password</a></p><p>This link expires in one hour. If you did not request a password reset, ignore this email.</p>`,
            ),
          });
        } catch {
          // Provider errors may contain the message body, including the reset token.
          console.error('auth.password_reset.email_delivery_failed');
        }
      },
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
      'https://api.benhalverson.dev',
      'https://race-forge.com',
      'https://luluspeedworks.com',
    ],
    advanced: {
      // Keep redirect validation enabled in integration tests as well as production.
      disableOriginCheck: false,
      defaultCookieAttributes: getCookieAttributes(baseURL),
      ...(executionCtx
        ? {
            backgroundTasks: {
              handler: (promise: Promise<unknown>) =>
                executionCtx.waitUntil(promise),
            },
          }
        : {}),
    },
    // Better Auth errors can include request data (e.g. rejected callback URLs).
    logger: {
      log: level => {
        console.error(`auth.${level}`);
      },
    },
    plugins: [
      openAPI(),
      organization({
        allowUserToCreateOrganization: false,
        organizationLimit: 1,
      }),
      passkey({
        rpID,
        rpName: env?.RP_NAME || '3D Printer Web API',
        ...(passkeyOrigin ? { origin: passkeyOrigin } : {}),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
