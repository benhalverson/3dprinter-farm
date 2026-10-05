import { Scalar } from '@scalar/hono-api-reference';
import { openAPISpecs } from 'hono-openapi';
import factory from './factory';
import checkoutQuotes from './routes/checkoutQuotes';
import { browserCors, browserOriginGuard, privateResponseCache } from './utils/browserSecurity';
import adminOrders from './routes/adminOrders';
import auth from './routes/auth';
import authApi from './routes/authApi';
import ordersRouter from './routes/orders';
import paymentsRouter from './routes/payments';
import printer from './routes/printer';
import product from './routes/product';
import productDrafts from './routes/productDrafts';
import productV2 from './routes/productV2';
import shoppingAgent from './routes/shoppingAgent';
import shoppingCart from './routes/shoppingCart';
import squareCatalog from './routes/squareCatalog';
import userRouter from './routes/users';
import { requestLogger } from './utils/requestLogger';
import { validateBindings } from './utils/validateBindings';

const app = factory
  .createApp()
  /** Preserves route-specific JSON failures without hiding mounted OpenAPI metadata. */
  .onError((error, c) => {
    if (c.req.path === '/cart/shipping') {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'Failed to retrieve shipping estimate' }, 500);
    }
    // Draft middleware owns the structured log and JSON response. Keep the
    // handler on the parent so mounted OpenAPI metadata remains discoverable.
    if (/^\/admin\/product-drafts(?:\/|$)/.test(c.req.path))
      return c.json({ error: 'Product draft request failed' }, 500);
    if ('getResponse' in error && typeof error.getResponse === 'function') {
      const response = error.getResponse();
      return c.newResponse(response.body, response);
    }
    console.error(error);
    return c.text('Internal Server Error', 500);
  })
  .use(requestLogger)
  .use(privateResponseCache)
  .use(browserOriginGuard)
  .use(browserCors)
  .get('/health', c => {
    try {
      validateBindings(c.env as Record<string, unknown>);
      return c.json({ status: 'ok' });
    } catch (e) {
      return c.json({ status: 'error', message: (e as Error).message }, 503);
    }
  })
  .route('/api/auth', authApi)
  .route('/auth', auth)
  .route('/agent', shoppingAgent)
  .route('/admin/product-drafts', productDrafts)
  .route('/', product)
  .route('/', productV2)
  .route('/', squareCatalog)
  .route('/', userRouter)
  .route('/', printer)
  .route('/', paymentsRouter)
  .route('/', shoppingCart)
  .route('/', checkoutQuotes)
  .route('/', ordersRouter)
  .route('/', adminOrders);

app.get(
  '/open-api',
  openAPISpecs(app, {
    documentation: {
      components: {
        securitySchemes: {
          agentCapability: { type: 'http', scheme: 'bearer' },
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
