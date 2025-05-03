import { eq } from 'drizzle-orm';
import { authMiddleware } from '../utils/authMiddleware';
import { ProfileDataSchema, users } from '../db/schema';
import factory from '../factory';


const userRouter = factory
	.createApp()
	.get('/profile', authMiddleware, async (c) => {
		const user = c.get('jwtPayload') as { id: number; email: string };
		if (!user) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		try {
			const [userData] = await c.var.db
				.select()
				.from(users)
				.where(eq(users.id, user.id));

			if (!userData) return c.json({ error: 'User not found' }, 404);

			return c.json({
				id: userData.id,
				email: userData.email,
				firstName: userData.firstName,
				lastName: userData.lastName,
				address: userData.shippingAddress,
				city: userData.city,
				state: userData.state,
				zipCode: userData.zipCode,
				country: userData.country,
				phone: userData.phone,
			});
			// return c.json(userData);
		}
		catch (error: any) {
			console.error('Error fetching user data:', error);
			return c.json(
				{ error: 'Internal Server Error', details: error.message },
				500
			);
		}
	})
	.post('/profile/:id', async (c) => {
		const userId = Number(c.req.param('id'));
		const body = await c.req.json();
		const validation = ProfileDataSchema.safeParse(body);
		if (!validation.success) {
			return c.json({ error: 'Validation failed', details: validation.error.errors }, 400);
		}

		const { firstName, lastName, shippingAddress, city, state, zipCode, phone, country } = validation.data;

		try {
			const [userData] = await c.var.db
				.update(users)
				.set({
					firstName,
					lastName,
					shippingAddress,
					city,
					state,
					zipCode,
					country,
					phone
				})
				.where(eq(users.id, userId))
				.returning();

			if (!userData) return c.json({ error: 'User not found' }, 404);

			return c.json({
				id: userData.id,
				email: userData.email,
				firstName: userData.firstName,
				lastName: userData.lastName,
				shippingAddress: userData.shippingAddress,
				city: userData.city,
				state: userData.state,
				zipCode: userData.zipCode,
				country: userData.country,
				phone: userData.phone,
			});
		} catch (error: any) {
			console.error('Error updating user data:', error);
			return c.json(
				{ error: 'Internal Server Error', details: error.message },
				500
			);
		}
	});

export default userRouter;
