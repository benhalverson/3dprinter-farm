import { Context } from 'hono';
import { BASE_URL } from '../constants';

export const slice = async (c: Context) => {
	const fileURL = await c.req.json();
	try {
		const response = await fetch(`${BASE_URL}slicer`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'api-key': c.env.SLANT_API,
			},
			body: JSON.stringify(fileURL),
		});

		if (!response.ok) {
			const error: ErrorResponse = await response.json();
			return c.json({ error: 'Failed to slice file', details: error }, 500);
		}

		const result: SliceResponse = await response.json();
		return c.json(result);
	} catch (error: any) {
		console.error('error', error);
		return c.json(
			{ error: 'Failed to slice file', details: error.message },
			500
		);
	}
};

export interface SliceResponse {
	message: string;
	data: {
		price: number;
	};
}

export interface ErrorResponse {
	error: string;
	details: Details;
}

export interface Details {
	error: Error;
	url: string;
}

export interface Error {
	message: string;
	status: number;
}
