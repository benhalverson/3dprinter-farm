import { zValidator } from '@hono/zod-validator';
import factory from '../factory';
import { cart, addCartItemSchema } from '../db/schema';
import { and, eq } from 'drizzle-orm';

const shoppingCart = factory
	.createApp()
	.get('/cart', async (c) => {})
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

			})
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
