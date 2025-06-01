import { ZodError } from 'zod';
import { eq } from 'drizzle-orm';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware } from '../utils/authMiddleware';
import {
	addProductSchema,
	idSchema,
	ProductData,
	productsTable,
	updateProductSchema,
} from '../db/schema';
import { generateSkuNumber } from '../utils/generateSkuNumber';
import { BASE_URL } from '../constants';
import { calculateMarkupPrice } from '../utils/calculateMarkupPrice';
import factory from '../factory';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import Stripe from 'stripe';

const product = factory
	.createApp()
	.get('/products', async (c) => {
		const response = await c.var.db.select().from(productsTable).all();
		return c.json(response);
	})
	.use('/add-product', authMiddleware)
	.use('/update-product', authMiddleware)
	.post(
		'/add-product',
		describeRoute({
			description: 'Add a new product',
			tags: ['Products'],
			requestBody: {
				content: {
					'application/json': {
						schema: resolver(addProductSchema),
					},
				},
				required: true,
			},
			responses: {
				201: {
					content: {
						'application/json': {
							schema: resolver(addProductSchema),
						},
					},
					description: 'The product was created successfully',
				},
				400: {
					content: {
						'application/json': {
							schema: resolver(addProductSchema),
						},
					},
					description: 'Missing or invalid parameters',
				},
			},
		}),
		zValidator('json', addProductSchema),
		async (c) => {
			const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
				telemetry: false,
			});
			const user = c.get('jwtPayload') as { id: number; email: string };
			if (!user) return c.json({ error: 'Unauthorized' }, 401);
			const data = await c.req.valid('json');
			const skuNumber = generateSkuNumber(data.name, data.color);

			const stripeProduct = await stripe.products.create({
				name: data.name,
				description: data.description,
				images: [data.image],
				shippable: true,
				metadata: {
					sku_number: skuNumber,
				},
			});

			const slicingResponse = await fetch(`${BASE_URL}slicer`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'api-key': c.env.SLANT_API,
				},
				body: JSON.stringify({ fileURL: data.stl, sku_number: skuNumber }),
			});

			if (!slicingResponse.ok) {
				const error = (await slicingResponse.json()) as Error;
				return c.json(
					{ error: 'Failed to slice file', details: error.message },
					500
				);
			}

			const slicingResult = (await slicingResponse.json()) as {
				data: { price: number };
			};
			const basePrice = slicingResult.data.price;
			const markupPrice = calculateMarkupPrice(basePrice, data.price);

			let stripePriceId = null;
			if (markupPrice) {
				const price = await stripe.prices.create({
					product: stripeProduct.id,
					unit_amount: Math.round(markupPrice * 100), // Stripe expects the amount in cents
					currency: 'usd',
				});
				stripePriceId = price.id;
			}

			const productDataToInsert = {
				...data,
				price: markupPrice,
				skuNumber: skuNumber,
				stripeProductId: stripeProduct.id,
				stripePriceId: stripePriceId,
			};

			try {
				const response = await c.var.db
					.insert(productsTable)
					.values(productDataToInsert)
					.returning();
				return c.json(response);
			} catch (error) {
				console.error('Error adding product', error);
				return c.json({ error: 'Failed to add product' }, 500);
			}
		}
	)
	.get(
		'/product/:id',

		async (c) => {
			const idParam = c.req.param('id');
			const parsedData = idSchema.parse({ id: Number(idParam) });
			const response = await c.var.db
				.select()
				.from(productsTable)
				.where(eq(productsTable.id, parsedData.id));
			const product = response[0];

			return product
				? c.json(product)
				: c.json({ error: 'Product not found' }, 404);
		}
	)
	.put('/update-product', async (c) => {
		try {
			const body = await c.req.json();
			const parsedData = updateProductSchema.parse(body);
			const updateResult = await c.var.db
				.update(productsTable)
				.set({
					name: parsedData.name,
					description: parsedData.description,
					price: parsedData.price,
					filamentType: parsedData.filamentType,
					color: parsedData.color,
					image: parsedData.image,
				})
				.where(eq(productsTable.id, parsedData.id));

			if (updateResult) {
				return c.json({
					success: true,
					message: 'Product updated successfully',
				});
			} else {
				return c.json({ error: 'Product not found or update failed' }, 404);
			}
		} catch (error) {
			if (error instanceof ZodError) {
				return c.json(
					{ error: 'Validation error', details: error.errors },
					400
				);
			}
			return c.json({ error: 'Internal Server Error' }, 500);
		}
	});

export default product;
