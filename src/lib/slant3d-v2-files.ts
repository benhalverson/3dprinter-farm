import { slantV2Url } from '../constants';
import type { Bindings } from '../types';

export type Slant3DFilePlaceholder = {
  publicFileServiceId: string;
  name: string;
  ownerId: string;
  platformId: string;
  type: string;
  createdAt: string;
  updatedAt: string;
};

export type Slant3DSTLMetrics = {
  dimensionX: number;
  dimensionY: number;
  dimensionZ: number;
  volume: number;
  weight: number;
  surfaceArea?: number;
  imageURL?: string;
};

export type Slant3DDirectUploadData = {
  presignedUrl: string;
  key: string;
  filePlaceholder: Slant3DFilePlaceholder;
};

export type Slant3DConfirmUploadData = {
  publicFileServiceId: string;
  name: string;
  fileURL: string;
  STLMetrics?: Slant3DSTLMetrics;
};

export type Slant3DEstimateData = {
  publicFileServiceId: string;
  estimatedCost?: number;
  total?: number;
  pricePerUnit?: number;
  subtotal?: number;
  quantity: number;
  filamentId: string;
  slicer?: Record<string, unknown>;
};

export class Slant3DFileApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'Slant3DFileApiError';
    this.status = status;
    this.details = details;
  }
}

async function parseResponseDetails(response: Response): Promise<unknown> {
  if (typeof response.text === 'function') {
    try {
      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      // Fall through to json() for lightweight test doubles that only mock json().
    }
  }

  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  return {};
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function slant3DFileRequest<T>(
  env: Bindings,
  path: string,
  body: unknown,
  errorMessage: string,
): Promise<T> {
  if (!env.SLANT_API_V2) {
    throw new Slant3DFileApiError(
      'Missing SLANT_API_V2 environment variable.',
      500,
    );
  }

  const url = slantV2Url(env, path);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SLANT_API_V2}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    throw new Slant3DFileApiError(errorMessage, 502, {
      url,
      cause: formatErrorMessage(error),
    });
  }

  if (!response.ok) {
    throw new Slant3DFileApiError(
      errorMessage,
      response.status,
      await parseResponseDetails(response),
    );
  }

  const data = (await response.json()) as { data: T };
  return data.data;
}

export async function createSlant3DDirectUpload(
  env: Bindings,
  {
    name,
    ownerId,
  }: {
    name: string;
    ownerId: string;
  },
): Promise<Slant3DDirectUploadData> {
  if (!env.SLANT_PLATFORM_ID) {
    throw new Slant3DFileApiError(
      'Missing SLANT_PLATFORM_ID environment variable.',
      500,
    );
  }

  return slant3DFileRequest<Slant3DDirectUploadData>(
    env,
    'files/direct-upload',
    {
      name,
      platformId: env.SLANT_PLATFORM_ID,
      ownerId,
    },
    'Failed to generate presigned URL from Slant3D V2 API',
  );
}

export async function confirmSlant3DUpload(
  env: Bindings,
  filePlaceholder: Slant3DFilePlaceholder,
): Promise<Slant3DConfirmUploadData> {
  return slant3DFileRequest<Slant3DConfirmUploadData>(
    env,
    'files/confirm-upload',
    { filePlaceholder },
    'Failed to confirm upload with Slant3D V2 API',
  );
}

export async function estimateSlant3DFile(
  env: Bindings,
  publicFileServiceId: string,
  options: {
    filamentId: string;
    quantity: number;
    slicer?: Record<string, unknown>;
  },
): Promise<Slant3DEstimateData> {
  return slant3DFileRequest<Slant3DEstimateData>(
    env,
    `files/${publicFileServiceId}/estimate`,
    {
      options: {
        filamentId: options.filamentId,
        quantity: options.quantity,
        ...(options.slicer && { slicer: options.slicer }),
      },
    },
    'Failed to estimate file price from Slant3D V2 API',
  );
}
