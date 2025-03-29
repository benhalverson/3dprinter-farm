import { Context, Hono } from 'hono';
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
import { ProductData, ProductsDataSchema, productsTable } from './db/schema';
import { eq } from 'drizzle-orm';
import { BASE_URL } from './constants';
import { generateSkuNumber } from './utils/generateSkuNumber';
import { generateOrderNumber } from './utils/generateOrderNumber';
import { calculateMarkupPrice } from './utils/calculateMarkupPrice';
import { clerkMiddleware, getAuth } from '@hono/clerk-auth';
import { ClerkClient, createClerkClient, verifyToken } from '@clerk/backend';
import { clerkClient } from '@clerk/clerk-sdk-node';


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

app.use('*', clerkMiddleware());
app.use(
	cors({
		origin: '*',
	})
);

app.get('/products', async (c) => {
	const db = drizzle(c.env.DB);
	const auth = getAuth(c);
	const clerkClient = await c.get('clerk');
	console.log('clerkClient', clerkClient);

	if (!auth?.userId) {
		return c.json({ error: 'User not authenticated' }, 401);
	}
	const response = await db.select().from(productsTable).all();
	return c.json(response);
});
app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

app.post('/upload', upload);

app.post('/slice', slice);

/**
 * Lists the available colors for the filament
 * @param filamentType The type of filament to list colors for (PLA or PETG)
 * @returns The list of colors for the filament
 */
app.get('/colors', colors);

app.post('/estimate', estimateOrder);
app.post('/add-product', async (c) => {
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
	console.log('basePrice', basePrice);
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

app.put('/update-product', async (c) => {
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

app.get('/list', list);
app.get('/success', success);

app.get('/cancel', cancel);

app.get('/checkout', checkout);
app.post('/paypal', createOrder);
app.get('/paypal-auth', async (c) => {
	const auth_test = await getPayPalAccessToken(c);
	console.log(auth_test);
	return c.text('success');
});

app.post('/signup', async (c) => {});
app.post('/login', async (c) => {});

/**
 * Middleware for protecting authenticated routes
 */
app.use('/auth/*', clerkMiddleware());

/**
 * Protected route to fetch user info
 */
app.get('/auth/me', async (c) => {
  try {
    const user = c.req.validUser; // Automatically injected by ClerkMiddleware

    if (!user) {
      return c.json({ error: 'User not authenticated' }, 401);
    }

    return c.json({ user });
  } catch (error) {
    return c.json({ error: 'Failed to retrieve user info', details: error }, 500);
  }
});

/**
 * Public endpoint for initiating Google OAuth login
 */
app.get('/auth/google', async(c) => {
  const { CLERK_FRONTEND_API, REDIRECT_URL } = c.env;
	const clerkClient = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY })
	const requestState = await clerkClient.authenticateRequest(new Request(c.req.url, c.req), { publishableKey: c.env.CLERK_PUBLISHABLE_KEY })

	const claims = requestState.toAuth()?.sessionClaims

	console.log('claims', claims)

  if (!CLERK_FRONTEND_API) {
    return c.json({ error: 'CLERK_FRONTEND_API not configured' }, 500);
  }

  const redirectUrl = `${CLERK_FRONTEND_API}/oauth/google/start?redirect_url=${encodeURIComponent(
    // REDIRECT_URL
		`http://localhost:8787/auth/callback`
  )}`;

  return c.json({ redirectUrl });
});

/**
 * OAuth callback handler
 */
app.get('/auth/callback', async (c) => {
  const { CLERK_API_KEY } = c.env;
  const url = new URL(c.req.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');

  if (!state || !code) {
    return c.json({ error: 'Missing state or code parameters' }, 400);
  }

  try {
    // Validate the state and code with Clerk's API
    const response = await fetch('https://api.clerk.dev/v1/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CLERK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, code }),
    });

    if (!response.ok) {
      const error = await response.json();
      return c.json({ error: 'OAuth token validation failed', details: error }, 400);
    }

    const tokenData = await response.json();
    return c.json({ message: 'OAuth successful', tokenData });
  } catch (error) {
    return c.json({ error: 'OAuth callback failed', details: error }, 500);
  }
});


export default app;

declare module 'hono' {
  interface HonoRequest {
    validUser?: UserResource; // Clerk injects the authenticated user here
  }
}

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
	CLERK_SECRET_KEY: string;
	CLERK_PUBLISHABLE_KEY: string;
	CLERK_FRONTEND_API: string;
	CLERK_API_KEY: string;
	REDIRECT_URL: string;
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
