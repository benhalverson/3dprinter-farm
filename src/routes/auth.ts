import { eq } from 'drizzle-orm';
import { deleteCookie, setSignedCookie } from 'hono/cookie';
import { ZodError } from 'zod';
import { signInSchema, signUpSchema, users } from '../db/schema';
import { hashPassword, signJWT, verifyPassword } from '../utils/crypto';
import { rateLimit } from '../utils/rateLimit';
import factory from '../factory';

const auth = factory.createApp()
	.post(
		'/signup',
		rateLimit({
			windowSeconds: 60,
			maxRequests: 3,
			keyPrefix: 'signup',
		}),
		async (c) => {
			const db = c.var.db
			try {
				const { email, password } = signUpSchema.parse(await c.req.json());
				const [existingUser] = await db
					.select()
					.from(users)
					.where(eq(users.email, email));
				if (existingUser) {
					return c.json({ error: 'User already exists' }, 409);
				}

				const { salt, hash } = await hashPassword(password);
				const [insertedUser] = await db
					.insert(users)
					.values({
						email,
						passwordHash: hash,
						salt,
						firstName: '',
						lastName: '',
						shippingAddress: '',
						billingAddress: '',
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

				return c.json({
					success: true,
					message: 'User created successfully',
					token,
				});
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
	.post('/signin', async (c) => {
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
	})
	.get('/signout', async (c) => {
		deleteCookie(c, 'token', {
			path: '/',
			secure: true,
			httpOnly: true,
		});

		return c.json({ message: 'signout success' });
	});

export default auth;
