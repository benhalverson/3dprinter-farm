/**
 * Work items module for Autodesk Platform Services (APS)
 * Handles Design Automation work items for processing models
 */

import { getAuthToken } from './auth';

interface Env {
  APS_CLIENT_ID: string;
  APS_CLIENT_SECRET: string;
  APS_PROJECT_ID: string;
  APS_SCOPE?: string;
}

interface WorkItem {
  id: string;
  status: 'pending' | 'inprogress' | 'success' | 'failed' | 'cancelled';
  progress?: number;
  reportUrl?: string;
  result?: string;
}

interface WorkItemRequest {
  activityId: string;
  arguments: Record<string, any>;
}

const APS_BASE_URL = 'https://developer.api.autodesk.com';

/**
 * Create a new work item for Design Automation
 */
export async function createWorkItem(env: Env, request: WorkItemRequest): Promise<WorkItem> {
  const token = await getAuthToken(env);
  
  const url = `${APS_BASE_URL}/da/us-east/v3/workitems`;

  const body = {
    activityId: request.activityId,
    arguments: request.arguments,
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
    throw new Error(`Failed to create work item: ${error}`);
  }

  const data = await response.json();
  
  return {
    id: data.id,
    status: data.status || 'pending',
    progress: 0,
    reportUrl: data.reportUrl,
  };
}

/**
 * Get the status of a work item
 */
export async function getWorkItemStatus(env: Env, workItemId: string): Promise<WorkItem> {
  const token = await getAuthToken(env);
  
  const url = `${APS_BASE_URL}/da/us-east/v3/workitems/${encodeURIComponent(workItemId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get work item status: ${error}`);
  }

  const data = await response.json();
  
  return {
    id: data.id,
    status: data.status,
    progress: data.progress,
    reportUrl: data.reportUrl,
    result: data.result,
  };
}

/**
 * Cancel a work item
 */
export async function cancelWorkItem(env: Env, workItemId: string): Promise<void> {
  const token = await getAuthToken(env);
  
  const url = `${APS_BASE_URL}/da/us-east/v3/workitems/${encodeURIComponent(workItemId)}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to cancel work item: ${error}`);
  }
}

/**
 * Wait for work item completion (polling-based)
 * Note: In Cloudflare Workers, consider using Durable Objects or external scheduling
 * for production use cases requiring long-running operations.
 */
export async function waitForWorkItem(
  env: Env, 
  workItemId: string, 
  timeoutMs: number = 60000, // Reduced timeout for Workers environment
  pollIntervalMs: number = 2000
): Promise<WorkItem> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await getWorkItemStatus(env, workItemId);
    
    if (status.status === 'success' || status.status === 'failed' || status.status === 'cancelled') {
      return status;
    }
    
    // Use Promise-based delay compatible with Workers
    await new Promise(resolve => {
      const timer = setTimeout(resolve, pollIntervalMs);
      // Note: In Workers, this will work but for long-running tasks, 
      // consider using Durable Objects or external job queue
    });
  }
  
  throw new Error('Work item timeout');
}
