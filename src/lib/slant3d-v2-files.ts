import { BASE_URL_V2 } from '../constants';
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
  const responseText = await response.text();

  if (!responseText) {
    return {};
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

async function slant3DFileRequest<T>(
  env: Bindings,
  path: string,
  body: unknown,
  errorMessage: string,
): Promise<T> {
  if (!env.SLANT_API_V2) {
    throw new Slant3DFileApiError('Missing SLANT_API_V2 environment variable.', 500);
  }

  const response = await fetch(`${BASE_URL_V2}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.SLANT_API_V2,
    },
    body: JSON.stringify(body),
  });

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
