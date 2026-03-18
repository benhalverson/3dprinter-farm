import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { BASE_URL, BASE_URL_V2 } from '../constants';
import { orderSchema, uploadedFilesTable } from '../db/schema';
import factory from '../factory';
import type {
  ErrorResponse,
  FilamentColorsResponse,
  FilamentV2Response,
  ListResponse,
  OrderData,
  OrderResponse,
  SliceResponse,
} from '../types';
import { authMiddleware } from '../utils/authMiddleware';
import { dashFilename } from '../utils/dash';
import {
  confirmUploadDoc,
  estimateV2Doc,
  getColorsDoc,
  getFilamentsV2Doc,
  getUploadedFileDoc,
  getUploadedFilesDoc,
  listModelsDoc,
  presignedUploadDoc,
  uploadFileDoc,
  v2UploadDoc,
} from './docs/printer-docs';
import { FilamentTypeSchema } from './schemas/printer-schemas';

const printer = factory
  .createApp()
  .use('/list', authMiddleware)
  .use('/estimate', authMiddleware)
  .use('/upload', authMiddleware)
  .get('/list', describeRoute(listModelsDoc), async (c: Context) => {
    const list = await c.env.BUCKET.list();
    const data = list.objects.map((o: ListResponse) => {
      return {
        stl: o.key,
        size: o.size,
        version: o.version,
      };
    });
    return c.json(data);
  })
  .post('/upload', describeRoute(uploadFileDoc), async (c: Context) => {
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

    switch (
      acceptableExtensionPng ||
      mimeTypePng ||
      acceptableExtensionStl ||
      mimeTypeStl
    ) {
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
  })
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
        const error = (await response.json()) as ErrorResponse;
        return c.json({ error: 'Failed to slice file', details: error }, 500);
      }

      const result = (await response.json()) as SliceResponse;
      return c.json(result);
    } catch (error: unknown) {
      console.error('error', error);
      return c.json(
        {
          error: 'Failed to slice file',
          details: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  })
  .get('/colors', describeRoute(getColorsDoc), async (c: Context) => {
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
          400,
        );
      }
    }

    const response = await fetch(`${BASE_URL}filament`, {
      headers: {
        'Content-Type': 'application/json',
        'api-key': c.env.SLANT_API,
      },
    });

    console.log('Fetching colors from v1 API', response);
    if (!response.ok) {
      const error = (await response.json()) as ErrorResponse;
      return c.json({ error: 'Failed to get colors', details: error }, 500);
    }

    const result = (await response.json()) as FilamentColorsResponse;

    const filteredFilaments = result.filaments
      .filter(filament => !query || filament.profile === query) // Return all if no query, or filter by query
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
  })
  .get('/v2/colors', describeRoute(getFilamentsV2Doc), async (c: Context) => {
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
        400,
      );
    }

    if (availableQuery && !['true', 'false'].includes(availableQuery)) {
      return c.json(
        {
          success: false,
          message: 'Invalid available parameter',
          error: 'Accepted values are "true" or "false"',
        },
        400,
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
          500,
        );
      }

      const result = (await response.json()) as FilamentV2Response;

      // Apply filters
      let filteredData = result.data;

      if (profileQuery) {
        filteredData = filteredData.filter(
          filament => filament.profile === profileQuery,
        );
      }

      if (availableQuery) {
        const availableBool = availableQuery === 'true';
        filteredData = filteredData.filter(
          filament => filament.available === availableBool,
        );
      }

      if (providerQuery) {
        filteredData = filteredData.filter(filament =>
          filament.provider.toLowerCase().includes(providerQuery.toLowerCase()),
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
    } catch (error: unknown) {
      console.error('Error fetching V2 filaments:', error);
      return c.json(
        {
          success: false,
          message: 'Failed to retrieve filaments',
          error:
            error instanceof Error ? error.message : 'Internal server error',
        },
        500,
      );
    }
  })
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
          500,
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
  .post('/v2/estimate', describeRoute(estimateV2Doc), async (c: Context) => {
    try {
      const body = await c.req.json();

      // Extract publicFileServiceId
      const { publicFileServiceId } = body;

      if (!publicFileServiceId) {
        return c.json(
          {
            success: false,
            error: 'publicFileServiceId is required',
          },
          400,
        );
      }

      // Support both formats: direct properties or nested in options
      // Slant3D API expects: { options: { filamentId, quantity, slicer } }
      const options = body.options || {};
      const filamentId = options.filamentId || body.filamentId;
      const quantity = options.quantity ?? body.quantity ?? 1;
      const slicer = options.slicer || body.slicer;

      // Default to PLA BLACK if no filament specified
      const DEFAULT_BLACK_FILAMENT_ID = '76fe1f79-3f1e-43e4-b8f4-61159de5b93c';
      const effectiveFilamentId = filamentId || DEFAULT_BLACK_FILAMENT_ID;

      const estimateRequest = {
        options: {
          filamentId: effectiveFilamentId,
          quantity: quantity,
          ...(slicer && { slicer }),
        },
      };

      const estimateUrl = `${BASE_URL_V2}files/${publicFileServiceId}/estimate`;
      console.log('=== Slant3D Estimate Request ===');
      console.log('URL:', estimateUrl);
      console.log('Body:', JSON.stringify(estimateRequest));
      console.log(
        'Authorization:',
        c.env.SLANT_API_V2 ? 'Bearer [REDACTED]' : 'MISSING!',
      );

      const response = await fetch(estimateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.env.SLANT_API_V2}`,
        },
        body: JSON.stringify(estimateRequest),
      });

      console.log(
        'Slant3D Response Status:',
        response.status,
        response.statusText,
      );

      if (!response.ok) {
        let errorDetails: unknown;
        let rawText = '';
        try {
          rawText = await response.text();
          console.log('Raw error response:', rawText);
          errorDetails = rawText ? JSON.parse(rawText) : {};
        } catch (e) {
          console.error('Error parsing Slant3D response:', e);
          errorDetails = rawText || 'Failed to parse error body';
        }

        console.error('=== Slant3D Estimate Error ===');
        console.error('Status:', response.status);
        console.error('Error body:', errorDetails);
        console.error('Possible causes:');
        console.error(
          '- publicFileServiceId does not exist:',
          publicFileServiceId,
        );
        console.error('- Invalid API key');
        console.error('- File not yet processed by Slant3D');

        return c.json(
          {
            success: false,
            error: 'Failed to estimate file price from Slant3D V2 API',
            details: errorDetails,
            publicFileServiceId: publicFileServiceId,
            status: response.status,
            hint:
              response.status === 500
                ? 'File may not exist in Slant3D. Did you upload via /v2/presigned-upload and /v2/confirm?'
                : 'Check request parameters',
          },
          response.status === 400 ? 400 : 500,
        );
      }

      const estimateData = (await response.json()) as {
        data: {
          publicFileServiceId: string;
          estimatedCost: number;
          quantity: number;
          filamentId: string;
          slicer?: Record<string, unknown>;
        };
      };

      console.log('=== Estimate Success ===');
      console.log('Response data:', JSON.stringify(estimateData));

      return c.json(
        {
          success: true,
          message: 'File price estimated successfully',
          data: estimateData.data,
        },
        200,
      );
    } catch (error: unknown) {
      console.error('=== V2 Estimate Catch Error ===');
      console.error('Error:', JSON.stringify(error));
      return c.json(
        {
          success: false,
          error: 'Failed to estimate file price',
          details: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  })
  .post(
    '/v2/presigned-upload',
    authMiddleware,
    describeRoute(presignedUploadDoc),
    async (c: Context) => {
      try {
        console.log('=== /v2/upload endpoint called ===');
        console.log('Request method:', c.req.method);
        console.log('Request URL:', c.req.url);

        let requestBody: unknown;
        try {
          console.log('About to parse request JSON...');
          requestBody = await c.req.json();
          console.log(
            'Successfully parsed request JSON:',
            JSON.stringify(requestBody),
          );
        } catch (parseError: unknown) {
          console.error(
            'ERROR parsing request JSON:',
            parseError instanceof Error
              ? parseError.message
              : String(parseError),
          );
          console.error(
            'Parse error stack:',
            parseError instanceof Error ? parseError.stack : 'N/A',
          );
          return c.json(
            {
              success: false,
              error: 'Failed to parse request JSON',
              details:
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError),
            },
            400,
          );
        }

        const { fileName } = requestBody as Record<string, unknown>;
        const fileNameStr = String(fileName);
        const ownerId = c.get('userId') as string | undefined;
        console.log('Extracted fileName:', fileName, 'ownerId:', ownerId);

        if (!ownerId) {
          return c.json({ success: false, error: 'Unauthorized' }, 401);
        }

        if (!fileName) {
          return c.json({ success: false, error: 'fileName is required' }, 400);
        }

        if (!c.env.SLANT_PLATFORM_ID) {
          return c.json(
            {
              success: false,
              error: 'Missing SLANT_PLATFORM_ID environment variable.',
            },
            500,
          );
        }

        // Validate file is STL
        if (!fileNameStr.toLowerCase().endsWith('.stl')) {
          return c.json(
            {
              success: false,
              error: 'Invalid file type. Only STL files are supported.',
            },
            400,
          );
        }

        // Request presigned URL from Slant3D V2 API
        const presignedRequest = {
          name: fileNameStr.replace(/\.stl$/i, ''),
          platformId: c.env.SLANT_PLATFORM_ID,
          ownerId: ownerId,
        };

        console.log('Presigned request:', JSON.stringify(presignedRequest));
        console.log('Fetching from:', `${BASE_URL_V2}files/direct-upload`);

        const slant3DResponse = await fetch(
          `${BASE_URL_V2}files/direct-upload`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${c.env.SLANT_API_V2}`,
            },
            body: JSON.stringify(presignedRequest),
          },
        );

        console.log('Response status:', slant3DResponse.status);
        console.log('Response ok:', slant3DResponse.ok);

        if (!slant3DResponse.ok) {
          let errorDetails: unknown;
          const responseText = await slant3DResponse.text();
          console.log('Response text:', responseText);
          try {
            errorDetails = JSON.parse(responseText);
          } catch (_e) {
            errorDetails = responseText;
          }

          return c.json(
            {
              success: false,
              error: 'Failed to generate presigned URL from Slant3D V2 API',
              details: errorDetails,
              status: slant3DResponse.status,
            },
            500,
          );
        }

        console.log('Response ok, parsing JSON...');
        const slant3DData = await slant3DResponse.json();
        console.log('Presigned URL obtained successfully');

        return c.json(
          {
            success: true,
            message:
              'Presigned URL generated successfully. Upload file to presignedUrl, then call /v2/confirm.',
            data: {
              presignedUrl: (
                slant3DData as unknown as { data: { presignedUrl: string } }
              ).data.presignedUrl,
              key: (slant3DData as unknown as { data: { key: string } }).data
                .key,
              filePlaceholder: (
                slant3DData as unknown as { data: { filePlaceholder: unknown } }
              ).data.filePlaceholder,
            },
          },
          200,
        );
      } catch (error: unknown) {
        console.error('=== CATCH BLOCK ===');
        console.error('Presigned upload error:', error);
        console.error(
          'Error stack:',
          error instanceof Error ? error.stack : 'N/A',
        );
        console.error(
          'Error message:',
          error instanceof Error ? error.message : String(error),
        );
        return c.json(
          {
            success: false,
            error: 'Failed to generate presigned URL',
            details: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    },
  )
  .post('/v2/confirm', authMiddleware, describeRoute(confirmUploadDoc), async (c: Context) => {
    try {
      const { filePlaceholder } = await c.req.json();

      if (!filePlaceholder) {
        return c.json(
          { success: false, error: 'filePlaceholder is required' },
          400,
        );
      }

      // Confirm upload with Slant3D V2 API
      const confirmRequest = {
        filePlaceholder,
      };

      const slant3DResponse = await fetch(
        `${BASE_URL_V2}files/confirm-upload`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${c.env.SLANT_API_V2}`,
          },
          body: JSON.stringify(confirmRequest),
        },
      );

      console.log('confirmation Response status:', slant3DResponse);

      if (!slant3DResponse.ok) {
        let errorDetails: unknown;
        try {
          errorDetails = await slant3DResponse.json();
        } catch (e) {
          console.error(`Error parsing Slant3D response:`, e);
          errorDetails = await slant3DResponse.text();
        }

        return c.json(
          {
            success: false,
            error: 'Failed to confirm upload with Slant3D V2 API',
            details: errorDetails,
          },
          500,
        );
      }

      const slant3DData = await slant3DResponse.json();

      return c.json(
        {
          success: true,
          message: 'Upload confirmed and file processed successfully',
          data: {
            publicFileServiceId: (
              slant3DData as unknown as {
                data: { publicFileServiceId: string };
              }
            ).data.publicFileServiceId,
            name: (slant3DData as unknown as { data: { name: string } }).data
              .name,
            fileURL: (slant3DData as unknown as { data: { fileURL: string } })
              .data.fileURL,
            STLMetrics: (
              slant3DData as unknown as { data: { STLMetrics: unknown } }
            ).data.STLMetrics,
          },
        },
        200,
      );
    } catch (error: unknown) {
      console.error('Presigned confirm error:', error);
      return c.json(
        {
          success: false,
          error: 'Failed to confirm upload',
          details: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  })
  .post('/v2/upload', authMiddleware, describeRoute(v2UploadDoc), async (c: Context) => {
    try {
      const body = await c.req.parseBody();

      if (!body || !body.file) {
        return c.json(
          {
            success: false,
            error: 'No file uploaded',
            details: 'Please provide a file in the "file" field',
          },
          400,
        );
      }

      const file = body.file as File;
      const userId = c.get('userId'); // From auth middleware

      // Read file buffer immediately before any validation (body can only be read once)
      const fileBuffer = await file.arrayBuffer();
      const fileName = file.name;
      const fileSize = file.size;
      const fileType = file.type;

      // Validate file properties (without creating a new File object)
      const isStl =
        fileType === 'model/stl' || fileName.toLowerCase().endsWith('.stl');
      const isEmpty = fileSize === 0;
      const isTooLarge = fileSize > 100 * 1024 * 1024; // 100MB

      if (!isStl) {
        return c.json(
          {
            success: false,
            error: 'File validation failed',
            details: 'File must be a .stl file',
            validationRules: {
              fileType: 'Must be a .stl file',
              maxSize: '100MB',
              minSize: 'Must not be empty',
            },
          },
          400,
        );
      }

      if (isEmpty) {
        return c.json(
          {
            success: false,
            error: 'File validation failed',
            details: 'File is empty',
            validationRules: {
              fileType: 'Must be a .stl file',
              maxSize: '100MB',
              minSize: 'Must not be empty',
            },
          },
          400,
        );
      }

      if (isTooLarge) {
        return c.json(
          {
            success: false,
            error: 'File validation failed',
            details: 'File is too large (max 100MB)',
            validationRules: {
              fileType: 'Must be a .stl file',
              maxSize: '100MB',
              minSize: 'Must not be empty',
            },
          },
          400,
        );
      }

      console.log('\n=== V2 Upload Workflow Started ===');
      console.log('File name:', fileName);
      console.log('File size:', fileSize);
      console.log('User ID:', userId);

      // Step 1: Request presigned upload URL via local endpoint
      console.log('\nStep 1: Requesting presigned URL...');
      const presignedLocalResponse = await fetch(
        new URL('/v2/presigned-upload', c.req.url).toString(),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fileName: fileName,
            ownerId: userId?.toString() || 'anonymous',
          }),
        },
      );

      if (!presignedLocalResponse.ok) {
        const errorText = await presignedLocalResponse.text();
        console.error('Presigned URL error:', errorText);
        let errorDetails: unknown;
        try {
          errorDetails = JSON.parse(errorText);
        } catch {
          errorDetails = errorText;
        }
        return c.json(
          {
            success: false,
            error: 'Failed to get presigned URL',
            details: errorDetails,
          },
          500,
        );
      }

      const presignedData = (await presignedLocalResponse.json()) as {
        success: boolean;
        data: { presignedUrl: string; filePlaceholder: unknown; key: string };
      };

      const { presignedUrl, filePlaceholder } = presignedData.data;
      console.log('✓ Presigned URL obtained');

      // Step 2: Upload file to presigned URL (Slant3D's S3)
      console.log('\nStep 2: Uploading file to S3...');

      const uploadResponse = await fetch(presignedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: fileBuffer,
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error('S3 upload error:', errorText);
        return c.json(
          {
            success: false,
            error: 'Failed to upload file to S3',
            details: errorText,
          },
          500,
        );
      }

      console.log(`✓ File uploaded to S3 (HTTP ${uploadResponse.status})`);

      // Step 3: Confirm upload via local endpoint
      console.log('\nStep 3: Confirming upload...');
      const confirmLocalResponse = await fetch(
        new URL('/v2/confirm', c.req.url).toString(),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ filePlaceholder }),
        },
      );

      if (!confirmLocalResponse.ok) {
        const errorText = await confirmLocalResponse.text();
        console.error('Confirm upload error:', errorText);
        let errorDetails: unknown;
        try {
          errorDetails = JSON.parse(errorText);
        } catch {
          errorDetails = errorText;
        }
        return c.json(
          {
            success: false,
            error: 'Failed to confirm upload',
            details: errorDetails,
          },
          500,
        );
      }

      const confirmData = (await confirmLocalResponse.json()) as {
        success: boolean;
        data: {
          publicFileServiceId: string;
          name: string;
          fileURL: string;
          STLMetrics: {
            dimensionX: number;
            dimensionY: number;
            dimensionZ: number;
            volume: number;
            weight: number;
            surfaceArea: number;
          };
        };
      };

      const { publicFileServiceId, fileURL, STLMetrics } = confirmData.data;
      console.log('✓ Upload confirmed');
      console.log('Public File Service ID:', publicFileServiceId);

      // Step 4: Get estimate with default PLA BLACK, quantity 1 via local endpoint
      console.log('\nStep 4: Getting price estimate...');
      const defaultFilamentId = '76fe1f79-3f1e-43e4-b8f4-61159de5b93c'; // PLA BLACK
      const estimateLocalResponse = await fetch(
        new URL('/v2/estimate', c.req.url).toString(),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            publicFileServiceId,
            options: {
              filamentId: defaultFilamentId,
              quantity: 1,
            },
          }),
        },
      );

      if (!estimateLocalResponse.ok) {
        const errorText = await estimateLocalResponse.text();
        console.error('Estimate error:', errorText);
        return c.json(
          {
            success: false,
            error: 'Failed to estimate file price from Slant3D V2 API',
            details: errorText,
          },
          500,
        );
      }

      const estimateData = (await estimateLocalResponse.json()) as {
        success: boolean;
        data?: {
          estimatedCost?: number;
          total?: number;
          pricePerUnit?: number;
          subtotal?: number;
          quantity?: number;
        };
        error?: unknown;
      };

      const costCandidate = [
        estimateData.data?.estimatedCost,
        estimateData.data?.total,
        estimateData.data?.pricePerUnit,
        estimateData.data?.subtotal,
      ].find(v => typeof v === 'number') as number | undefined;

      if (!estimateData.success || typeof costCandidate !== 'number') {
        console.error('Estimate response missing cost:', estimateData);
        return c.json(
          {
            success: false,
            error: 'Failed to estimate file price from Slant3D V2 API',
            details:
              estimateData.error ??
              (estimateData.success
                ? 'Estimated cost not returned'
                : 'Estimate call did not succeed'),
          },
          500,
        );
      }

      const estimatedCost = costCandidate;
      console.log(`✓ Estimate obtained: $${estimatedCost}`);

      // Step 5: Save to database
      console.log('\nStep 5: Saving to database...');
      const uploadRecord = {
        userId: userId || null,
        publicFileServiceId,
        fileName: file.name,
        fileURL,
        dimensionX: STLMetrics?.dimensionX || null,
        dimensionY: STLMetrics?.dimensionY || null,
        dimensionZ: STLMetrics?.dimensionZ || null,
        volume: STLMetrics?.volume || null,
        weight: STLMetrics?.weight || null,
        surfaceArea: STLMetrics?.surfaceArea || null,
        defaultFilamentId,
        estimatedCost,
        estimatedQuantity: 1,
      };

      let savedRecord: typeof uploadedFilesTable.$inferSelect | undefined;

      try {
        const dbResult = await c.var.db
          .insert(uploadedFilesTable)
          .values(uploadRecord)
          .returning();

        savedRecord = dbResult[0];
      } catch (err) {
        const isUniquePublicId =
          err instanceof Error &&
          err.message.includes(
            'UNIQUE constraint failed: uploaded_files.public_file_service_id',
          );

        if (!isUniquePublicId) {
          throw err;
        }

        console.warn(
          'Duplicate publicFileServiceId detected, updating existing record instead of inserting',
        );

        const updatePayload = {
          fileName: uploadRecord.fileName,
          fileURL: uploadRecord.fileURL,
          dimensionX: uploadRecord.dimensionX,
          dimensionY: uploadRecord.dimensionY,
          dimensionZ: uploadRecord.dimensionZ,
          volume: uploadRecord.volume,
          weight: uploadRecord.weight,
          surfaceArea: uploadRecord.surfaceArea,
          defaultFilamentId: uploadRecord.defaultFilamentId,
          estimatedCost: uploadRecord.estimatedCost,
          estimatedQuantity: uploadRecord.estimatedQuantity,
          updatedAt: new Date(),
        } as const;

        const updated = await c.var.db
          .update(uploadedFilesTable)
          .set(
            uploadRecord.userId
              ? { ...updatePayload, userId: uploadRecord.userId }
              : updatePayload,
          )
          .where(
            eq(uploadedFilesTable.publicFileServiceId, publicFileServiceId),
          )
          .returning();

        savedRecord = updated[0];
      }

      console.log('✓ Saved to database, ID:', savedRecord?.id);
      console.log('=== V2 Upload Workflow Completed ===\n');

      return c.json(
        {
          success: true,
          message: 'File uploaded and estimate saved successfully',
          data: {
            id: savedRecord?.id,
            publicFileServiceId,
            fileName: file.name,
            fileURL,
            STLMetrics,
            estimate: {
              filamentId: defaultFilamentId,
              filamentName: 'PLA BLACK',
              quantity: 1,
              cost: estimatedCost,
            },
          },
        },
        201,
      );
    } catch (error: unknown) {
      console.error('=== V2 Upload Error ===');
      console.error('Error:', error);
      console.error('Stack:', error instanceof Error ? error.stack : 'N/A');
      return c.json(
        {
          success: false,
          error: 'Failed to upload file',
          details: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  })
  .get(
    '/v2/uploads/:id',
    authMiddleware,
    describeRoute(getUploadedFileDoc),
    async (c: Context) => {
      try {
        const id = c.req.param('id');
        const userId = c.get('userId');

        // Check if ID is numeric or UUID
        const isNumeric = /^\d+$/.test(id);
        const result = isNumeric
          ? await c.var.db
              .select()
              .from(uploadedFilesTable)
              .where(eq(uploadedFilesTable.id, parseInt(id, 10)))
          : await c.var.db
              .select()
              .from(uploadedFilesTable)
              .where(eq(uploadedFilesTable.publicFileServiceId, id));

        if (!result || result.length === 0) {
          return c.json(
            {
              success: false,
              error: 'File not found',
            },
            404,
          );
        }

        const file = result[0];

        // Enforce ownership: users can only access their own files
        if (file.userId && file.userId !== userId) {
          return c.json(
            {
              success: false,
              error: 'Unauthorized: you do not own this file',
            },
            403,
          );
        }

        return c.json(
          {
            success: true,
            message: 'File retrieved successfully',
            data: file,
          },
          200,
        );
      } catch (error: unknown) {
        console.error('Get uploaded file error:', error);
        return c.json(
          {
            success: false,
            error: 'Failed to retrieve file',
            details: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    },
  )
  .get(
    '/v2/uploads',
    authMiddleware,
    describeRoute(getUploadedFilesDoc),
    async (c: Context) => {
      try {
        const userId = c.get('userId');

        // Scope query to authenticated user's files
        const files = await c.var.db
          .select()
          .from(uploadedFilesTable)
          .where(eq(uploadedFilesTable.userId, userId));

        return c.json(
          {
            success: true,
            message: 'Files retrieved successfully',
            count: files.length,
            data: files,
          },
          200,
        );
      } catch (error: unknown) {
        console.error('Get uploaded files error:', error);
        return c.json(
          {
            success: false,
            error: 'Failed to retrieve files',
            details: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    },
  );
export default printer;
