import { Scalar } from '@scalar/hono-api-reference';
import { createAuth } from '../lib/auth';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { openAPISpecs } from 'hono-openapi';
import factory from './factory';
import auth from './routes/auth';
import email from './routes/email';
import paymentsRouter from './routes/payments';
import printer from './routes/printer';
import product from './routes/product';
import shoppingCart from './routes/shoppingCart';
import userRouter from './routes/users';
import webhookRoutes from './routes/webhooks';
import { authMiddleware } from './utils/authMiddleware';

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
