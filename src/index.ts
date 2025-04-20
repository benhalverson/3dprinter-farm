import { Context, Hono, Next } from 'hono';
import { logger } from 'hono/logger';
import { colors } from './controllers/filament';
import { slice, SliceResponse } from './controllers/slice';
import { estimateOrder } from './controllers/estimate-order';
import { upload } from './controllers/upload';
import { z, ZodError } from 'zod';
import { list } from './controllers/list';
import { cancel, checkout, success } from './controllers/stripe';
import { cors } from 'hono/cors';
import { createOrder, getPayPalAccessToken } from './controllers/paypal';
import { drizzle } from 'drizzle-orm/d1';
import type {
	RegistrationCredential,
	RegistrationResponseJSON,
} from '@simplewebauthn/types';

import {
	ProductData,
	ProductsDataSchema,
	productsTable,
	users,
	authenticators,
	webauthnChallenges,
	signUpSchema,
	signInSchema,
} from './db/schema';
import { eq } from 'drizzle-orm';
import { BASE_URL } from './constants';
import { generateSkuNumber } from './utils/generateSkuNumber';
import { generateOrderNumber } from './utils/generateOrderNumber';
import { calculateMarkupPrice } from './utils/calculateMarkupPrice';
import { jwt, verify } from 'hono/jwt';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
	base64url,
	base64urlToUint8Array,
	bufferToBase64url,
	hashPassword,
	signJWT,
	verifyPassword,
} from './utils/crypto';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';

const app = new Hono<{
	Bindings: Bindings;
}>();

const idSchema = z.object({
	id: z.number().int(),
});

const orderSchema = z
	.object({
		email: z.string().email(), // Assuming email should be a valid email string
		phone: z.string(),
		name: z.string(),
		orderNumber: z.string(),
		filename: z.string(),
		fileURL: z.string().url(), // Assuming fileURL should be a valid URL
		bill_to_street_1: z.string(),
		bill_to_street_2: z.string(),
		bill_to_street_3: z.string(),
		bill_to_city: z.string(),
		bill_to_state: z.string(),
		bill_to_zip: z.string(),
		bill_to_country_as_iso: z.string(),
		bill_to_is_US_residential: z.string(),
		ship_to_name: z.string(),
		ship_to_street_1: z.string(),
		ship_to_street_2: z.string(),
		ship_to_street_3: z.string(),
		ship_to_city: z.string(),
		ship_to_state: z.string(),
		ship_to_zip: z.string(),
		ship_to_country_as_iso: z.string(),
		ship_to_is_US_residential: z.string(),
		order_item_name: z.string(),
		order_quantity: z.string(),
		order_image_url: z.string().url(), // Assuming order_image_url should be a valid URL
		order_sku: z.string(),
		order_item_color: z.string(),
	})
	.strict();

app.use(logger());
app.use(
	cors({
		origin: [
			'http://localhost:3000',
			'http://localhost:4200',
			'https://rc-store.benhalverson.dev',
			'https://rc-admin.pages.dev',
		],
		credentials: true,
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	})
);

const authMiddleware = async (c: Context, next: Next) => {
	const signedToken = await getSignedCookie(c, c.env.JWT_SECRET, 'token');
	console.log('middleware auth', signedToken);

	if (!signedToken) {
		return c.json({ error: 'Unauthorized (no token)' }, 401);
	}

	try {
		const payload = await verify(signedToken, c.env.JWT_SECRET);
		c.set('jwtPayload', payload);
		return next();
	} catch (err) {
		return c.json({ error: 'Invalid or expired token' }, 401);
	}
};

app.get('/webauthn/authenticators', authMiddleware, async (c) => {
	const user = c.get('jwtPayload') as { id: number };
	const db = drizzle(c.env.DB);

	const authenticatorsList = await db
		.select()
		.from(authenticators)
		.where(eq(authenticators.userId, user.id));

	return c.json(authenticatorsList);
});

app.delete('/webauthn/authenticators/:id', authMiddleware, async (c) => {
	const user = c.get('jwtPayload') as { id: number };
	const credentialId = c.req.param('id');
	const db = drizzle(c.env.DB);

	await db
		.delete(authenticators)
		.where(eq(authenticators.credentialId, credentialId));
	// optionally: .where(and(eq(userId, user.id), eq(credentialId, ...)))

	return c.json({ success: true });
});

