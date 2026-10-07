import { authConfiguration } from '../src/config/auth';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { openAPI, organization } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../src/db/schema';
import { BROWSER_ORIGINS } from '../src/config/browserOrigins';
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

/** Creates the API-owned Better Auth instance with the shared browser origin policy. */
export function createAuth(
  database: Bindings['DB'],
  env?: AuthBindings,
) {
  const db = drizzle(database, { schema });
  const { baseURL, rpID, passkeyOrigin, secret, cookieAttributes } = authConfiguration(env);

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
    secret,
    baseURL,
    hooks: {
      before: createAuthMiddleware(async ctx => {
        if (ctx.path !== '/request-password-reset') return;
        // Better Auth 1.6 catches errors in its default await helper. Override
        // this request's helper so reset delivery failures reach the handler.
        ctx.context.runInBackgroundOrAwait = async promise => {
          await promise;
        };
      }),
    },
    emailAndPassword: {
      enabled: true,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        try {
          if (!env?.AUTH_EMAIL) throw new Error('Missing email binding');
          await env.AUTH_EMAIL.send({
            from: 'Lulu Speedworks <noreply@luluspeedworks.com>',
            to: user.email,
            subject: 'Reset your Lulu Speedworks password',
            text: `Reset your password: ${url}\n\nThis link expires in one hour. If you did not request a password reset, ignore this email.`,
          });
        } catch {
          // Provider errors may contain the message body, including the reset token.
          console.error('auth.password_reset.email_delivery_failed');
          throw new Error('Password reset email delivery failed');
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
    trustedOrigins: [...BROWSER_ORIGINS],
    advanced: {
      // Keep redirect validation enabled in integration tests as well as production.
      disableOriginCheck: false,
      defaultCookieAttributes: cookieAttributes,
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
