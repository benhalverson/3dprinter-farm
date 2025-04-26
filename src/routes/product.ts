import { ZodError } from 'zod';
import { eq } from 'drizzle-orm';
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

const product = factory.createApp()
	.get('/products', async (c) => {
		const response = await c.var.db.select().from(productsTable).all();
		return c.json(response);
	})
	.use('/add-product', authMiddleware)
	.use('/update-product', authMiddleware)
	.post('/add-product', async (c) => {
		const user = c.get('jwtPayload') as { id: number; email: string };
		if (!user) return c.json({ error: 'Unauthorized' }, 401);
		const data = await c.req.json();
		const parsedData: ProductData = addProductSchema.parse(data);
		const skuNumber = generateSkuNumber(parsedData.name, parsedData.color);

		const slicingResponse = await fetch(`${BASE_URL}slicer`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'api-key': c.env.SLANT_API,
			},
			body: JSON.stringify({ fileURL: parsedData.stl, sku_number: skuNumber }),
		});

		if (!slicingResponse.ok) {
			const error = (await slicingResponse.json()) as Error;
			return c.json({ error: 'Failed to slice file', details: error.message }, 500);
		}

		const slicingResult = (await slicingResponse.json()) as {
			data: { price: number };
		};
		const basePrice = slicingResult.data.price;
		const markupPrice = calculateMarkupPrice(basePrice, parsedData.price);

		const productDataToInsert = {
			...parsedData,
			price: markupPrice,
			skuNumber: skuNumber,
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
	})
	.get('/product/:id', async (c) => {
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
	})
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
	})

export default product;
