/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { colors } from './controllers/filament';
import { slice } from './controllers/slice';

const app = new Hono<{
	Bindings: Bindings;
}>();

app.use(logger());

app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

app.post('/upload', async (c) => {
	const body = await c.req.parseBody();

	if (!body || !body.file) {
		return c.json({ error: 'No file uploaded' }, 400);
	}

	const file = body.file as File;

	try {
		const bucket = c.env.BUCKET;
		const key = `${file.name}`;

		await bucket.put(key, file.stream(), {
			httpMetadata: { contentType: file.type },
		});

		return c.json({ messsage: 'File uploaded', key });
	} catch (error) {
		console.error('error', error);
		return c.json({ error: 'Failed to upload file' }, 500);
	}
});

app.post('/slice', slice);

app.get('/colors', colors);

export default app;

type Bindings = {
	BUCKET: R2Bucket;
	SLANT_API: string;
};

