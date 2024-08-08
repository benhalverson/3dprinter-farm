import { Context } from 'hono';

export const list = async (c: Context) => {
	const { BUCKET } = c.env;
	const list = await BUCKET.list()
	const data = list.objects.map((o: ListResponse) => {
		return {
			stl: o.key,
			size: o.size,
			version: o.version
		}
	});
	return c.json(data);
}

export interface ListResponse {
	stl: string;
	key?: string;
	size: number;
	version: string;
}
