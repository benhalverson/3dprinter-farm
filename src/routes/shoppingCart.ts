import { zValidator } from '@hono/zod-validator';
import factory from '../factory';
import { cart, addCartItemSchema } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { describeRoute } from 'hono-openapi';

import { z } from 'zod';

const shoppingCart = factory
	.createApp()
	.get(
		'/cart',
		describeRoute({
			description: 'Get shopping cart items',
			tags: ['Shopping Cart'],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: z.object({
								foo: z.string(),
							}),
						},
					},
					description: 'foo response',
				},
    },
		}),
		async (c) => {
			return c.json({
				message: 'Get shopping cart items',
			});
		}
	)
	.post('/cart/add', zValidator('json', addCartItemSchema), async (c) => {
		const { cartId, skuNumber, quantity, color, filamentType } =
			c.req.valid('json');
		const existing = await c.var.db.query.cart.findFirst({
			where: and(
				// eq(cart.cartId, cartId ),
				// eq(cart.skuNumber, skuNumber),
				eq(cart.color, color)
			),
		});

		if (existing) {
			await c.var.db
				.update(cart)
				.set({
					quantity: existing.quantity + quantity,
				})
				.where(eq(cart.id, existing.id));
		} else {
			await c.var.db.insert(cart).values({
				cartId,
				productId: skuNumber,
				quantity,
				color,
				filamentType,
			});
		}

		return c.json("message: 'Add cart item',");
	})
	.put('/cart/update', async (c) => {
		return c.json({ message: 'Update cart item' });
	})
	.delete('/cart/remove', async (c) => {
		return c.json({ message: 'Remove cart item' });
	});

export default shoppingCart;
