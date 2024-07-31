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

const app = new Hono<{
	Bindings: Bindings;
}>();

app.use(logger());
app.get('/:username', async (c) => {
	const username = c.req.param('username');

	const response = await fetch(`https://api.github.com/users/${username}`, {
		headers: {
			'User-Agent': 'benhalverson',
		},
	});
	// https://api.github.com/users/benhalverson

	if (!response.ok) {
		console.log('error', response);
		return c.json({ error: 'Failed to fetch repositories', details: `${response.status}` }, 500);
	}

	const data: GitHubRepo[] = await response.json();
	return c.json(data);
});



export default app;

type Bindings = {};

interface GitHubRepo {
	id: number;
	name: string;
	full_name: string;
	// Add other properties you need from the GitHub API response
}
