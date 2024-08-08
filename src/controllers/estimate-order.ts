import { Context } from 'hono';
import { z } from 'zod';

import { BASE_URL } from '../constants';


export const estimateOrder = async (c: Context) => {
	try {
		const data = await c.req.json();
		const parsedData: OrderData = orderSchema.parse(data);

		const response = await fetch(`${BASE_URL}order/estimate`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'api-key': c.env.SLANT_API,
			},
			body: JSON.stringify(parsedData)
		});

		if (!response.ok) {
			const error = await response.json();
			return c.json({ error: 'Failed to estimate order', details: error }, 500);
		}

		const result: OrderResponse = await response.json();
		return c.json(result);

	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json({ error: error.errors }, 400);
		}
		return c.json({ error: 'Failed to estimate order' }, 500);
	}
};

export const orderSchema = z.object({
	email: z.string().email({
		message: 'Invalid email format',
	}).email().min(5).trim(),
	phone: z.string({
		required_error: 'Phone number is required',
		invalid_type_error: 'Phone number should be a string',
	}).trim().toLowerCase(),
	name: z.string({
		required_error: 'Name is required',
	}).trim(),
	orderNumber: z.string({
		required_error: 'Order number is required'
	}).trim(),
	filename: z.string().trim(),
	fileURL: z.string().trim().url(),
	bill_to_street_1: z.string().trim(),
	bill_to_street_2: z.string().trim().optional(),
	bill_to_street_3: z.string().trim().optional(),
	bill_to_city: z.string().trim(),
	bill_to_state: z.string().trim(),
	bill_to_zip: z.string().trim(),
	bill_to_country_as_iso: z.string(),
	bill_to_is_US_residential: z.string(),
	ship_to_name: z.string(),
	ship_to_street_1: z.string(),
	ship_to_street_2: z.string().optional(),
	ship_to_street_3: z.string().optional(),
	ship_to_city: z.string(),
	ship_to_state: z.string(),
	ship_to_zip: z.string(),
	ship_to_country_as_iso: z.string(),
	ship_to_is_US_residential: z.string(),
	order_item_name: z.string(),
	order_quantity: z.string(),
	order_image_url: z.string().url().optional(),
	order_sku: z.string(),
	order_item_color: z.string().optional(),
}).strict();

export type OrderData = z.infer<typeof orderSchema>;

export type OrderResponse = {
	totalPrice: number;
};
