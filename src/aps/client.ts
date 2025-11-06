import { getAPSToken } from './auth';

export async function apsFetch<T>(env: Env, url: string, init: RequestInit = {}): Promise<T> {
	const token = await getAPSToken(env);

	const res = await fetch(url, {
		...init,
		headers: {
			...(init.headers || {}),
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`APS API Error: ${res.status} ${res.statusText} - ${text}`);
	}

	return res.json() as Promise<T>;
}