app.post('/webauthn/register/begin', authMiddleware, async (c) => {
	const db = drizzle(c.env.DB);
	const user = c.get('jwtPayload') as { id: number; email: string };
	console.log('RP_ID', c.env.RP_ID);
	console.log('RP_NAME', c.env.RP_NAME);

	const [existingUser] = await db
		.select()
		.from(users)
		.where(eq(users.id, user.id));

	if (!existingUser) return c.json({ error: 'User not found' }, 404);

	const existingAuthenticators = await db
		.select()
		.from(authenticators)
		.where(eq(authenticators.userId, user.id));

	const excludeCredentials = existingAuthenticators.map((auth) => ({
		id: auth.credentialId,
		type: 'public-key' as const,
	}));

	const options = await generateRegistrationOptions({
		rpName: c.env.RP_NAME,
		rpID: c.env.RP_ID,
		userID: new TextEncoder().encode(user.id.toString()),
		userName: existingUser.email,
		// excludeCredentials,
		authenticatorSelection: {
			userVerification: 'preferred',
		},
	});

	console.log('options', options);
	await db
		.insert(webauthnChallenges)
		.values({ userId: user.id, challenge: (await options).challenge })
		.onConflictDoUpdate({
			target: [webauthnChallenges.userId],
			set: { challenge: (await options).challenge },
		});

	return c.json(options);
});

app.post('/webauthn/auth/begin', async (c) => {
	const db = drizzle(c.env.DB);
	const { email } = await c.req.json();

	const [user] = await db.select().from(users).where(eq(users.email, email));
	if (!user) return c.json({ error: 'User not found' }, 404);

	const authenticatorsList = await db
		.select()
		.from(authenticators)
		.where(eq(authenticators.userId, user.id));

	if (!authenticatorsList.length) {
		return c.json({ error: 'No authenticators found' }, 404);
	}

	const options = await generateAuthenticationOptions({
		rpID: c.env.RP_ID,
		userVerification: 'preferred',
		allowCredentials: authenticatorsList.map((auth) => ({
			id: auth.credentialId,
			type: 'public-key' as const,
		})),
	});

	await db
		.insert(webauthnChallenges)
		.values({ userId: user.id, challenge: (await options).challenge })
		.onConflictDoUpdate({
			target: [webauthnChallenges.userId],
			set: { challenge: (await options).challenge },
		});

	return c.json({ options, userId: user.id });
});

app.post('/webauthn/register/finish', authMiddleware, async (c) => {
	const db = drizzle(c.env.DB);
	const user = c.get('jwtPayload') as { id: number; email: string };
	if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);

	let body: any;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const { id, rawId, response: webauthnResponse } = body;

	if (
		!id ||
		!rawId ||
		!webauthnResponse?.clientDataJSON ||
		!webauthnResponse?.attestationObject
	) {
		return c.json({ error: 'Missing credential fields' }, 400);
	}

	// Get stored challenge for this user
	const [challengeRow] = await db
		.select()
		.from(webauthnChallenges)
		.where(eq(webauthnChallenges.userId, user.id));

	if (!challengeRow) {
		return c.json({ error: 'Missing challenge' }, 400);
	}

	const parsedCredential: RegistrationResponseJSON = {
		id: base64url(base64urlToUint8Array(id)), // Ensure it's Base64URL-encoded
		rawId: base64url(base64urlToUint8Array(rawId)), // Ensure it's Base64URL-encoded
		type: 'public-key',
		response: {
			clientDataJSON: webauthnResponse.clientDataJSON, //base64urlToUint8Array(webauthnResponse.clientDataJSON),
			attestationObject: webauthnResponse.attestationObject,
		},
		clientExtensionResults: {},
	};

	let verification;
	try {
		console.log('verifyRegistrationResponse inputs:', {
			challenge: challengeRow.challenge,
			// expectedOrigin: 'https://rc-store.benhalverson.dev',
			// expectedRPID: 'rc-store.benhalverson.dev',
		});
		verification = await verifyRegistrationResponse({
			response: parsedCredential,
			expectedChallenge: challengeRow.challenge,
			expectedOrigin: 'https://rc-store.benhalverson.dev', // c.env.DOMAIN,
			expectedRPID: 'rc-store.benhalverson.dev', // c.env.RP_ID,
			requireUserVerification: true,
		});
	} catch (err) {
		console.log('Verification error:', err);
		return c.json({ error: 'Verification failed', details: err }, 500);
	}

	if (!verification.verified) {
		return c.json({ error: 'Verification failed' }, 400);
	}

	const {
		credential: { id: credentialID, publicKey: credentialPublicKey },
	} = verification.registrationInfo!;

	await db.insert(authenticators).values({
		userId: user.id,
		credentialId: verification.registrationInfo?.credential?.id,
		credentialPublicKey,
		counter: verification.registrationInfo?.credential.counter,
	});

	return c.json({ success: true });
});

