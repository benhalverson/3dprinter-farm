import { Scalar } from '@scalar/hono-api-reference';
import { createAuth } from '../lib/auth';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { openAPISpecs } from 'hono-openapi';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import factory from './factory';
import auth from './routes/auth';
import email from './routes/email';
import paymentsRouter from './routes/payments';
import printer from './routes/printer';
import product from './routes/product';
import shoppingCart from './routes/shoppingCart';
import { z } from 'zod';
import userRouter from './routes/users';
import webhookRoutes from './routes/webhooks';
import { authMiddleware } from './utils/authMiddleware';

function hasPasskeyCredentialId(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }

  const response =
    'response' in body && body.response && typeof body.response === 'object'
      ? body.response
      : null;

  if (!response) {
    return false;
  }

  return (
    ('id' in response && typeof response.id === 'string' && response.id.length > 0) ||
    ('rawId' in response &&
      typeof response.rawId === 'string' &&
      response.rawId.length > 0)
  );
}

const app = factory
  .createApp()
  .use(logger())
  .use(
    cors({
      origin: [
        'http://localhost:3000',
        'http://localhost:4200',
        'http://localhost:8787',
        'https://rc-store.benhalverson.dev',
        'https://rc-admin.pages.dev',
        'https://race-forge.com',
      ],
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  )
  .get('/health', c => c.json({ status: 'ok' }))
  .post(
    '/api/auth/passkey/verify-registration',
    describeRoute({
      description:
        'Validate a WebAuthn registration response and register a new passkey for the authenticated user.',
      tags: ['Auth'],
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: 'The passkey was registered successfully.',
          content: {
            'application/json': {
              schema: resolver(z.record(z.any())),
            },
          },
        },
        400: {
          description: 'The passkey registration payload is invalid.',
          content: {
            'application/json': {
              schema: resolver(
                z.object({
                  message: z.string(),
                  code: z.string(),
                  details: z.string(),
                }),
              ),
            },
          },
        },
      },
    }),
    async c => {
    const body = await c.req.json().catch(() => null);

    if (!hasPasskeyCredentialId(body)) {
      return c.json(
        {
          message: 'Failed to verify registration',
          code: 'FAILED_TO_VERIFY_REGISTRATION',
          details: 'Missing credential ID',
        },
        400,
      );
    }

    return createAuth(c.env.DB, c.env).handler(c.req.raw);
    },
  )
  .on(['GET', 'POST'], '/api/auth/*', c =>
    createAuth(c.env.DB, c.env).handler(c.req.raw),
  )
  .route('/auth', auth)
  .use('/product', authMiddleware)
  .route('/', product)
  .route('/', userRouter)
  .route('/', printer)
  .route('/', email)
  .route('/', paymentsRouter)
  .route('/', shoppingCart)
  .route('/', webhookRoutes);

app.get(
  '/open-api',
  openAPISpecs(app, {
    documentation: {
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'better-auth.session_token',
          },
        },
      },
      security: [{ cookieAuth: [] }],
      info: { title: 'Heyo', version: '1.0.0' },
    },
  }),
);
app.get(
  '/docs',
  Scalar({
    url: '/open-api',
    theme: 'fastify',
  }),
);
export default app;
export type App = typeof app;
