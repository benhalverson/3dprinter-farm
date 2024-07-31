import { Context } from 'hono';

export const upload = async (c: Context) => {
	const body = await c.req.parseBody();

	if (!body || !body.file) {
		return c.json({ error: 'No file uploaded' }, 400);
	}

	const file = body.file as File;

	try {
		const bucket = c.env.BUCKET;
		const key = `${file.name}`;

		await bucket.put(key, file.stream(), {
			httpMetadata: { contentType: file.type },
		});

		return c.json({ messsage: 'File uploaded', key });
	} catch (error) {
		console.error('error', error);
		return c.json({ error: 'Failed to upload file' }, 500);
	}
};
