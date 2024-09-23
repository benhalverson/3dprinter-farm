import { Context } from 'hono';
import { BASE_URL } from '../constants';
import { z } from 'zod';

const FilamentTypeSchema = z.enum(['PLA', 'PETG'], {
	errorMap: () => ({
		message: 'Accepted values are "PLA" and "PETG".',
	}),
});


export const colors = async (c: Context) => {
	// Get the filamentType query
	const query = c.req.query('filamentType');

	// If query is provided, validate it using Zod
	if (query) {
		const validationResult = FilamentTypeSchema.safeParse(query);

		// If validation fails, return an error response
		if (!validationResult.success) {
			return c.json({
				error: 'Invalid filament type',
				message: validationResult.error.issues[0].message,
			}, 400);
		}
	}

	const response = await fetch(`${BASE_URL}filament`, {
		headers: {
			'Content-Type': 'application/json',
			'api-key': c.env.SLANT_API,
		},
	});

	// Handle error if the response is not OK
	if (!response.ok) {
		const error = await response.json() as ErrorResponse;
		return c.json({ error: 'Failed to get colors', details: error }, 500);
	}

	const result = await response.json() as FilamentColorsReponse;

	// Filter filaments based on the query or return both PLA and PETG if no query
	const filteredFilaments = result.filaments
		.filter((filament) => !query || filament.profile === query) // Return all if no query, or filter by query
		.map(({ filament, hexColor, colorTag }) => ({
			filament,
			hexColor,
			colorTag,
		}))
		.sort((a, b) => a.colorTag.localeCompare(b.hexColor));

	return c.json(filteredFilaments);
};
interface FilamentColorsReponse {
	filaments: Filament[];
}

interface Filament {
	filament: string;
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
