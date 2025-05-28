import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { authMiddleware } from './utils/authMiddleware';
import auth from './routes/auth';
import product from './routes/product';
import passKeyAuth from './routes/passKeyAuth';
import userRouter from './routes/users';
import paymentsRouter from './routes/payments';
import printer from './routes/printer';
import factory from './factory';
import email from './routes/email';
import shoppingCart from './routes/shoppingCart';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';

const docs = new OpenAPIHono();
const app = factory
	.createApp()
	.use(async (c, next) => {
		c.set('db', drizzle(c.env.DB, { schema }));
		await next();
	})
	.use(logger())
	.use(
		cors({
			origin: [
				'http://localhost:3000',
				'http://localhost:4200',
				'https://rc-store.benhalverson.dev',
				'https://rc-admin.pages.dev',
				'https://race-forge.com',
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
	.route('/', email)
	.route('/', shoppingCart);

const route = createRoute({
	method: 'get',
	path: '/health',

	responses: {
		200: {
			description: 'Successful response',
			// content: {
			// 	'application/json': {
			// 		schema: {
			// 			type: 'object',
			// 			properties: {
			// 				message: { type: 'string' },
			// 			},
			// 		},
			// 	},
			// },
		},
	},
});

docs.openapi(route, (c) => {
	return c.json({ message: 'Hello, world!' });
});

docs.doc('/doc', {
	openapi: '3.0.0',
	info: {
		version: '1.0.0',
		title: 'My API',
	},
});
export default app;
export type App = typeof app;
