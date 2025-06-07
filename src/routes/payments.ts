import { Context } from 'hono';
import Stripe from 'stripe';
import { getPayPalAccessToken } from '../utils/payPalAccess';
import { authMiddleware } from '../utils/authMiddleware';
import factory from '../factory';
import { productsTable } from '../db/schema';
import { eq } from 'drizzle-orm';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const checkoutSchema = z.object({
			productId: z.string().min(1, 'Product ID is required'),
			quantity: z
				.number()
				.int()
				.positive('Quantity must be a positive integer'),
		})



const paymentsRouter = factory
	.createApp()
	// .post('/stripe/checkout', authMiddleware, async (c: Context) => {
	.post('/checkout', zValidator('json', checkoutSchema), async (c) => {
	// .post('/checkout',  async (c) => {
		const items = c.req.valid('json');
		// console.log('items type', Array.isArray(items));
		if (!Array.isArray(items) || items.length === 0) {
			return c.json({ error: 'No items provided' }, 400);
		}
		const line_items = [];

		for (const item of items) {
			const { productId, quantity } = item;
			if (!productId || !quantity) {
				return c.json({ error: 'Invalid item format' }, 400);
			}
			const [product] = await c.var.db
				.select()
				.from(productsTable)
				.where(eq(productsTable.id, productId));

			console.log('product', product);
			// if (!product) {
			// 	return c.json({ error: `Product not found: ${productId}` }, 404);
			// }

			const stripeClient = new Stripe(c.env.STRIPE_SECRET_KEY);
			const prices = await stripeClient.prices.list({
				product,
			});
			if (!prices.data.length) {
				return c.json(
					{ error: `No Stripe price found for product: ${productId}` },
					500
				);
			}
			line_items.push({ price: prices.data[0].id, quantity });
		}
		const stripeClient = new Stripe(c.env.STRIPE_SECRET_KEY);
		try {
			const session = await stripeClient.checkout.sessions.create({
				payment_method_types: ['card'],
				line_items,
				mode: 'payment',
				success_url: `${c.env.DOMAIN}/success`,
				cancel_url: `${c.env.DOMAIN}/cancel`,
			});
			return c.json(session);
		} catch (error) {
			return c.json({ status: 'Error', error });
		}
	})
	.get('/success', (c: Context) => {
		return c.json({ status: 'Success' });
	})
	.get('/cancel', (c: Context) => {
		return c.json({ status: 'Cancelled' });
	})
	.post('/paypal', async (c: Context) => {
		const qty = c.req.query('qty') || 1;
		const accessToken = await getPayPalAccessToken(c);

		const quantity = (+qty * 10).toFixed(2);

		const response = await fetch(
			'https://api-m.sandbox.paypal.com/v2/checkout/orders',
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
				},
				method: 'POST',
				body: JSON.stringify({
					intent: 'CAPTURE',
					purchase_units: [
						{
							amount: {
								currency_code: 'USD',
								value: quantity,
							},
						},
					],
				}),
			}
		);

		const data = (await response.json()) as any;
		return data;
	});
export default paymentsRouter;
