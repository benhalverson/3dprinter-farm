import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { authMiddleware } from './utils/authMiddleware';
import { Bindings } from './types';
import auth from './routes/auth';
import product from './routes/product';
import passKeyAuth from './routes/passKeyAuth';
import userRouter from './routes/users';
import paymentsRouter from './routes/payments';
import printer from './routes/printer';

const app = new Hono<{
	Bindings: Bindings;
}>();

app.use(logger());
app.use(
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
);

app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});



app.route('/checkout', paymentsRouter);
app.route('/auth', auth);

app
	.use('/product', authMiddleware)
	.route('/', product)
	.route('/', passKeyAuth)
	.route('/', userRouter)
	.route('/', printer);

export default app;
