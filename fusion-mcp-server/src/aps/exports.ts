/**
 * Export module for Autodesk Platform Services (APS)
 * Handles exporting models to various formats (STL, OBJ, STEP, etc.)
 */

import { getAuthToken } from './auth';

interface ExportJob {
  jobId: string;
  status: 'pending' | 'inprogress' | 'success' | 'failed';
  downloadUrl?: string;
}

const APS_BASE_URL = 'https://developer.api.autodesk.com';

/**
 * Export a model to the specified format
 */
export async function exportModel(env: any, modelId: string, format: string): Promise<ExportJob> {
  const token = await getAuthToken(env);
  
  const url = `${APS_BASE_URL}/modelderivative/v2/designdata/${encodeURIComponent(modelId)}/manifest`;

  const body = {
    input: {
      urn: modelId,
    },
    output: {
      formats: [
        {
          type: format.toLowerCase(),
        },
      ],
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to export model: ${error}`);
  }

  const data = await response.json();
  
  return {
    jobId: data.urn || modelId,
    status: 'pending',
  };
}

/**
 * Get the status of an export job
 */
export async function getExportStatus(env: any, jobId: string): Promise<ExportJob> {
  const token = await getAuthToken(env);
  
  const url = `${APS_BASE_URL}/modelderivative/v2/designdata/${encodeURIComponent(jobId)}/manifest`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get export status: ${error}`);
  }

  const data = await response.json();
  
  const status = data.status === 'success' ? 'success' : 
                 data.status === 'failed' ? 'failed' : 
                 data.status === 'inprogress' ? 'inprogress' : 'pending';

  return {
    jobId,
    status,
    downloadUrl: status === 'success' ? data.derivatives?.[0]?.outputUrn : undefined,
  };
}

/**
 * Download the exported file
 */
export async function downloadExport(env: any, downloadUrl: string): Promise<ArrayBuffer> {
  const token = await getAuthToken(env);
  
  const response = await fetch(downloadUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to download export: ${error}`);
  }

  return response.arrayBuffer();
}
