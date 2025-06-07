import { zValidator } from '@hono/zod-validator';
import factory from '../factory';
import { cart, productsTable } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import Stripe from 'stripe';
import { z } from 'zod';

// Schemas
const CartItemSchema = z.object({
	id: z.number(),
	cartId: z.string(),
	skuNumber: z.string(),
	quantity: z.number(),
	color: z.string(),
	filamentType: z.string(),
});

const AddCartItemSchema = z.object({
	cartId: z.string(),
	skuNumber: z.string(),
	quantity: z.number().min(1),
	color: z.string(),
	filamentType: z.string(),
});

const UpdateCartItemSchema = z.object({
	cartId: z.string(),
	skuNumber: z.string(),
	color: z.string(),
	quantity: z.number().min(1),
});

const RemoveCartItemSchema = z.object({
	cartId: z.string(),
	skuNumber: z.string(),
	color: z.string(),
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const shoppingCart = factory.createApp()

	// ✅ GET /cart
	.get(
		'/cart',
		describeRoute({
			method: 'get',
			tags: ['Cart'],
			description: 'Get all items in the cart',
			query: z.object({ cartId: z.string() }),
			responses: {
				200: {
					description: 'List of cart items',
					content: {
						'application/json': {
							schema: z.object({
								items: z.array(CartItemSchema),
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const cartId = c.req.query('cartId');
			const cartItems = await c.var.db.select().from(cart).where(eq(cart.cartId, Number(cartId)));
			return c.json({ items: cartItems });
		}
	)

	// ✅ GET /cart/total
	.get(
		'/cart/total',
		describeRoute({
			method: 'get',
			tags: ['Cart'],
			description: 'Get subtotal and item count for a cart',
			query: z.object({ cartId: z.string() }),
			responses: {
				200: {
					description: 'Cart total',
					content: {
						'application/json': {
							schema: z.object({
								subtotal: z.number(),
								itemCount: z.number(),
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const cartId = c.req.query('cartId');
			const cartItems = await c.var.db.select().from(cart).where(eq(cart.cartId, Number(cartId)));


			let subtotal = 0;
			for (const item of cartItems) {
				const [product] = await c.var.db
					.select({ price: productsTable.price })
					.from(productsTable)
					.where(eq(productsTable.skuNumber, item.skuNumber));

					console.log('Product:', product);

				if (product?.price) {
					subtotal += product.price * item.quantity;
				}
			}

			return c.json({
				subtotal,
				itemCount: cartItems.reduce((acc, i) => acc + i.quantity, 0),
			});
		}
	)

	// ✅ POST /cart/add
	.post(
		'/cart/add',
		describeRoute({
			method: 'post',
			tags: ['Cart'],
			description: 'Add an item to the cart',
			requestBody: {
				content: {
					'application/json': {
						schema: AddCartItemSchema,
					},
				},
			},
			responses: {
				200: {
					description: 'Item added',
					content: {
						'application/json': {
							schema: z.object({ message: z.string() }),
						},
					},
				},
			},
		}),
		zValidator('json', AddCartItemSchema),
		async (c) => {
			const { cartId, skuNumber, quantity, color, filamentType } = c.req.valid('json');

			const existing = await c.var.db.query.cart.findFirst({
				where: and(
					eq(cart.cartId, cartId),
					eq(cart.skuNumber, skuNumber),
					eq(cart.color, color),
				),
			});

			if (existing) {
				await c.var.db.update(cart).set({
					quantity: existing.quantity + quantity,
				}).where(eq(cart.id, existing.id));
			} else {
				await c.var.db.insert(cart).values({
					cartId,
					skuNumber,
					quantity,
					color,
					filamentType,
				});
			}

			return c.json({ message: 'Item added to cart' });
		}
	)

	// ✅ PUT /cart/update
	.put(
		'/cart/update',
		describeRoute({
			method: 'put',
			tags: ['Cart'],
			description: 'Update cart item quantity',
			requestBody: {
				content: {
					'application/json': {
						schema: UpdateCartItemSchema,
					},
				},
			},
			responses: {
				200: {
					description: 'Update response',
					content: {
						'application/json': {
							schema: z.object({ message: z.string() }),
						},
					},
				},
			},
		}),
		zValidator('json', UpdateCartItemSchema),
		async (c) => {
			const { cartId, skuNumber, color, quantity } = c.req.valid('json');

			const existing = await c.var.db.query.cart.findFirst({
				where: and(
					eq(cart.cartId, cartId),
					eq(cart.skuNumber, skuNumber),
					eq(cart.color, color),
				),
			});

			if (!existing) return c.json({ error: 'Cart item not found' }, 404);

			await c.var.db.update(cart).set({ quantity }).where(eq(cart.id, existing.id));
			return c.json({ message: 'Cart item updated' });
		}
	)

	// ✅ DELETE /cart/remove
	.delete(
		'/cart/remove',
		describeRoute({
			method: 'delete',
			tags: ['Cart'],
			description: 'Remove an item from the cart',
			requestBody: {
				content: {
					'application/json': {
						schema: RemoveCartItemSchema,
					},
				},
			},
			responses: {
				200: {
					description: 'Item removed',
					content: {
						'application/json': {
							schema: z.object({ message: z.string() }),
						},
					},
				},
			},
		}),
		zValidator('json', RemoveCartItemSchema),
		async (c) => {
			const { cartId, skuNumber, color } = c.req.valid('json');

			const existing = await c.var.db.query.cart.findFirst({
				where: and(
					eq(cart.cartId, cartId),
					eq(cart.skuNumber, skuNumber),
					eq(cart.color, color),
				),
			});

			if (!existing) return c.json({ error: 'Cart item not found' }, 404);

			await c.var.db.delete(cart).where(eq(cart.id, existing.id));
			return c.json({ message: 'Cart item removed' });
		}
	)

	// ✅ POST /cart/checkout
	.post(
		'/cart/checkout',
		describeRoute({
			method: 'post',
			tags: ['Cart'],
			description: 'Create Stripe checkout session',
			query: z.object({ cartId: z.string() }),
			responses: {
				200: {
					description: 'Stripe session created',
					content: {
						'application/json': {
							schema: z.object({
								url: z.string(),
								id: z.string(),
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const cartId = c.req.query('cartId');
			if (!cartId) return c.json({ error: 'Missing cartId' }, 400);

			const cartItems = await c.var.db.select().from(cart).where(eq(cart.cartId, Number(cartId)));
			if (!cartItems.length) return c.json({ error: 'Cart is empty' }, 400);

			const line_items = [];
			for (const item of cartItems) {
				const [product] = await c.var.db
					.select()
					.from(productsTable)
					.where(eq(productsTable.skuNumber, item.skuNumber));
				if (!product?.stripePriceId) {
					return c.json({ error: `No Stripe price for ${item.skuNumber}` }, 500);
				}
				line_items.push({ price: product.stripePriceId, quantity: item.quantity });
			}

			const session = await stripe.checkout.sessions.create({
				payment_method_types: ['card'],
				line_items,
				mode: 'payment',
				success_url: `${c.env.DOMAIN}/success`,
				cancel_url: `${c.env.DOMAIN}/cancel`,
			});

			return c.json({ url: session.url, id: session.id });
		}
	);

export default shoppingCart;
