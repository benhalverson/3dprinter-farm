import { ZodError, z } from 'zod';
import { eq, or, like, count } from 'drizzle-orm';
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

// Helper function to safely parse imageGallery JSON
function parseImageGallery(imageGallery: string | null): string[] {
	if (!imageGallery) return [];
	try {
		const parsed = JSON.parse(imageGallery);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

const product = factory
	.createApp()
	.get(
		'/products',
		describeRoute({
			description: 'Get all products with pagination',
			tags: ['Products'],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									products: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												id: { type: 'number' },
												name: { type: 'string' },
												description: { type: 'string' },
												image: { type: 'string' },
												imageGallery: {
													type: 'array',
													items: { type: 'string' }
												},
												stl: { type: 'string' },
												price: { type: 'number' },
												filamentType: { type: 'string' },
												skuNumber: { type: 'string' },
												color: { type: 'string' }
											}
										}
									},
									pagination: {
										type: 'object',
										properties: {
											page: { type: 'number' },
											limit: { type: 'number' },
											totalItems: { type: 'number' },
											totalPages: { type: 'number' },
											hasNextPage: { type: 'boolean' },
											hasPreviousPage: { type: 'boolean' }
										}
									}
								}
							}
						},
					},
					description: 'Paginated list of all products',
				},
				400: {
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									error: { type: 'string' }
								}
							}
						},
					},
					description: 'Invalid pagination parameters',
				},
			},
		}),
		async (c) => {
			const pageParam = c.req.query('page');
			const limitParam = c.req.query('limit');

			// Check if pagination is requested
			const isPaginationRequested = pageParam || limitParam;

			try {
				if (!isPaginationRequested) {
					// Return simple array for backward compatibility
					const rawProducts = await c.var.db
						.select({
							id: productsTable.id,
							name: productsTable.name,
							description: productsTable.description,
							image: productsTable.image,
							imageGallery: productsTable.imageGallery,
							stl: productsTable.stl,
							price: productsTable.price,
							filamentType: productsTable.filamentType,
							skuNumber: productsTable.skuNumber,
							color: productsTable.color,
						})
						.from(productsTable)
						.all();

					// Parse imageGallery safely
					const products = rawProducts.map(product => ({
						...product,
						imageGallery: parseImageGallery(product.imageGallery)
					}));

					return c.json(products);
				}

				// Parse pagination parameters
				const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1;
				const limit = limitParam ? Math.min(100, Math.max(1, parseInt(limitParam, 10))) : 10;
				const offset = (page - 1) * limit;

				// Validate pagination parameters
				if (isNaN(page) || isNaN(limit)) {
					return c.json({ error: 'Invalid pagination parameters. Page and limit must be numbers.' }, 400);
				}

				// Get total count for pagination
				const [totalCountResult] = await c.var.db
					.select({ count: count() })
					.from(productsTable);

				const totalItems = totalCountResult.count;
				const totalPages = Math.ceil(totalItems / limit);

				// Get paginated results without Stripe fields
				const rawProducts = await c.var.db
					.select({
						id: productsTable.id,
						name: productsTable.name,
						description: productsTable.description,
						image: productsTable.image,
						imageGallery: productsTable.imageGallery,
						stl: productsTable.stl,
						price: productsTable.price,
						filamentType: productsTable.filamentType,
						skuNumber: productsTable.skuNumber,
						color: productsTable.color,
					})
					.from(productsTable)
					.limit(limit)
					.offset(offset)
					.all();

				// Parse imageGallery safely
				const products = rawProducts.map(product => ({
					...product,
					imageGallery: parseImageGallery(product.imageGallery)
				}));

				const pagination = {
					page,
					limit,
					totalItems,
					totalPages,
					hasNextPage: page < totalPages,
					hasPreviousPage: page > 1
				};

				return c.json({
					products,
					pagination
				});
			} catch (error) {
				console.error('Error fetching products:', error);
				return c.json({ error: 'Failed to fetch products' }, 500);
			}
		}
	)
	.use('/products/search', authMiddleware)
	.get(
		'/products/search',
		describeRoute({
			description: 'Search products by name and description with pagination',
			tags: ['Products'],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									products: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												id: { type: 'number' },
												name: { type: 'string' },
												description: { type: 'string' },
												image: { type: 'string' },
												imageGallery: {
													type: 'array',
													items: { type: 'string' }
												},
												stl: { type: 'string' },
												price: { type: 'number' },
												filamentType: { type: 'string' },
												skuNumber: { type: 'string' },
												color: { type: 'string' }
											}
										}
									},
									pagination: {
										type: 'object',
										properties: {
											page: { type: 'number' },
											limit: { type: 'number' },
											totalItems: { type: 'number' },
											totalPages: { type: 'number' },
											hasNextPage: { type: 'boolean' },
											hasPreviousPage: { type: 'boolean' }
										}
									}
								}
							}
						},
					},
					description: 'Paginated list of products matching the search query',
				},
				400: {
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									error: { type: 'string' }
								}
							}
						},
					},
					description: 'Invalid search query or pagination parameters',
				},
			},
		}),
		async (c) => {
			const query = c.req.query('q');
			const pageParam = c.req.query('page');
			const limitParam = c.req.query('limit');

			if (!query) {
				return c.json({ error: 'Search query is required' }, 400);
			}

			if (query.trim().length < 2) {
				return c.json({ error: 'Search query must be at least 2 characters long' }, 400);
			}

			// Parse pagination parameters
			const page = pageParam ? Math.max(1, parseInt(pageParam, 10)) : 1;
			const limit = limitParam ? Math.min(100, Math.max(1, parseInt(limitParam, 10))) : 10;
			const offset = (page - 1) * limit;

			// Validate pagination parameters
			if (isNaN(page) || isNaN(limit)) {
				return c.json({ error: 'Invalid pagination parameters. Page and limit must be numbers.' }, 400);
			}

			try {
				const searchTerm = `%${query.trim()}%`;
				const whereClause = or(
					like(productsTable.name, searchTerm),
					like(productsTable.description, searchTerm)
				);

				// Get total count for pagination
				const [totalCountResult] = await c.var.db
					.select({ count: count() })
					.from(productsTable)
					.where(whereClause);

				const totalItems = totalCountResult.count;
				const totalPages = Math.ceil(totalItems / limit);

				// Get paginated results
				const rawProducts = await c.var.db
					.select({
						id: productsTable.id,
						name: productsTable.name,
						description: productsTable.description,
						image: productsTable.image,
						imageGallery: productsTable.imageGallery,
						stl: productsTable.stl,
						price: productsTable.price,
						filamentType: productsTable.filamentType,
						skuNumber: productsTable.skuNumber,
						color: productsTable.color,
					})
					.from(productsTable)
					.where(whereClause)
					.limit(limit)
					.offset(offset)
					.all();

				// Parse imageGallery safely
				const products = rawProducts.map(product => ({
					...product,
					imageGallery: parseImageGallery(product.imageGallery)
				}));

				const pagination = {
					page,
					limit,
					totalItems,
					totalPages,
					hasNextPage: page < totalPages,
					hasPreviousPage: page > 1
				};

				return c.json({
					products,
					pagination
				});
			} catch (error) {
				console.error('Error searching products:', error);
				return c.json({ error: 'Failed to search products' }, 500);
			}
		}
	)
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
				console.log('slicing error', error);
				return c.json(
					{ error: 'Failed to slice file', details: error.message },
					500
				);
			}

			const slicingResult = (await slicingResponse.json()) as {
				data: { price: number };
			};
			console.log('slicing result', slicingResult);
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

			console.log('data.imageGallery before insertion', data.imageGallery);
			const productDataToInsert = {
				...data,
				price: markupPrice,
				skuNumber: skuNumber,
				stripeProductId: stripeProduct.id,
				stripePriceId: stripePriceId,
				imageGallery: JSON.stringify(data.imageGallery || []),
			};

			console.log('Inserting product:', productDataToInsert);

			try {
				const response = await c.var.db
					.insert(productsTable)
					.values(productDataToInsert)
					.returning();
				console.log('response', response);
				return c.json(response);
			} catch (error) {
				console.error('Error adding product', error);
				return c.json({ error: 'Failed to add product' }, 500);
			}
		}
	)

	.get(
		'/product/:id',
		describeRoute({
			description: 'Get a product by ID',
			tags: ['Products'],
		}),
		async (c) => {
			const idParam = c.req.param('id');
			const parsedData = idSchema.parse({ id: Number(idParam) });
			const response = await c.var.db
				.select()
				.from(productsTable)
				.where(eq(productsTable.id, parsedData.id));
			const rawProduct = response[0];

			if (!rawProduct) {
				return c.json({ error: 'Product not found' }, 404);
			}

			// Parse imageGallery safely for individual product
			const product = {
				...rawProduct,
				imageGallery: parseImageGallery(rawProduct.imageGallery)
			};

			return c.json(product);
		}
	)
	.put('/update-product',
		describeRoute({
			description: 'Update an existing product',
			tags: ['Products'],
		}),
		async (c) => {
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
					imageGallery: JSON.stringify(parsedData.imageGallery || []),
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
				console.log('error', error);
				return c.json(
					{ error: 'Validation error', details: error.errors },
					400
				);
			}
			return c.json({ error: 'Internal Server Error' }, 500);
		}
	})
	.delete('/delete-product/:id', authMiddleware,
		describeRoute({
			description: 'Delete a product by ID',
			tags: ['Products'],
			parameters: [],
			responses: {
				200: {
					description: 'Product deleted successfully',
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									success: { type: 'boolean' },
									message: { type: 'string' }
								}
							}
						}
					},
				}
			}
		}),
		async (c) => {
		try {
			const idParam = c.req.param('id');
			const parsedData = idSchema.parse({ id: Number(idParam) });
			const deleteResult = await c.var.db
				.delete(productsTable)
				.where(eq(productsTable.id, parsedData.id));

			if (deleteResult) {
				return c.json({
					success: true,
					message: 'Product deleted successfully',
				});
			} else {
				return c.json({ error: 'Product not found or delete failed' }, 404);
			}
		} catch (error) {
			if (error instanceof ZodError) {
				console.log('error', error);
				return c.json(
					{ error: 'Validation error', details: error.errors },
					400
				);
			}
			return c.json({ error: 'Internal Server Error' }, 500);
		}
	});

export default product;