app.get('/products', async (c) => {
	const db = drizzle(c.env.DB);
	const response = await db.select().from(productsTable).all();
	return c.json(response);
});
app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

app.post('/upload', authMiddleware, upload);

app.post('/slice', authMiddleware, slice);

/**
 * Lists the available colors for the filament
 * @param filamentType The type of filament to list colors for (PLA or PETG)
 * @returns The list of colors for the filament
 */
app.get('/colors', colors);

app.post('/estimate', authMiddleware, estimateOrder);
app.post('/add-product', authMiddleware, async (c) => {
	const user = c.get('jwtPayload') as { id: number; email: string };
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}
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
		return c.json(
			{ error: 'Failed to slice file', details: error.message },
			500
		);
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
		const db = drizzle(c.env.DB);
		const response = await db
			.insert(productsTable)
			.values(productDataToInsert)
			.returning();
		return c.json(response);
	} catch (error) {
		console.error('Error adding product', error);
	}

	return c.json({ error: 'Failed to add product' }, 500);
});

app.get('/product/:id', async (c) => {
	const idParam = c.req.param('id');
	const parsedData = idSchema.parse({ id: Number(idParam) });
	const db = drizzle(c.env.DB);
	const response = await db
		.select()
		.from(productsTable)
		.where(eq(productsTable.id, parsedData.id));
	const product = response[0];

	return product
		? c.json(product)
		: c.json({ error: 'Product not found' }, 404);
});

