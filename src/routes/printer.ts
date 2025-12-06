import { Context } from 'hono';
import { z } from 'zod';
import {
	ErrorResponse,
	FilamentColorsResponse,
	FilamentV2Response,
	Slant3DFileResponse,
	ListResponse,
	OrderData,
	OrderResponse,
	SliceResponse,
} from '../types';
import { BASE_URL, BASE_URL_V2 } from '../constants';
import { authMiddleware } from '../utils/authMiddleware';
import { orderSchema } from '../db/schema';
import factory from '../factory';
import { describeRoute } from 'hono-openapi';
import { dashFilename } from '../utils/dash';

const FilamentTypeSchema = z.enum(['PLA', 'PETG'], {
	errorMap: () => ({
		message: 'Accepted values are "PLA" and "PETG".',
	}),
});

const printer = factory
	.createApp()
	.use('/list', authMiddleware)
	.use('/estimate', authMiddleware)
	.use('/upload', authMiddleware)
	.get(
		'/list',
		describeRoute({
			summary: 'List all 3D models',
			description: 'Retrieves a list of all 3D models available for printing.',
			tags: ['Printer'],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: z.array(
								z.object({
									stl: z.string().describe('The STL file name'),
									size: z
										.number()
										.describe('The size of the STL file in bytes'),
									version: z.string().describe('The version of the STL file'),
								})
							),
						},
					},
					description: 'List of 3D models',
				},
				500: {
					content: {
						'application/json': {
							schema: z.object({
								error: z.string(),
							}),
						},
					},
					description: 'Failed to retrieve list',
				},
			},
		}),
		async (c: Context) => {
			const list = await c.env.BUCKET.list();
			const data = list.objects.map((o: ListResponse) => {
				return {
					stl: o.key,
					size: o.size,
					version: o.version,
				};
			});
			return c.json(data);
		}
	)
	.post(
		'/upload',
		describeRoute({
			description: 'Upload a file to the bucket',
			tags: ['Printer'],
			requestBody: {
				content: {
					'multipart/form-data': {
						schema: z.object({
							file: z.instanceof(File).describe('The file to upload'),
						}),
					},
				},
				required: true,
			},
			responses: {
				200: {
					content: {
						'application/json': {
							schema: z.object({
								message: z.string(),
								key: z.string(),
								url: z.string(),
							}),
						},
					},
					description: 'File uploaded successfully',
				},
				400: {
					content: {
						'application/json': {
							schema: z.object({
								error: z.string(),
							}),
						},
					},
					description: 'No file uploaded',
				},
				500: {
					content: {
						'application/json': {
							schema: z.object({
								error: z.string(),
							}),
						},
					},
					description: 'Failed to upload file',
				},
			},
		}),
		async (c: Context) => {
			const body = await c.req.parseBody();

			if (!body || !body.file) {
				return c.json({ error: 'No file uploaded' }, 400);
			}

			const file = body.file as File;
			const mimeTypeStl = file.type === 'model/stl';
			const mimeTypePng = file.type === 'image/png';

			const acceptableExtensionStl = file.name.toLowerCase().endsWith('.stl');
			const acceptableExtensionPng = file.name.toLowerCase().endsWith('.png');

			// if(!mimeTypeStl && !acceptableExtensionStl || !mimeTypePng && !acceptableExtensionPng) {
			// 	return c.json({ error: 'Invalid file type or extension' }, 415);
			// }
			const bucketSTL = c.env.BUCKET;
			const bucketPNG = c.env.PHOTO_BUCKET;
			const key = `${file.name}`;
			const cleanKey = dashFilename(key);


			switch (acceptableExtensionPng || mimeTypePng || acceptableExtensionStl || mimeTypeStl) {
				case mimeTypeStl || acceptableExtensionStl:
					try {
						await bucketSTL.put(cleanKey, file.stream(), {
							httpMetadata: { contentType: 'model/stl' },
						});

						const base = c.env.R2_PUBLIC_BASE_URL || new URL(c.req.url).origin;
						const url = `${base}/${encodeURIComponent(cleanKey)}`;

						return c.json({ message: 'File uploaded', key: cleanKey, url });
					} catch (error) {
						console.error('error', error);
						return c.json({ error: 'Failed to upload file' }, 500);
					}
				case mimeTypePng || acceptableExtensionPng:
					try {
						await bucketPNG.put(cleanKey, file.stream(), {
							httpMetadata: { contentType: 'image/png' },
						});

						const base = c.env.R2_PHOTO_BASE_URL || new URL(c.req.url).origin;
						const url = `${base}/${encodeURIComponent(cleanKey)}`;

						return c.json({ message: 'File uploaded', key: cleanKey, url });
					} catch (error) {
						console.error('error', error);
						return c.json({ error: 'Failed to upload file' }, 500);
					}
					default:
						return c.json({ error: 'Invalid file type or extension' }, 415);

			}

		}
	)
	/**
	 * Lists the available colors for the filament
	 * @param filamentType The type of filament to list colors for (PLA or PETG)
	 * @returns The list of colors for the filament
	 */
	.post('/slice', async (c: Context) => {
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
	})
	.get(
		'/colors',
		describeRoute({
			summary: 'Get available filament colors',
			description: 'Retrieves a list of available filament colors.',
			tags: ['Printer'],
			parameters: [
				{
					name: 'filamentType',
					in: 'query',
					required: false,
					schema: FilamentTypeSchema,
					description: 'Filter colors by filament type (PLA or PETG)',
				},
			],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: z.array(
								z.object({
									filament: z.string(),
									hexColor: z.string(),
									colorTag: z.string(),
								})
							),
						},
					},
					description: 'List of filament colors',
				},
				400: {
					content: {
						'application/json': {
							schema: z.object({
								error: z.string(),
								message: z.string(),
							}),
						},
					},
					description: 'Invalid filament type',
				},
				500: {
					content: {
						'application/json': {
							schema: z.object({
								error: z.string(),
								details: z.any(),
							}),
						},
					},
					description: 'Failed to retrieve colors',
				},
			},
		}),
		async (c: Context) => {
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

			const result = (await response.json()) as FilamentColorsResponse;

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
		}
	)
	.get(
		'/v2/colors',
		describeRoute({
			summary: 'Get available filaments (V2 API)',
			description: 'Retrieves filaments from Slant3D V2 API with enhanced metadata including publicId, availability, and provider information.',
			tags: ['Printer'],
			parameters: [
				{
					name: 'profile',
					in: 'query',
					required: false,
					schema: z.enum(['PLA', 'PETG', 'ABS']),
					description: 'Filter by material type',
				},
				{
					name: 'available',
					in: 'query',
					required: false,
					schema: z.enum(['true', 'false']),
					description: 'Filter by availability status',
				},
				{
					name: 'provider',
					in: 'query',
					required: false,
					schema: z.string(),
					description: 'Filter by filament provider/manufacturer',
				},
			],
			responses: {
				200: {
					content: {
						'application/json': {
							schema: z.object({
								success: z.boolean(),
								message: z.string(),
								data: z.array(
									z.object({
										publicId: z.string().describe('UUID for order placement'),
										name: z.string().describe('Filament display name'),
										provider: z.string().describe('Manufacturer/brand'),
										profile: z.enum(['PLA', 'PETG', 'ABS']).describe('Material type'),
										color: z.string().describe('Color description'),
										hexValue: z.string().describe('Hex color code'),
										public: z.boolean().describe('Public visibility'),
										available: z.boolean().describe('In-stock status'),
									})
								),
								count: z.number(),
								lastUpdated: z.string().optional(),
							}),
						},
					},
					description: 'Filaments retrieved successfully',
				},
				400: {
					content: {
						'application/json': {
							schema: z.object({
								success: z.boolean(),
								message: z.string(),
								error: z.string(),
							}),
						},
					},
					description: 'Invalid query parameters',
				},
				500: {
					content: {
						'application/json': {
							schema: z.object({
								success: z.boolean(),
								message: z.string(),
								error: z.string(),
							}),
						},
					},
					description: 'Failed to retrieve filaments',
				},
			},
		}),
		async (c: Context) => {
			const profileQuery = c.req.query('profile')?.toUpperCase();
			const availableQuery = c.req.query('available');
			const providerQuery = c.req.query('provider');

			// Build cache key from query parameters
			const cacheKey = `v2:colors:${profileQuery || 'all'}:${availableQuery || 'all'}:${providerQuery || 'all'}`;

			// Check cache first
			const cachedResponse = await c.env.COLOR_CACHE.get(cacheKey);
			if (cachedResponse) {
				console.log(`Cache hit for key: ${cacheKey}`);
				return c.json(JSON.parse(cachedResponse));
			}

			// Validate query parameters
			if (profileQuery && !['PLA', 'PETG', 'ABS'].includes(profileQuery)) {
				return c.json(
					{
						success: false,
						message: 'Invalid profile parameter',
						error: 'Accepted values are "PLA", "PETG", or "ABS"',
					},
					400
				);
			}

			if (availableQuery && !['true', 'false'].includes(availableQuery)) {
				return c.json(
					{
						success: false,
						message: 'Invalid available parameter',
						error: 'Accepted values are "true" or "false"',
					},
					400
				);
			}

			try {
				// Call Slant3D V2 API
				const response = await fetch(`${BASE_URL_V2}filaments`, {
					method: 'GET',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${c.env.SLANT_API_V2}`,
					},
				});

				if (!response.ok) {
					const error = (await response.json()) as ErrorResponse;
					return c.json(
						{
							success: false,
							message: 'Failed to retrieve filaments from Slant3D V2 API',
							error: error.error || 'Unknown error',
						},
						500
					);
				}

				const result = (await response.json()) as FilamentV2Response;

				// Apply filters
				let filteredData = result.data;

				if (profileQuery) {
					filteredData = filteredData.filter(
						(filament) => filament.profile === profileQuery
					);
				}

				if (availableQuery) {
					const availableBool = availableQuery === 'true';
					filteredData = filteredData.filter(
						(filament) => filament.available === availableBool
					);
				}

				if (providerQuery) {
					filteredData = filteredData.filter((filament) =>
						filament.provider.toLowerCase().includes(providerQuery.toLowerCase())
					);
				}

				// Sort by color name for consistent ordering
				filteredData.sort((a, b) => a.color.localeCompare(b.color));

				const responseData = {
					success: true,
					message: 'Filaments retrieved successfully',
					data: filteredData,
					count: filteredData.length,
					lastUpdated: result.lastUpdated || new Date().toISOString(),
				};

				// Cache the response for 7 days
				await c.env.COLOR_CACHE.put(cacheKey, JSON.stringify(responseData), {
					expirationTtl: 604800, // 7 days
				});

				return c.json(responseData);
			} catch (error: any) {
				console.error('Error fetching V2 filaments:', error);
				return c.json(
					{
						success: false,
						message: 'Failed to retrieve filaments',
						error: error.message || 'Internal server error',
					},
					500
				);
			}
		}
	)
	.post('/estimate', async (c: Context) => {
		try {
			const data = await c.req.json();
			const parsedData: OrderData = orderSchema.parse(data);

			const response = await fetch(`${BASE_URL}order/estimate`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'api-key': c.env.SLANT_API,
				},
				body: JSON.stringify(parsedData),
			});

			if (!response.ok) {
				const error = await response.json();
				return c.json(
					{ error: 'Failed to estimate order', details: error },
					500
				);
			}

			const result = (await response.json()) as OrderResponse;
			return c.json(result);
		} catch (error) {
			if (error instanceof z.ZodError) {
				return c.json({ error: error.errors }, 400);
			}
			return c.json({ error: 'Failed to estimate order' }, 500);
		}
	})
	.post(
		'/v2/upload',
		describeRoute({
			summary: 'Upload file and register with Slant3D V2 API',
			description: 'Upload STL file to R2 bucket and register it with Slant3D V2 API for order processing. Returns both local file info and Slant3D file ID.',
			tags: ['Printer'],
			requestBody: {
				content: {
					'multipart/form-data': {
						schema: z.object({
							file: z.instanceof(File).describe('STL file to upload'),
							ownerId: z.string().optional().describe('Your application user ID for tracking'),
						}),
					},
				},
				required: true,
			},
			responses: {
				201: {
					content: {
						'application/json': {
							schema: z.object({
								success: z.boolean(),
								message: z.string(),
								data: z.object({
									local: z.object({
										key: z.string().describe('File key in R2 bucket'),
										url: z.string().describe('R2 public URL'),
										name: z.string(),
									}),
									slant3D: z.object({
										publicFileServiceId: z.string().describe('UUID for use in orders'),
										name: z.string(),
										fileURL: z.string(),
										metrics: z.object({
											x: z.number().describe('Width in mm'),
											y: z.number().describe('Depth in mm'),
											z: z.number().describe('Height in mm'),
											weight: z.number().describe('Weight in grams'),
											volume: z.number().describe('Volume in cubic cm'),
											surfaceArea: z.number().describe('Surface area in sq mm'),
											imageURL: z.string().describe('Preview image URL'),
										}).optional(),
									}),
								}),
							}),
						},
					},
					description: 'File uploaded and registered successfully',
				},
				400: {
					content: {
						'application/json': {
							schema: z.object({
								success: z.boolean(),
								error: z.string(),
							}),
						},
					},
					description: 'Invalid file or missing parameters',
				},
				500: {
					content: {
						'application/json': {
							schema: z.object({
								success: z.boolean(),
								error: z.string(),
								details: z.any(),
							}),
						},
					},
					description: 'Upload or registration failed',
				},
			},
		}),
		async (c: Context) => {
			try {
				const body = await c.req.parseBody();

				if (!body || !body.file) {
					return c.json(
						{ success: false, error: 'No file uploaded' },
						400
					);
				}

				const file = body.file as File;
				const ownerId = (body.ownerId as string) || 'anonymous';

				// Validate file is STL
				const isStl =
					file.type === 'model/stl' ||
					file.name.toLowerCase().endsWith('.stl');

				if (!isStl) {
					return c.json(
						{
							success: false,
							error: 'Invalid file type. Only STL files are supported.',
						},
						400
					);
				}

				// Step 1: Upload to R2 bucket
				const cleanKey = dashFilename(file.name);
				const bucket = c.env.BUCKET;

				await bucket.put(cleanKey, file.stream(), {
					httpMetadata: { contentType: 'model/stl' },
				});

				const baseUrl = c.env.R2_PUBLIC_BASE_URL || 'https://cdn.example.com';
				const publicUrl = `${baseUrl}/${encodeURIComponent(cleanKey)}`;

				// Step 2: Register file with Slant3D V2 API
				const slant3DResponse = await fetch(
					`${BASE_URL_V2}files`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${c.env.SLANT_API}`,
						},
						body: JSON.stringify({
							URL: publicUrl,
							name: file.name.replace(/\.stl$/i, ''),
							platformId: c.env.SLANT_PLATFORM_ID,
							ownerId,
							type: 'stl',
						}),
					}
				);

				if (!slant3DResponse.ok) {
					const error = await slant3DResponse.json();
					return c.json(
						{
							success: false,
							error: 'Failed to register file with Slant3D V2 API',
							details: error,
						},
						500
					);
				}

				const slant3DData =
					(await slant3DResponse.json()) as Slant3DFileResponse;

				return c.json(
					{
						success: true,
						message: 'File uploaded and registered successfully',
						data: {
							local: {
								key: cleanKey,
								url: publicUrl,
								name: file.name,
							},
							slant3D: {
								publicFileServiceId:
									slant3DData.data.publicFileServiceId,
								name: slant3DData.data.name,
								fileURL: slant3DData.data.fileURL,
								metrics: slant3DData.data.STLMetrics,
							},
						},
					},
					201
				);
			} catch (error: any) {
				console.error('V2 Upload error:', error);
				return c.json(
					{
						success: false,
						error: 'Failed to upload file',
						details: error.message,
					},
					500
				);
			}
		}
	);

export default printer;
