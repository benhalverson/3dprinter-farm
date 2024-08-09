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

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { colors } from './controllers/filament';
import { slice } from './controllers/slice';
import { estimateOrder } from './controllers/estimate-order';
import { upload } from './controllers/upload';
import { z } from 'zod';
import { list } from './controllers/list';
import Stripe from 'stripe';

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

app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

app.post('/upload', upload);

app.post('/slice', slice);

app.get('/colors', colors);

app.post('/estimate', estimateOrder);

app.get('/list', list);

app.get('/success', async (c) => {
	return c.json({ status: 'Success' });
});

app.get('/cancel', async (c) => {
	return c.json({ status: 'Cancelled' });
});

app.get('/webhook', async (c) => {
	const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
	const rawBody = await c.req.raw.text();
	const sig = c.req.header('stripe-signature');
	if (!sig) {
		return c.json({ error: 'No signature' }, 400);
	}
	const event = stripe.webhooks.constructEvent(rawBody, sig, c.env.STRIPE_WEBHOOK_SECRET);
	return c.json(event);

});

app.get('/checkout', async (c) => {
	const quantity = c.req.query('qty');

	const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
	try {
		const session = await stripe.checkout.sessions.create({
			payment_method_types: ['card'],
			line_items: [
				{
					price: c.env.STRIPE_PRICE_ID,
					quantity: 1
				},
			],
			mode: 'payment',
			success_url: `${c.env.DOMAIN}/success`,
			cancel_url: `${c.env.DOMAIN}/cancel`,
		});

		return c.json(session);
	} catch (error) {

		return c.json({ status: 'Error', error });

	}
});

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
