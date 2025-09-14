import { eq } from 'drizzle-orm';
import { deleteCookie, setSignedCookie } from 'hono/cookie';
import { ZodError } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { signInSchema, signUpSchema, users } from '../db/schema';
import {
	encryptField,
	hashPassword,
	signJWT,
	verifyPassword,
} from '../utils/crypto';
import { rateLimit } from '../utils/rateLimit';
import factory from '../factory';
import { describeRoute } from 'hono-openapi';

import { z } from 'zod';
import { resolver } from 'hono-openapi/zod';

const auth = factory
	.createApp()
	.post(
		'/signup',
		describeRoute({
			description: 'User signup endpoint',
			tags: ['Auth'],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: resolver(signInSchema),
						},
					},
					description: 'The user was created successfully',
				},
				400: {
					content: {
						'application/json': {
							schema: resolver(signInSchema),
						},
					},

					description: 'Missing or invalid parameters',
				},
			},
		}),
		rateLimit({
			windowSeconds: 60,
			maxRequests: 3,
			keyPrefix: 'signup',
		}),
		zValidator('json', signUpSchema),
		async (c) => {
			const db = c.var.db;
			try {
				const { email, password } = c.req.valid('json');
				const [existingUser] = await db
					.select()
					.from(users)
					.where(eq(users.email, email));
				if (existingUser) {
					return c.json({ error: 'User already exists' }, 409);
				}

				const { salt, hash } = await hashPassword(password);
				const passphrase = c.env.ENCRYPTION_PASSPHRASE;
				
				const [encryptedFirstName, encryptedLastName, encryptedShippingAddress, encryptedBillingAddress, encryptedCity, encryptedState, encryptedZipCode, encryptedCountry, encryptedPhone] = await Promise.all([
					encryptField('', passphrase),
					encryptField('', passphrase),
					encryptField('', passphrase),
					encryptField('', passphrase),
					encryptField('', passphrase),
					encryptField('', passphrase),
					encryptField('', passphrase),
					encryptField('', passphrase),
					encryptField('', passphrase),
				]);

				const [insertedUser] = await db
					.insert(users)
					.values({
						email,
						passwordHash: hash,
						salt,
						firstName: encryptedFirstName,
						lastName: encryptedLastName,
						shippingAddress: encryptedShippingAddress,
						billingAddress: encryptedBillingAddress,
						city: encryptedCity,
						state: encryptedState,
						zipCode: encryptedZipCode,
						country: encryptedCountry,
						phone: encryptedPhone,
					})
					.returning();

				const iat = Math.floor(Date.now() / 1000);
				const exp = iat + 60 * 60 * 24; // Token expiration time (1 day)

				const token = await signJWT({
					payload: { id: insertedUser.id, email: insertedUser.email },
					secret: c.env.JWT_SECRET,
					iat,
					exp,
				});

				await setSignedCookie(c, 'token', token, c.env.JWT_SECRET, {
					httpOnly: true,
					sameSite: 'None',
					path: '/',
					secure: true,
					maxAge: 60 * 60 * 24, // 1 day
				});

				return c.json(
					{
						success: true,
						message: 'User created successfully',
						token,
					},
					200
				);
			} catch (error) {
				if (error instanceof ZodError) {
					return c.json(
						{ error: 'Validation error', details: error.errors },
						400
					);
				}
				console.error('Error during signup:', error);
				return c.json({ error: 'Internal Server Error' }, 500);
			}
		}
	)
	.post(
		'/signin',
		describeRoute({
			description: 'User signin endpoint',
			tags: ['Auth'],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: resolver(signInSchema),
						},
					},
					description: 'The user was authenticated successfully',
				},
				400: {
					content: {
						'application/json': {
							schema: resolver(signInSchema),
						},
					},
					description: 'Missing or invalid parameters',
				},
			},
		}),

		async (c) => {
			try {
				const { email, password } = signInSchema.parse(await c.req.json());
				const [user] = await c.var.db
					.select()
					.from(users)
					.where(eq(users.email, email));
				if (!user) {
					return c.json({ error: 'Invalid Credentials' }, 401);
				}

				const isValid = await verifyPassword(
					password,
					user.salt,
					user.passwordHash
				);
				if (!isValid) {
					return c.json({ error: 'Invalid credentials' }, 401);
				}

				const iat = Math.floor(Date.now() / 1000);
				const exp = iat + 60 * 60 * 24;
				const token = await signJWT({
					payload: { id: user.id, email: user.email },
					secret: c.env.JWT_SECRET,
					iat,
					exp,
				});

				await setSignedCookie(c, 'token', token, c.env.JWT_SECRET, {
					httpOnly: true,
					sameSite: 'None',
					path: '/',
					secure: true,
					maxAge: 60 * 60 * 24,
				});
				return c.json({ message: 'signin success' });
			} catch (error) {
				if (error instanceof ZodError) {
					return c.json(
						{ error: 'Validation error', details: error.errors },
						400
					);
				}

				return c.json(
					{ error: 'Internal Server Error', details: (error as Error).message },
					500
				);
			}
		}
	)
	.get(
		'/signout',
		describeRoute({
			description: 'User signout endpoint',
			tags: ['Auth'],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: z.object({
								message: z.string(),
							}),
						},
					},
					description: 'User signed out successfully',
				},
			},
		}),

		async (c) => {
			deleteCookie(c, 'token', {
				path: '/',
				secure: true,
				httpOnly: true,
			});

			return c.json({ message: 'signout success' });
		}
	);

export default auth;
