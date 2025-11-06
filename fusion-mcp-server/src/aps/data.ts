/**
 * Data management module for Autodesk Platform Services (APS)
 */

import { getAuthToken } from './auth';

interface Env {
  APS_CLIENT_ID: string;
  APS_CLIENT_SECRET: string;
  APS_PROJECT_ID: string;
  APS_SCOPE?: string;
}

interface Model {
  id: string;
  name: string;
  type: string;
  createTime: string;
  modifiedTime: string;
}

interface ModelDetails {
  id: string;
  name: string;
  type: string;
  createTime: string;
  modifiedTime: string;
  properties: Record<string, any>;
}

const APS_BASE_URL = 'https://developer.api.autodesk.com';

/**
 * List all models in the project
 */
export async function listModels(env: Env): Promise<Model[]> {
  const token = await getAuthToken(env);
  const projectId = env.APS_PROJECT_ID;

  const url = `${APS_BASE_URL}/data/v1/projects/${projectId}/items`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list models: ${error}`);
  }

  const data = await response.json();
  return data.data || [];
}

/**
 * Get detailed information about a specific model
 */
export async function getModelDetails(env: Env, modelId: string): Promise<ModelDetails> {
  const token = await getAuthToken(env);
  const projectId = env.APS_PROJECT_ID;

  const url = `${APS_BASE_URL}/data/v1/projects/${projectId}/items/${modelId}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get model details: ${error}`);
  }

  const data = await response.json();
  return data.data;
}

/**
 * Search for models by name or properties
 */
export async function searchModels(env: Env, query: string): Promise<Model[]> {
  const token = await getAuthToken(env);
  const projectId = env.APS_PROJECT_ID;

  const url = `${APS_BASE_URL}/data/v1/projects/${projectId}/items?filter[name]=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to search models: ${error}`);
  }

  const data = await response.json();
  return data.data || [];
}
