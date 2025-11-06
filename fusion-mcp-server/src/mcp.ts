import { Hono } from 'hono';
import { getAuthToken } from './aps/auth';
import { listModels, getModelDetails } from './aps/data';
import { exportModel } from './aps/exports';
import { getDesignParams, updateDesignParams } from './aps/params';
import { createWorkItem, getWorkItemStatus } from './aps/workitems';

interface Env {
  APS_CLIENT_ID: string;
  APS_CLIENT_SECRET: string;
  APS_PROJECT_ID: string;
  APS_SCOPE?: string;
}

export const mcpRoutes = new Hono<{ Bindings: Env }>();

// MCP Tool: Get authentication token
mcpRoutes.post('/auth/token', async (c) => {
  try {
    const token = await getAuthToken(c.env);
    return c.json({ token });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// MCP Tool: List models
mcpRoutes.get('/models', async (c) => {
  try {
    const models = await listModels(c.env);
    return c.json({ models });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// MCP Tool: Get model details
mcpRoutes.get('/models/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const details = await getModelDetails(c.env, id);
    return c.json({ details });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// MCP Tool: Export model
mcpRoutes.post('/models/:id/export', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const result = await exportModel(c.env, id, body.format);
    return c.json({ result });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// MCP Tool: Get design parameters
mcpRoutes.get('/models/:id/params', async (c) => {
  try {
    const id = c.req.param('id');
    const params = await getDesignParams(c.env, id);
    return c.json({ params });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// MCP Tool: Update design parameters
mcpRoutes.put('/models/:id/params', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const result = await updateDesignParams(c.env, id, body.params);
    return c.json({ result });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// MCP Tool: Create work item
mcpRoutes.post('/workitems', async (c) => {
  try {
    const body = await c.req.json();
    const workItem = await createWorkItem(c.env, body);
    return c.json({ workItem });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// MCP Tool: Get work item status
mcpRoutes.get('/workitems/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const status = await getWorkItemStatus(c.env, id);
    return c.json({ status });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});
