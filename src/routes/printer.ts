import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { BASE_URL_V2 } from '../constants';
import factory from '../factory';
import {
  confirmSlant3DUpload,
  createSlant3DDirectUpload,
  estimateSlant3DFile,
  type Slant3DConfirmUploadData,
  type Slant3DDirectUploadData,
  type Slant3DEstimateData,
  Slant3DFileApiError,
} from '../lib/slant3d-v2-files';
import type {
  ErrorResponse,
  FilamentV2Response,
  ListResponse,
} from '../types';
import { authMiddleware } from '../utils/authMiddleware';
import { uploadPublicFile } from './publicFileUpload';
import {
  confirmUploadDoc,
  estimateV2Doc,
  getFilamentsV2Doc,
  listModelsDoc,
  presignedUploadDoc,
  uploadFileDoc,
} from './docs/printer-docs';

function upstreamErrorStatus(status: number): ContentfulStatusCode {
  return status >= 400 && status < 600 ? (status as ContentfulStatusCode) : 500;
}

const printer = factory
  .createApp()
  .use('/list', authMiddleware)
  .use('/upload', authMiddleware)
  .get('/list', describeRoute(listModelsDoc), async (c: Context) => {
    const ownerId = c.get('userId');
    const list = await c.env.BUCKET.list({ prefix: `users/${encodeURIComponent(ownerId)}/` });
    const data = list.objects.map((o: ListResponse) => {
      return {
        stl: o.key,
        size: o.size,
        version: o.version,
      };
    });
    return c.json(data);
  })
  .post('/upload', describeRoute(uploadFileDoc), uploadPublicFile)
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
      // Entries cached before the Slant-only policy can contain other providers.
      const result: FilamentV2Response = JSON.parse(cachedResponse);
      const data = result.data.filter(
        filament => filament.provider.toLowerCase() === 'slant 3d',
      );
      return c.json({ ...result, data, count: data.length });
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

      filteredData = filteredData.filter(
        filament => filament.provider.toLowerCase() === 'slant 3d',
      );

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

      const estimateOptions = {
        filamentId: effectiveFilamentId,
        quantity,
        ...(slicer && { slicer }),
      };

      const estimateUrl = `${BASE_URL_V2}files/${publicFileServiceId}/estimate`;
      console.log('=== Slant3D Estimate Request ===');
      console.log('URL:', estimateUrl);
      console.log(
        'Body:',
        JSON.stringify({
          options: estimateOptions,
        }),
      );

      let estimateData: Slant3DEstimateData;
      try {
        estimateData = await estimateSlant3DFile(
          c.env,
          publicFileServiceId,
          estimateOptions,
        );
      } catch (error: unknown) {
        if (!(error instanceof Slant3DFileApiError)) {
          throw error;
        }

        console.error('=== Slant3D Estimate Error ===');
        console.error('Status:', error.status);
        console.error('Error body:', error.details);
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
            error: error.message,
            details: error.details,
            publicFileServiceId,
            status: error.status,
            hint:
              error.status === 500
                ? 'File may not exist in Slant3D. Did you upload via /v2/presigned-upload and /v2/confirm?'
                : 'Check request parameters',
          },
          upstreamErrorStatus(error.status),
        );
      }

      if (typeof estimateData.total !== 'number') {
        return c.json(
          {
            success: false,
            error: 'Malformed estimate response from Slant3D V2 API',
          },
          500,
        );
      }

      console.log('=== Estimate Success ===');
      console.log('Response data:', JSON.stringify(estimateData));

      const normalizedEstimateData = {
        ...estimateData,
        publicFileServiceId:
          estimateData.publicFileServiceId ?? publicFileServiceId,
        total: estimateData.total,
        estimatedCost: estimateData.total,
        quantity: estimateData.quantity ?? quantity,
        filamentId: estimateData.filamentId ?? effectiveFilamentId,
        slicer:
          estimateData.slicer ??
          (typeof slicer === 'object' &&
          slicer !== null &&
          !Array.isArray(slicer)
            ? (slicer as Record<string, unknown>)
            : undefined),
      };

      return c.json(
        {
          success: true,
          message: 'File price estimated successfully',
          data: normalizedEstimateData,
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

        console.log(
          'Presigned request:',
          JSON.stringify({
            name: fileNameStr.replace(/\.stl$/i, ''),
            platformId: c.env.SLANT_PLATFORM_ID,
            ownerId,
          }),
        );
        console.log('Fetching from:', `${BASE_URL_V2}files/direct-upload`);

        const slant3DData = await createSlant3DDirectUpload(c.env, {
          name: fileNameStr.replace(/\.stl$/i, ''),
          ownerId,
        });

        if (
          typeof slant3DData.presignedUrl !== 'string' ||
          typeof slant3DData.key !== 'string'
        ) {
          return c.json(
            {
              success: false,
              error: 'Malformed direct upload response from Slant3D V2 API',
            },
            500,
          );
        }

        console.log('Presigned URL obtained successfully');

        return c.json(
          {
            success: true,
            message:
              'Presigned URL generated successfully. Upload file to presignedUrl, then call /v2/confirm.',
            data: {
              presignedUrl: slant3DData.presignedUrl,
              key: slant3DData.key,
              filePlaceholder: slant3DData.filePlaceholder,
            },
          },
          200,
        );
      } catch (error: unknown) {
        if (error instanceof Slant3DFileApiError) {
          return c.json(
            {
              success: false,
              error: error.message,
              details: error.details,
              status: error.status,
            },
            upstreamErrorStatus(error.status),
          );
        }

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
  .post(
    '/v2/confirm',
    authMiddleware,
    describeRoute(confirmUploadDoc),
    async (c: Context) => {
      try {
        const { filePlaceholder } = await c.req.json();

        if (!filePlaceholder) {
          return c.json(
            { success: false, error: 'filePlaceholder is required' },
            400,
          );
        }

        const slant3DData = await confirmSlant3DUpload(c.env, filePlaceholder);

        if (
          !slant3DData.publicFileServiceId ||
          !slant3DData.name ||
          !slant3DData.fileURL
        ) {
          return c.json(
            {
              success: false,
              error: 'Malformed confirm upload response from Slant3D V2 API',
            },
            500,
          );
        }

        return c.json(
          {
            success: true,
            message: 'Upload confirmed and file processed successfully',
            data: {
              publicFileServiceId: slant3DData.publicFileServiceId,
              name: slant3DData.name,
              fileURL: slant3DData.fileURL,
              STLMetrics: slant3DData.STLMetrics,
            },
          },
          200,
        );
      } catch (error: unknown) {
        if (error instanceof Slant3DFileApiError) {
          return c.json(
            {
              success: false,
              error: error.message,
              details: error.details,
            },
            upstreamErrorStatus(error.status),
          );
        }

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
    },
  );
export default printer;
