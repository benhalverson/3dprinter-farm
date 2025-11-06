/**
 * Webhook handlers for Autodesk Platform Services (APS)
 * Handles incoming webhook events from APS
 */

import { Hono } from 'hono';
import { verifyWebhookSignature } from './verify';

interface Env {
  APS_WEBHOOK_SECRET?: string;
  APS_TRUSTED_TENANTS?: string;
}

export const webhookRoutes = new Hono<{ Bindings: Env }>();

interface WebhookEvent {
  hook: {
    hookId: string;
    tenant: string;
    callbackUrl: string;
    createdBy: string;
    event: string;
    createdDate: string;
    lastUpdatedDate: string;
    system: string;
    creatorType: string;
    status: string;
    scope: Record<string, string>;
  };
  payload: {
    projectGuid?: string;
    resourceUrn?: string;
    userId?: string;
    eventType?: string;
    timestamp?: string;
    version?: string;
  };
}

/**
 * Handle webhook events from APS
 */
webhookRoutes.post('/', async (c) => {
  try {
    // Verify webhook signature
    const signature = c.req.header('X-APS-Signature');
    const body = await c.req.text();
    
    if (!signature) {
      return c.json({ error: 'Missing signature' }, 401);
    }

    const isValid = await verifyWebhookSignature(c.env, body, signature);
    if (!isValid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Parse webhook event
    const event: WebhookEvent = JSON.parse(body);
    
    // Handle different event types
    await handleWebhookEvent(c.env, event);
    
    return c.json({ status: 'received' });
  } catch (error) {
    console.error('Webhook error:', error);
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

/**
 * Handle model.version.created event
 */
async function handleModelVersionCreated(env: Env, event: WebhookEvent): Promise<void> {
  console.log('Model version created:', event.payload);
  // Add custom logic here (e.g., trigger automation, send notifications)
}

/**
 * Handle model.version.modified event
 */
async function handleModelVersionModified(env: Env, event: WebhookEvent): Promise<void> {
  console.log('Model version modified:', event.payload);
  // Add custom logic here
}

/**
 * Handle workitem.completed event
 */
async function handleWorkItemCompleted(env: Env, event: WebhookEvent): Promise<void> {
  console.log('Work item completed:', event.payload);
  // Add custom logic here
}

/**
 * Handle workitem.failed event
 */
async function handleWorkItemFailed(env: Env, event: WebhookEvent): Promise<void> {
  console.log('Work item failed:', event.payload);
  // Add custom logic here
}

/**
 * Route webhook events to appropriate handlers
 */
async function handleWebhookEvent(env: Env, event: WebhookEvent): Promise<void> {
  const eventType = event.hook.event;
  
  switch (eventType) {
    case 'model.version.created':
      await handleModelVersionCreated(env, event);
      break;
    case 'model.version.modified':
      await handleModelVersionModified(env, event);
      break;
    case 'workitem.completed':
      await handleWorkItemCompleted(env, event);
      break;
    case 'workitem.failed':
      await handleWorkItemFailed(env, event);
      break;
    default:
      console.log('Unknown event type:', eventType);
  }
}

/**
 * Register a webhook with APS
 */
webhookRoutes.post('/register', async (c) => {
  try {
    const body = await c.req.json();
    const { event, callbackUrl } = body;
    
    // Implementation to register webhook with APS
    // This would call the APS Webhooks API
    
    return c.json({ 
      status: 'registered',
      event,
      callbackUrl,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

/**
 * List registered webhooks
 */
webhookRoutes.get('/list', async (c) => {
  try {
    // Implementation to list webhooks from APS
    // This would call the APS Webhooks API
    
    return c.json({ webhooks: [] });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

/**
 * Delete a webhook
 */
webhookRoutes.delete('/:hookId', async (c) => {
  try {
    const hookId = c.req.param('hookId');
    
    // Implementation to delete webhook from APS
    // This would call the APS Webhooks API
    
    return c.json({ 
      status: 'deleted',
      hookId,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});