app.put('/update-product', authMiddleware, async (c) => {
	try {
		const body = await c.req.json();
		const parsedData = updateProductSchema.parse(body);
		const db = drizzle(c.env.DB);

		const updateResult = await db
			.update(productsTable)
			.set({
				name: parsedData.name,
				description: parsedData.description,
				price: parsedData.price,
				filamentType: parsedData.filamentType,
				color: parsedData.color,
			})
			.where(eq(productsTable.id, parsedData.id));

		if (updateResult.success) {
			return c.json({ success: true, message: 'Product updated successfully' });
		} else {
			return c.json({ error: 'Product not found or update failed' }, 404);
		}
	} catch (error) {
		if (error instanceof ZodError) {
			return c.json({ error: 'Validation error', details: error.errors }, 400);
		}
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

app.get('/list', authMiddleware, list);

app.get('/success', success);

app.get('/cancel', cancel);

app.get('/checkout', checkout);
app.post('/paypal', createOrder);
app.get('/paypal-auth', async (c) => {
	const auth_test = await getPayPalAccessToken(c);
	return c.text('success');
});

app.post('/signup', async (c) => {
	console.log('signup', c.req.json());
	const db = drizzle(c.env.DB);
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

		console.log('token', token);
		console.log('context', c);
		console.log('JWT_SECRET', c.env.JWT_SECRET);
		return c.json({
			success: true,
			message: 'User created successfully',
			token,
		});
	} catch (error) {
		if (error instanceof ZodError) {
			return c.json({ error: 'Validation error', details: error.errors }, 400);
		}
		console.error('Error during signup:', error);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

app.post('/signin', async (c) => {
	const db = drizzle(c.env.DB);
	try {
		const { email, password } = signInSchema.parse(await c.req.json());
		const [user] = await db.select().from(users).where(eq(users.email, email));
		if (!user) {
			return c.json({ error: 'User not found' }, 404);
		}

		const isValid = await verifyPassword(
			password,
			user.salt,
			user.passwordHash
		);
		if (!isValid) {
			return c.json({ error: 'Invalid credentials' }, 401);
		}

		console.log('isValid password', isValid);

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
		console.log('token', token);
		console.log('context', c);
		console.log('JWT_SECRET', c.env.JWT_SECRET);
		return c.json({ message: 'signin success' });
	} catch (error) {
		if (error instanceof ZodError) {
			console.log('Validation Error', error);
			return c.json({ error: 'Validation error', details: error.errors }, 400);
		}
		console.log('General error', error);

		return c.json(
			{ error: 'Internal Server Error', details: (error as Error).message },
			500
		);
	}
});

app.get('/signout', async (c) => {
	deleteCookie(c, 'token', {
		path: '/',
		secure: true,
		httpOnly: true,
	});

	return c.json({ message: 'signout success' });
});

app.get('/profile', authMiddleware, async (c) => {
	const user = c.get('jwtPayload') as { id: number; email: string };
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const db = drizzle(c.env.DB);
	try {
		const [userData] = await db
			.select()
			.from(users)
			.where(eq(users.id, user.id));

		if (!userData) {
			return c.json({ error: 'User not found' }, 404);
		}

		return c.json({
			id: userData.id,
			email: userData.email,
			firstName: userData.firstName,
			lastName: userData.lastName,
		});
	} catch (error: any) {
		console.error('Error fetching user data:', error);
		return c.json(
			{ error: 'Internal Server Error', details: error.message },
			500
		);
	}
});
app.post('/webauthn/auth/finish', async (c) => {
	const db = drizzle(c.env.DB);
	const body = await c.req.json();

	const { userId, response } = body;
	if (!userId || !response) {
		return c.json({ error: 'Missing input' }, 400);
	}

	// Retrieve stored challenge for this user
	const [challengeRow] = await db
		.select()
		.from(webauthnChallenges)
		.where(eq(webauthnChallenges.userId, userId));

	if (!challengeRow) {
		return c.json({ error: 'No challenge found' }, 400);
	}
	const expectedChallenge = challengeRow.challenge;

	// Get the authenticator for this user
	const [authenticator] = await db
		.select()
		.from(authenticators)
		.where(eq(authenticators.userId, userId))
		.limit(1);

	if (!authenticator) {
		return c.json({ error: 'No authenticators found' }, 400);
	}

	const parsedCredential: AuthenticationResponseJSON = {
		id: response.id,
		rawId: response.rawId,
		type: response.type,
		response: {
			clientDataJSON: atob(response.response.clientDataJSON),
			authenticatorData: atob(response.response.authenticatorData),
			signature: atob(response.response.signature),
			userHandle: response.response.userHandle
				? atob(response.response.userHandle)
				: null,
		},
		clientExtensionResults: {},
	};

	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response: parsedCredential,
			expectedChallenge,
			expectedOrigin: c.env.DOMAIN,
			expectedRPID: c.env.RP_ID,
			authenticator: {
				credentialID: base64urlToUint8Array(authenticator.credentialId),
				credentialPublicKey: authenticator.credentialPublicKey,
				counter: authenticator.counter,
			},
		});
	} catch (err) {
		console.error('Auth verification failed:', err);
		return c.json({ error: 'Verification failed' }, 401);
	}

	if (!verification.verified) {
		return c.json({ error: 'Verification failed' }, 401);
	}

	// Update counter to prevent replay attacks
	await db
		.update(authenticators)
		.set({ counter: verification.authenticationInfo.newCounter })
		.where(eq(authenticators.credentialId, authenticator.credentialId));

	// Issue session token
	const iat = Math.floor(Date.now() / 1000);
	const exp = iat + 60 * 60 * 24; // 1 day

	const token = await signJWT({
		payload: { id: userId },
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

	return c.json({ success: true });
});

export default app;

type Bindings = {
	BUCKET: R2Bucket;
	SLANT_API: string;
	STRIPE_PUBLISHABLE_KEY: string;
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	STRIPE_PRICE_ID: string;
	DOMAIN: string;
	DB: D1Database;
	COLOR_CACHE: Cache;
	JWT_SECRET: string;
	RP_ID: string;
	RP_NAME: string;
};

// Schema for adding a new product to the products table
const addProductSchema = z
	.object({
		id: z.number().optional(),
		name: z.string(),
		description: z.string(),
		image: z.string(),
		stl: z.string(),
		price: z.number(),
		filamentType: z.string(),
		color: z.string(),
		skuNumber: z.string(),
	})
	.omit({ id: true, skuNumber: true });

const updateProductSchema = z.object({
	id: z.number(),
	name: z.string(),
	description: z.string(),
	image: z.string(),
	stl: z.string(),
	price: z.number(),
	filamentType: z.string(),
	color: z.string(),
	skuNumber: z.string(),
});
