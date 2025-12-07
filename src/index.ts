import { Scalar } from '@scalar/hono-api-reference';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { openAPISpecs } from 'hono-openapi';
import factory from './factory';
import auth from './routes/auth';
import email from './routes/email';
import passKeyAuth from './routes/passKeyAuth';
import paymentsRouter from './routes/payments';
import printer from './routes/printer';
import product from './routes/product';
import shoppingCart from './routes/shoppingCart';
import userRouter from './routes/users';
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
  .route('/auth', auth)
  .use('/product', authMiddleware)
  .route('/', product)
  .route('/', passKeyAuth)
  .route('/', userRouter)
  .route('/', printer)
  .route('/', email)
  .route('/', paymentsRouter)
  .route('/', shoppingCart);

app.get(
  '/open-api',
  openAPISpecs(app, {
    documentation: {
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'token',
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
