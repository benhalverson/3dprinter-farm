import { Context, Hono } from 'hono';
import Stripe from 'stripe';
import { Bindings } from '../types';
import { getPayPalAccessToken } from '../utils/payPalAccess';
import { authMiddleware } from '../utils/authMiddleware';

const paymentsRouter = new Hono<{ Bindings: Bindings }>();

paymentsRouter.get('/checkout', authMiddleware, async (c: Context) => {
	const quantity = c.req.query('qty');

	const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
	try {
		const session = await stripe.checkout.sessions.create({
			payment_method_types: ['card'],
			line_items: [
				{
					price: c.env.STRIPE_PRICE_ID,
					quantity: 1,
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

paymentsRouter.get('/success', (c: Context) => {
	return c.json({ status: 'Success' });
});

paymentsRouter.get('/cancel', (c: Context) => {
	return c.json({ status: 'Cancelled' });
});

paymentsRouter.post('/paypal', async (c: Context) => {
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
	console.log(data);
	return data;
});

export default paymentsRouter;
