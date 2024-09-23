import { Context } from 'hono';
import { Buffer } from 'node:buffer';

export const getPayPalAccessToken = async (c: Context) => {
	const auth = Buffer.from(`${c.env.PAYPAL_CLIENT_ID}:${c.env.PAYPAL_SECRET}`).toString('base64');
	console.log('auth', auth);

	const payload = {
		grant_type: 'client_credentials',
	};
	const response = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
		headers: {
			// CLIENT_ID: c.env.CLIENT_SECRET,
			'Authorization': `Basic ${auth}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		method: 'POST',
		body: JSON.stringify(payload),
	});

	const data = await response.json() as any;
	console.log(data);
	return data.access_token;
};

export const createOrder = async (c: Context) => {
	const qty = c.req.query('qty') || 1;
	const accessToken = await getPayPalAccessToken(c);

	const quantity = (+qty * 10).toFixed(2);

	const response = await fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', {
		headers: {
			'Authorization': `Bearer ${accessToken}`,
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
	});

	const data = await response.json() as any;
	console.log(data);
	return data;
};
