import { Context } from 'hono';
import { BASE_URL } from '../constants';
import { z } from 'zod';
import { json } from 'drizzle-orm/mysql-core';

const FilamentTypeSchema = z.enum(['PLA', 'PETG'], {
	errorMap: () => ({
		message: 'Accepted values are "PLA" and "PETG".',
	}),
});

export const colors = async (c: Context) => {
	const query = c.req.query('filamentType');
	const normalizedQuery = query?.toUpperCase();
	const cacheKey = `3dprinter-web-api-COLOR_CACHE:${normalizedQuery}`;

	const cachedResponse = await c.env.COLOR_CACHE.get(cacheKey);

	if (cachedResponse) {
		console.log(`Cached Hit for key ${normalizedQuery}`);
		return c.json(JSON.parse(cachedResponse));
	}

	if (query) {
		const validationResult = FilamentTypeSchema.safeParse(query);

		if (!validationResult.success) {
			return c.json(
				{
					error: 'Invalid filament type',
					message: validationResult.error.issues[0].message,
				},
				400
			);
		}
	}

	const response = await fetch(`${BASE_URL}filament`, {
		headers: {
			'Content-Type': 'application/json',
			'api-key': c.env.SLANT_API,
		},
	});

	if (!response.ok) {
		const error = (await response.json()) as ErrorResponse;
		return c.json({ error: 'Failed to get colors', details: error }, 500);
	}

	const result = (await response.json()) as FilamentColorsReponse;

	const filteredFilaments = result.filaments
		.filter((filament) => !query || filament.profile === query) // Return all if no query, or filter by query
		.map(({ filament, hexColor, colorTag }) => ({
			filament,
			hexColor,
			colorTag,
		}))
		.sort((a, b) => a.colorTag.localeCompare(b.hexColor));

	await c.env.COLOR_CACHE.put(cacheKey, JSON.stringify(filteredFilaments), {
		expirationTtl: 604800, // 1 week
	});

	return c.json(filteredFilaments);
};
interface FilamentColorsReponse {
	filaments: Filament[];
}

interface Filament {
	filament: FilamentType;
	hexColor: string;
	colorTag: string;
	profile: string;
}

export interface ErrorResponse {
	error: string;
	details: Details;
}

export interface Details {
	error: string;
}

enum FilamentType {
	PLA = 'PLA',
	PETG = 'PETG',
}
