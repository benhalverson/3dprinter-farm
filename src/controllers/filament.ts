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
		const error = await response.json();
		return c.json({ error: 'Failed to get colors', details: error }, 500);
	}

	const result: FilamentColorsReponse = await response.json();
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
