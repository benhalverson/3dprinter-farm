import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { colors } from './controllers/filament';
import { slice, SliceResponse } from './controllers/slice';
import { estimateOrder } from './controllers/estimate-order';
import { upload } from './controllers/upload';
import { list } from './controllers/list';
import { cors } from 'hono/cors';
import { authMiddleware } from './utils/authMiddleware';
import { Bindings } from './types';
import auth from './routes/auth';
import product from './routes/product';
import passKeyAuth from './routes/passKeyAuth';
import userRouter from './routes/users';
import paymentsRouter from './routes/payments';

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

app.post('/upload', authMiddleware, upload);

app.post('/slice', authMiddleware, slice);

/**
 * Lists the available colors for the filament
 * @param filamentType The type of filament to list colors for (PLA or PETG)
 * @returns The list of colors for the filament
 */
app.get('/colors', colors);

app.post('/estimate', authMiddleware, estimateOrder);


app.get('/list', authMiddleware, list);

app.route('/checkout', paymentsRouter);
app.route('/auth', auth);

app.route('/', product);
app.route('/', passKeyAuth);
app.route('/', userRouter)

export default app;

