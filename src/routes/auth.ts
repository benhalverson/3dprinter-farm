import { createAuth } from '../../lib/auth';
import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { signInSchema, signUpSchema } from '../db/schema';
import factory from '../factory';
import { rateLimit } from '../utils/rateLimit';

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

const signOutHandler = async (c: Context<{ Bindings: Env }>) => {
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
              schema: resolver(z.object({ error: z.string() })),
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
        const result = await betterAuth.api.signUpEmail({
          body: { email, password, name: displayName },
          headers: c.req.raw.headers,
        });

        const signInResponse = await betterAuth.handler(
          new Request(new URL('/api/auth/sign-in/email', c.req.url), {
            method: 'POST',
            headers: new Headers({
              'content-type': 'application/json',
              origin: c.req.header('origin') || new URL(c.req.url).origin,
            }),
            body: JSON.stringify({ email, password }),
          }),
        );

        const response = c.json(
          {
            success: true,
            message: 'User created successfully',
            user: result.user,
          },
          200,
        );

        const setCookie = signInResponse.headers.get('set-cookie');
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
              schema: resolver(z.object({ message: z.string() })),
            },
          },
          description: 'The user was authenticated successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: resolver(z.object({ error: z.string() })),
            },
          },
          description: 'Missing or invalid parameters',
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

        const body = (await authResponse.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const response = c.json({
          message: 'signin success',
          ...body,
        });

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
