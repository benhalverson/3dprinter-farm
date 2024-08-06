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
import { estimateOrder } from './controllers/estimate-order';
import { upload } from './controllers/upload';

const app = new Hono<{
	Bindings: Bindings;
}>();

app.use(logger());

app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

app.post('/upload', upload);

app.post('/slice', slice);

app.get('/colors', colors);

app.post('/estimate', estimateOrder);

export default app;

type Bindings = {
	BUCKET: R2Bucket;
	SLANT_API: string;
};

