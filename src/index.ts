import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import authMiddleware from './utils/authMiddleware';
import auth from './routes/auth';
import product from './routes/product';
import passKeyAuth from './routes/passKeyAuth';
import userRouter from './routes/users';
import paymentsRouter from './routes/payments';
import printer from './routes/printer';
import factory from './factory';

const app = factory.createApp()
  .use(async (c, next) => {
		c.set('db', drizzle(c.env.DB, { schema }))
		await next()
	})
  .use(logger())
  .use(
  	cors({
  		origin: [
  			'http://localhost:3000',
  			'http://localhost:4200',
  			'https://rc-store.benhalverson.dev',
  			'https://rc-admin.pages.dev',
  		],
  		credentials: true,
  		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  	})
  )
  .get('/health', (c) => c.json({ status: 'ok' }))
  .route('/checkout', paymentsRouter)
  .route('/auth', auth)
	.use('/product', authMiddleware)
	.route('/', product)
	.route('/', passKeyAuth)
	.route('/', userRouter)
	.route('/', printer)
;

export default app;
export type App = typeof app;