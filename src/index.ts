/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Context, Hono } from 'hono';
import { logger } from 'hono/logger';
import { colors } from './controllers/filament';
import { slice } from './controllers/slice';
import { estimateOrder } from './controllers/estimate-order';
import { upload } from './controllers/upload';
import { z } from 'zod';
import { list } from './controllers/list';
import { cancel, checkout, success } from './controllers/stripe';

const app = new Hono<{
	Bindings: Bindings;
}>();

const orderSchema = z.object({
	email: z.string().email(), // Assuming email should be a valid email string
	phone: z.string(),
	name: z.string(),
	orderNumber: z.string(),
	filename: z.string(),
	fileURL: z.string().url(), // Assuming fileURL should be a valid URL
	bill_to_street_1: z.string(),
	bill_to_street_2: z.string(),
	bill_to_street_3: z.string(),
	bill_to_city: z.string(),
	bill_to_state: z.string(),
	bill_to_zip: z.string(),
	bill_to_country_as_iso: z.string(),
	bill_to_is_US_residential: z.string(),
	ship_to_name: z.string(),
	ship_to_street_1: z.string(),
	ship_to_street_2: z.string(),
	ship_to_street_3: z.string(),
	ship_to_city: z.string(),
	ship_to_state: z.string(),
	ship_to_zip: z.string(),
	ship_to_country_as_iso: z.string(),
	ship_to_is_US_residential: z.string(),
	order_item_name: z.string(),
	order_quantity: z.string(),
	order_image_url: z.string().url(), // Assuming order_image_url should be a valid URL
	order_sku: z.string(),
	order_item_color: z.string(),
}).strict();


app.use(logger());

app.get('/', (c) => {
	return c.text('Hello, world!');
});
app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

app.post('/upload', upload);

app.post('/slice', slice);

app.get('/colors', colors);

app.post('/estimate', estimateOrder);

app.get('/list', list);

app.get('/success', success);

app.get('/cancel', cancel);

app.get('/checkout', checkout);

export default app;

type Bindings = {
	BUCKET: R2Bucket;
	SLANT_API: string;
	STRIPE_PUBLISHABLE_KEY: string;
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	STRIPE_PRICE_ID: string;
	DOMAIN: string;
};
