import { getAPSToken } from './auth';

export async function apsFetch<T>(env: Env, url: string, init: RequestInit = {}): Promise<T> {
	const token = await getAPSToken(env);

	const headers = {
		...(init.headers || {}),
		Authorization: `Bearer ${token}`,
	};

	// Only set Content-Type if not already specified and there's a body
	if (!('Content-Type' in headers) && !('content-type' in headers)) {
		headers['Content-Type'] = 'application/json';
	}

	const res = await fetch(url, {
		...init,
		headers,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`APS API Error: ${res.status} ${res.statusText} - ${text}`);
	}

	return res.json() as Promise<T>;
}
