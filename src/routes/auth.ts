import { createAuth } from '../../lib/auth';
import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { signInSchema, signUpSchema } from '../db/schema';
import factory from '../factory';
import { rateLimit } from '../utils/rateLimit';

const authErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

const signInSuccessSchema = z.object({
  message: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.string(),
  }),
});

async function readAuthResponseBody(response: Response) {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!body || Array.isArray(body)) {
    return {};
  }

  return body;
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function getSafeUser(body: Record<string, unknown>) {
  const user = body.user;

  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    return null;
  }

  const record = user as Record<string, unknown>;

  if (
    typeof record.id !== 'string' ||
    typeof record.email !== 'string' ||
    typeof record.name !== 'string'
  ) {
    return null;
  }

  return {
    id: record.id,
    email: record.email,
    name: record.name,
    role: typeof record.role === 'string' ? record.role : 'user',
  };
}

const signOutRouteDescription = describeRoute({
  description: 'User signout endpoint',
  tags: ['Auth'],
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(z.object({ message: z.string() })),
        },
      },
      description: 'The current session was cleared successfully',
    },
  },
});

const signOutHandler = async (c: Context) => {
  const betterAuth = createAuth(c.env.DB, c.env);
  const authResponse = await betterAuth.handler(
    new Request(new URL('/api/auth/sign-out', c.req.url), {
      method: 'POST',
      headers: c.req.raw.headers,
    }),
  );

  const response = c.json({ message: 'signout success' });
  const setCookie = authResponse.headers.get('set-cookie');
  if (setCookie) {
    response.headers.set('set-cookie', setCookie);
  }
  return response;
};

const auth = factory
  .createApp()
  .post(
    '/signup',
    describeRoute({
      description: 'User signup endpoint',
      tags: ['Auth'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(
                z.object({
                  success: z.boolean(),
                  message: z.string(),
                  user: z.any().optional(),
                }),
              ),
            },
          },
          description: 'The user was created successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: resolver(authErrorSchema),
            },
          },
          description: 'Missing or invalid parameters',
        },
      },
    }),
    rateLimit({
      windowSeconds: 60,
      maxRequests: 3,
      keyPrefix: 'signup',
    }),
    zValidator('json', signUpSchema.extend({ name: z.string().optional() })),
    async c => {
      const betterAuth = createAuth(c.env.DB, c.env);
      const { email, password, name } = c.req.valid('json');
      const displayName = name || email.split('@')[0] || 'User';

      try {
        const signUpResponse = await betterAuth.handler(
          new Request(new URL('/api/auth/sign-up/email', c.req.url), {
            method: 'POST',
            headers: new Headers({
              'content-type': 'application/json',
              origin: c.req.header('origin') || new URL(c.req.url).origin,
            }),
            body: JSON.stringify({ email, password, name: displayName }),
          }),
        );

        const signUpBody = await readAuthResponseBody(signUpResponse);

        if (!signUpResponse.ok) {
          return jsonResponse(
            Object.keys(signUpBody).length > 0
              ? signUpBody
              : { error: 'Failed to create user' },
            signUpResponse.status,
          );
        }

        const response = c.json(
          {
            success: true,
            message: 'User created successfully',
            user: signUpBody.user,
          },
          200,
        );

        const setCookie = signUpResponse.headers.get('set-cookie');
        if (setCookie) {
          response.headers.set('set-cookie', setCookie);
        }

        return response;
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error ? error.message : 'Failed to create user',
          },
          400,
        );
      }
    },
  )
  .post(
    '/signin',
    describeRoute({
      description: 'User signin endpoint',
      tags: ['Auth'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: resolver(signInSuccessSchema),
            },
          },
          description: 'The user was authenticated successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: resolver(authErrorSchema),
            },
          },
          description: 'Missing or invalid parameters',
        },
        401: {
          content: {
            'application/json': {
              schema: resolver(authErrorSchema),
            },
          },
          description: 'Invalid credentials',
        },
        502: {
          content: {
            'application/json': {
              schema: resolver(authErrorSchema),
            },
          },
          description: 'The auth provider returned an invalid signin response',
        },
      },
    }),
    zValidator('json', signInSchema),
    async c => {
      const betterAuth = createAuth(c.env.DB, c.env);
      const { email, password } = c.req.valid('json');

      try {
        const authResponse = await betterAuth.handler(
          new Request(new URL('/api/auth/sign-in/email', c.req.url), {
            method: 'POST',
            headers: new Headers({
              'content-type': 'application/json',
              origin: c.req.header('origin') || new URL(c.req.url).origin,
            }),
            body: JSON.stringify({ email, password }),
          }),
        );

        const body = await readAuthResponseBody(authResponse);

        if (!authResponse.ok) {
          return jsonResponse(
            Object.keys(body).length > 0 ? body : { error: 'Signin failed' },
            authResponse.status,
          );
        }

        const safeUser = getSafeUser(body);

        if (!safeUser) {
          return c.json(
            {
              error: 'Invalid auth response',
              details: 'Missing or malformed user in auth provider response',
            },
            502,
          );
        }

        const responseBody = {
          message: 'signin success',
          user: safeUser,
        };

        const response = c.json(responseBody, 200);

        const setCookie = authResponse.headers.get('set-cookie');
        if (setCookie) {
          response.headers.set('set-cookie', setCookie);
        }

        return response;
      } catch (error) {
        return c.json(
          {
            error: 'Internal Server Error',
            details: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    },
  )
  .get('/signout', signOutRouteDescription, signOutHandler)
  .post('/signout', signOutRouteDescription, signOutHandler);

export default auth;
