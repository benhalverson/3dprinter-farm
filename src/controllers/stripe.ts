import { Context } from 'hono';

import Stripe from 'stripe';
export const checkout = async (c: Context) => {
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
}


export const success = (c: Context) => {
	return c.json({ status: 'Success' });
}

export const cancel = (c: Context) => {
	return c.json({ status: 'Cancelled' });
}
