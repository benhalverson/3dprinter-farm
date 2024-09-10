import { Context } from 'hono';
import { BASE_URL } from '../constants';


export const colors = async (c: Context) => {
	const response = await fetch(`${BASE_URL}filament`, {
		headers: {
			'context-type': 'application/json',
			'api-key': c.env.SLANT_API,
		},
	});

	if (!response.ok) {
		const error = await response.json() as ErrorResponse;
		return c.json({ error: 'Failed to get colors', details: error }, 500);
	}

	const result = await response.json() as FilamentColorsReponse;
	return c.json(result);
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
    error:   string;
    details: Details;
}

export interface Details {
    error: string;
}
