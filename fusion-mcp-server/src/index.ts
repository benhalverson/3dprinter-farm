import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { mcpRoutes } from './mcp';
import { webhookRoutes } from './webhooks/handlers';

interface Env {
  ALLOWED_ORIGINS?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', async (c, next) => {
  const allowedOrigins = c.env.ALLOWED_ORIGINS 
    ? c.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:8787'];
  
  return cors({
    origin: allowedOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })(c, next);
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Routes
app.route('/mcp', mcpRoutes);
app.route('/webhooks', webhookRoutes);

export default app;
