/**
 * Work items module for Autodesk Platform Services (APS)
 * Handles Design Automation work items for processing models
 */

import { getAuthToken } from './auth';

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
export async function createWorkItem(env: any, request: WorkItemRequest): Promise<WorkItem> {
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
export async function getWorkItemStatus(env: any, workItemId: string): Promise<WorkItem> {
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
export async function cancelWorkItem(env: any, workItemId: string): Promise<void> {
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
 * Wait for work item completion
 */
export async function waitForWorkItem(
  env: any, 
  workItemId: string, 
  timeoutMs: number = 300000
): Promise<WorkItem> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await getWorkItemStatus(env, workItemId);
    
    if (status.status === 'success' || status.status === 'failed' || status.status === 'cancelled') {
      return status;
    }
    
    // Wait 5 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  throw new Error('Work item timeout');
}
