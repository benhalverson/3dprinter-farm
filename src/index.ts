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
import { cors } from 'hono/cors';
import { createOrder, getPayPalAccessToken } from './controllers/paypal';
import { drizzle } from 'drizzle-orm/d1';
import { ProductData, productsTable } from './db/schema';
import { eq } from 'drizzle-orm';
import { BASE_URL } from './constants';
import { generateSkuNumber } from './utils/generateSkuNumber';
import { generateOrderNumber } from './utils/generateOrderNumber';

const app = new Hono<{
	Bindings: Bindings;
}>();

const idSchema = z.object({
  id: z.number().int(),
});

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
app.use(cors({
	origin: '*'
}));


app.get('/products', async (c) => {
	const db = drizzle(c.env.DB);
	const response = await db.select().from(productsTable).all();
	return c.json(response);
});
app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

app.post('/upload', upload);

app.post('/slice', slice);

/**
 * Lists the available colors for the filament
 * @param filamentType The type of filament to list colors for (PLA or PETG)
 * @returns The list of colors for the filament
 */
app.get('/colors', colors);

app.post('/estimate', estimateOrder);
app.post('/add-product', async (c) => {
	const data = await c.req.json();
	const parsedData: ProductData = addProductSchema.parse(data);
	console.log('parsedData', parsedData);
	const skuNumber = generateSkuNumber(parsedData.name, parsedData.color);
	console.log('skuNumber', skuNumber);

	const slicingResponse = await fetch(`${BASE_URL}slicer`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'api-key': c.env.SLANT_API,
		},
		body: JSON.stringify({ fileURL: parsedData.stl, sku_number: skuNumber }),
	});

	if (!slicingResponse.ok) {
		const error = await slicingResponse.json() as Error;
		console.log('Error slicing the file', error.message);
		return c.json({ error: 'Failed to slice file', details: error.message }, 500);
	}

	const slicingResult = (await slicingResponse.json()) as any; //Type this properly
	const basePrice = slicingResult.data.price;
	console.log('basePrice', basePrice);
	const markUpPrice = basePrice + (basePrice * (parsedData.price / 100));
	console.log('markUpPrice', markUpPrice.toFixed(2));

	const productDataToInsert = {
		...parsedData,
		price: markUpPrice.toFixed(2),
		skuNumber: skuNumber,
	};
	try {
		const db = drizzle(c.env.DB);
		const response = await db
			.insert(productsTable)
			.values(productDataToInsert)
			.returning();
		return c.json(response);
	} catch (error) {
		console.error('Error adding product', error);
	}

	return c.json({ error: 'Failed to add product' }, 500);
});

app.get('/product/:id', async (c) => {
	const idParam = c.req.param('id');
	const parsedData = idSchema.parse({ id: Number(idParam) });
	const db = drizzle(c.env.DB);
	const response = await db
		.select()
		.from(productsTable)
		.where(eq(productsTable.id, parsedData.id));
	const product = response[0];

	return product
		? c.json(product)
		: c.json({ error: 'Product not found' }, 404);
});

app.get('/list', list);

app.get('/success', success);

app.get('/cancel', cancel);

app.get('/checkout', checkout);
app.post('/paypal', createOrder);
app.get('/paypal-auth', async (c) => {
	const auth_test = await getPayPalAccessToken(c);
	console.log(auth_test);
	return c.text('success');
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
	DB: D1Database;
};

// Schema for adding a new product to the products table
const addProductSchema = z
	.object({
		id: z.number().optional(),
		name: z.string(),
		description: z.string(),
		image: z.string(),
		stl: z.string(),
		price: z.number(),
		filamentType: z.string(),
		color: z.string(),
		skuNumber: z.string(),
	})
	// .omit({ id: true });
	.omit({ id: true, skuNumber: true });
