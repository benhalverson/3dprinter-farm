import { Context } from 'hono';
import { BASE_URL } from '../constants';

export const estimateOrder = async (c: Context) => {
	const data = await c.req.json();
	console.log(JSON.stringify(data));
	const response = await fetch(`${BASE_URL}order/estimate`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'api-key': c.env.SLANT_API,
		},
		body: JSON.stringify(
			data
		)

	});

	if (!response.ok) {
		const error = await response.json();
		return c.json({ error: 'Failed to estimate order', details: error }, 500);
	}

	const result = await response.json() as any;
	return c.json(result);
};
