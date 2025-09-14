import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { describeRoute } from 'hono-openapi';
import { authMiddleware } from '../utils/authMiddleware';
import { ProfileDataSchema, users } from '../db/schema';
import factory from '../factory';
import { encryptField, decryptField } from '../utils/crypto';

const userRouter = factory
	.createApp()

	.get(
		'/profile',
		describeRoute({
			description: 'Get the profile of the authenticated user',
			tags: ['User'],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: ProfileDataSchema.extend({
								id: ProfileDataSchema.shape.id.optional(),
								email: ProfileDataSchema.shape.email || z.string().email().optional(),
								address: z.string().optional(),
							}),
						},
					},
					description: 'User profile retrieved successfully',
				},
				401: {
					content: {
						'application/json': {
							schema: z.object({ error: z.string() }),
						},
					},
					description: 'Unauthorized',
				},
				404: {
					content: {
						'application/json': {
							schema: z.object({ error: z.string() }),
						},
					},
					description: 'User not found',
				},
			},
		}),
		authMiddleware,
		async (c) => {
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

				const passphrase = c.env.ENCRYPTION_PASSPHRASE;

				console.time('decrypt-profile');
				const [firstName, lastName, address, city, state, zipCode, country, phone] = await Promise.all([
					decryptField(userData.firstName, passphrase),
					decryptField(userData.lastName, passphrase),
					decryptField(userData.shippingAddress, passphrase),
					decryptField(userData.city, passphrase),
					decryptField(userData.state, passphrase),
					decryptField(userData.zipCode, passphrase),
					decryptField(userData.country, passphrase),
					decryptField(userData.phone, passphrase),
				]);

				const decryptedProfile = {
					firstName,
					lastName,
					address,
					city,
					state,
					zipCode,
					country,
					phone,
				};
				console.timeEnd('decrypt-profile');
				return c.json(decryptedProfile);
			}
			catch (error: any) {
				console.log('Error fetching user data:', error);
				return c.json(
					{ error: 'Internal Server Error', details: error.message },
					500
				);
			}
		}
	)

	.post(
		'/profile/:id',
		describeRoute({
			description: 'Update the profile of a user by ID',
			tags: ['User'],
			requestBody: {
				content: {
					'application/json': {
						schema: ProfileDataSchema,
					},
				},
			},
			responses: {
				200: {
					content: {
						'application/json': {
							schema: ProfileDataSchema.extend({
								id: ProfileDataSchema.shape.id.optional(),
								email: z.string().email().optional(),
							}),
						},
					},
					description: 'User profile updated successfully',
				},
				400: {
					content: {
						'application/json': {
							schema: z.object({ error: z.string(), details: z.any() }),
						},
					},
					description: 'Validation failed',
				},
				404: {
					content: {
						'application/json': {
							schema: z.object({ error: z.string() }),
						},
					},
					description: 'User not found',
				},
				500: {
					content: {
						'application/json': {
							schema: z.object({ error: z.string(), details: z.any() }),
						},
					},
					description: 'Internal Server Error',
				},
			},
		}),
		async (c) => {
			const userId = Number(c.req.param('id'));
			const body = await c.req.json();
			const validation = ProfileDataSchema.safeParse(body);
			if (!validation.success) {
				return c.json({ error: 'Validation failed', details: validation.error.errors }, 400);
			}

			const {
				firstName,
				lastName,
				shippingAddress,
				city,
				state,
				zipCode,
				phone,
				country
			} = validation.data;

			try {
				const passphrase = c.env.ENCRYPTION_PASSPHRASE;

				const [encryptedFirstName, encryptedLastName, encryptedShippingAddress, encryptedCity, encryptedState, encryptedZipCode, encryptedCountry, encryptedPhone] = await Promise.all([
					encryptField(firstName, passphrase),
					encryptField(lastName, passphrase),
					encryptField(shippingAddress, passphrase),
					encryptField(city, passphrase),
					encryptField(state, passphrase),
					encryptField(zipCode, passphrase),
					encryptField(country, passphrase),
					encryptField(phone, passphrase)
				]);

				const [userData] = await c.var.db
					.update(users)
					.set({
						firstName: encryptedFirstName,
						lastName: encryptedLastName,
						shippingAddress: encryptedShippingAddress,
						city: encryptedCity,
						state: encryptedState,
						zipCode: encryptedZipCode,
						country: encryptedCountry,
						phone: encryptedPhone
					})
					.where(eq(users.id, userId))
					.returning();

				if (!userData) return c.json({ error: 'User not found' }, 404);

				return c.json({
					id: userData.id,
					email: userData.email,
					firstName,
					lastName,
					shippingAddress,
					city,
					state,
					zipCode,
					country,
					phone,
				});
			} catch (error: any) {
				console.error('Error updating user data:', error);
				return c.json(
					{ error: 'Internal Server Error', details: error.message },
					500
				);
			}
		}
	);

export default userRouter;
