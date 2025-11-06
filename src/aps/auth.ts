/**
 * APS 2-Legged OAuth Auth Manager
 * Caches tokens in memory to reduce auth calls
 */

export interface APSToken {
	access_token: string;
	token_type: string;
	expires_in: number;
	expires_at: number; // epoch ms
}

let cachedToken: APSToken | null = null;

export async function getAPSToken(env: Env): Promise<string> {
	const now = Date.now();

	if (cachedToken && now < cachedToken.expires_at) {
		return cachedToken.access_token;
	}

	const auth = btoa(`${env.APS_CLIENT_ID}:${env.APS_CLIENT_SECRET}`);

	const res = await fetch('https://developer.api.autodesk.com/auth/v1/token', {
		method: 'POST',
		headers: {
			Authorization: `Basic ${auth}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: 'grant_type=client_credentials&scope=data:read data:write bucket:read bucket:create',
	});

	if (!res.ok) {
		throw new Error(`Failed to fetch APS token: ${res.status} ${res.statusText}`);
	}

	const data = (await res.json()) as {
		access_token: string;
		token_type: string;
		expires_in: number;
	};

	cachedToken = {
		...data,
		expires_at: now + data.expires_in * 1000 - 5000, // refresh 5s early
	};

	return cachedToken.access_token;
}
