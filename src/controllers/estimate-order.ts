import { Context } from 'hono';
import { z } from 'zod';

import { BASE_URL } from '../constants';


export const estimateOrder = async (c: any) => {
	try {
		const data: OrderDto = orderSchema.parse(c.req.valid('json'));

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

		const result: OrderResponse = await response.json();
		return c.json(result);


	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json({ error: error.errors }, 400);
		}

		return c.json({ error: 'Failed to estimate order' }, 500);

	}

};


const orderSchema = z.object({
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
	}).uuid().trim(),
	filename: z.string().trim().optional(),
	fileURL: z.string().trim().url().optional(), // Assuming fileURL should be a valid URL
	bill_to_street_1: z.string().trim(),
	bill_to_street_2: z.string().trim().optional(),
	bill_to_street_3: z.string().trim().optional(),
	bill_to_city: z.string().trim(),
	bill_to_state: z.string().trim(),
	bill_to_zip: z.string().trim(),
	bill_to_country_as_iso: z.string(),
	bill_to_is_US_residential: z.boolean(), // Changed to boolean for consistency
	ship_to_name: z.string(),
	ship_to_street_1: z.string(),
	ship_to_street_2: z.string().optional(),
	ship_to_street_3: z.string().optional(),
	ship_to_city: z.string(),
	ship_to_state: z.string(),
	ship_to_zip: z.string(),
	ship_to_country_as_iso: z.string(),
	ship_to_is_US_residential: z.boolean(), // Changed to boolean for consistency
	order_item_name: z.string(),
	order_quantity: z.number().int(), // Changed to number for consistency
	order_image_url: z.string().url().optional(), // Assuming order_image_url should be a valid URL
	order_sku: z.string(),
	order_item_color: z.string().optional(),
}).strict();



export type OrderData = {
	email: string;
	phone: string;
	name: string;
	orderNumber: string;
	filename: string;
	fileURL: string;
	bill_to_street_1: string;
	bill_to_street_2: string;
	bill_to_street_3: string;
	bill_to_city: string;
	bill_to_state: string;
	bill_to_zip: string;
	bill_to_country_as_iso: string;
	bill_to_is_US_residential: string;
	ship_to_name: string;
	ship_to_street_1: string;
	ship_to_street_2: string;
	ship_to_street_3: string;
	ship_to_city: string;
	ship_to_state: string;
	ship_to_zip: string;
	ship_to_country_as_iso: string;
	ship_to_is_US_residential: string;
	order_item_name: string;
	order_quantity: string;
	order_image_url: string;
	order_sku: string;
	order_item_color: string;
};

export type OrderDto = z.infer<typeof orderSchema>;

export type OrderResponse =
	{
		"totalPrice": number;
	};
