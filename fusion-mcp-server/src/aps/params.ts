/**
 * Design parameters module for Autodesk Platform Services (APS)
 * Handles reading and updating parametric design parameters
 */

import { getAuthToken } from './auth';

interface DesignParameter {
  name: string;
  value: string | number;
  unit?: string;
  expression?: string;
}

const APS_BASE_URL = 'https://developer.api.autodesk.com';

/**
 * Get all design parameters for a model
 */
export async function getDesignParams(env: any, modelId: string): Promise<DesignParameter[]> {
  const token = await getAuthToken(env);
  
  const url = `${APS_BASE_URL}/designautomation/v3/models/${encodeURIComponent(modelId)}/parameters`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get design parameters: ${error}`);
  }

  const data = await response.json();
  return data.parameters || [];
}

/**
 * Update design parameters for a model
 */
export async function updateDesignParams(
  env: any, 
  modelId: string, 
  params: DesignParameter[]
): Promise<{ success: boolean; message: string }> {
  const token = await getAuthToken(env);
  
  const url = `${APS_BASE_URL}/designautomation/v3/models/${encodeURIComponent(modelId)}/parameters`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parameters: params }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update design parameters: ${error}`);
  }

  return {
    success: true,
    message: 'Design parameters updated successfully',
  };
}

/**
 * Get a specific design parameter by name
 */
export async function getDesignParam(
  env: any, 
  modelId: string, 
  paramName: string
): Promise<DesignParameter | null> {
  const params = await getDesignParams(env, modelId);
  return params.find(p => p.name === paramName) || null;
}

/**
 * Update a specific design parameter
 */
export async function updateDesignParam(
  env: any,
  modelId: string,
  paramName: string,
  value: string | number
): Promise<{ success: boolean; message: string }> {
  const currentParams = await getDesignParams(env, modelId);
  const paramIndex = currentParams.findIndex(p => p.name === paramName);
  
  if (paramIndex === -1) {
    throw new Error(`Parameter "${paramName}" not found`);
  }

  currentParams[paramIndex].value = value;
  return updateDesignParams(env, modelId, currentParams);
}
