# Fusion MCP Server

A Model Context Protocol (MCP) server for Autodesk Fusion 360 integration, built with Hono and deployed on Cloudflare Workers.

## Overview

This server provides a bridge between MCP-compatible applications and Autodesk Platform Services (APS) for Fusion 360. It enables programmatic access to Fusion 360 models, design parameters, exports, and Design Automation workflows.

## Features

- **Model Management**: List, search, and retrieve Fusion 360 models
- **Design Parameters**: Read and update parametric design parameters
- **Model Export**: Export models to various formats (STL, OBJ, STEP, IGES, FBX)
- **Design Automation**: Create and monitor Design Automation work items
- **Webhooks**: Receive real-time notifications from APS

## Project Structure

```
fusion-mcp-server/
│
├─ src/
│  ├─ index.ts          # Hono app entry point
│  ├─ mcp.ts            # MCP tool definitions and routes
│  ├─ aps/              # Autodesk Platform Services integration
│  │   ├─ auth.ts       # OAuth2 authentication
│  │   ├─ data.ts       # Data management (models, projects)
│  │   ├─ exports.ts    # Model export functionality
│  │   ├─ params.ts     # Design parameter management
│  │   └─ workitems.ts  # Design Automation work items
│  └─ webhooks/         # Webhook handlers
│      ├─ handlers.ts   # Webhook event processing
│      └─ verify.ts     # Webhook signature verification
│
├─ mcp.json             # MCP manifest
├─ wrangler.toml        # Cloudflare deployment config
├─ package.json         # Dependencies and scripts
└─ README.md            # This file
```

## Prerequisites

- Node.js 18+ and npm/pnpm
- Wrangler CLI (`npm install -g wrangler`)
- Autodesk Platform Services (APS) account
- APS application credentials (Client ID and Secret)

## Setup

### 1. Install Dependencies

```bash
npm install
# or
pnpm install
```

### 2. Configure APS Credentials

Create a `.dev.vars` file in the project root:

```env
APS_CLIENT_ID=your_client_id
APS_CLIENT_SECRET=your_client_secret
APS_PROJECT_ID=your_project_id
APS_WEBHOOK_SECRET=your_webhook_secret
APS_SCOPE=data:read data:write
```

### 3. Set Production Secrets

For production deployment, set secrets using Wrangler:

```bash
wrangler secret put APS_CLIENT_ID
wrangler secret put APS_CLIENT_SECRET
wrangler secret put APS_PROJECT_ID
wrangler secret put APS_WEBHOOK_SECRET
```

## Development

Start the development server:

```bash
npm run dev
# or
pnpm run dev
```

The server will be available at `http://localhost:8787`

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
# or
pnpm run deploy
```

## API Endpoints

### Health Check

```
GET /health
```

Returns server health status.

### MCP Tools

#### Authentication

```
POST /mcp/auth/token
```

Get an OAuth2 token from APS.

#### List Models

```
GET /mcp/models
```

List all models in the configured project.

#### Get Model Details

```
GET /mcp/models/:id
```

Get detailed information about a specific model.

#### Export Model

```
POST /mcp/models/:id/export
```

Request:
```json
{
  "format": "stl"
}
```

Supported formats: `stl`, `obj`, `step`, `iges`, `fbx`

#### Get Design Parameters

```
GET /mcp/models/:id/params
```

Retrieve all design parameters for a model.

#### Update Design Parameters

```
PUT /mcp/models/:id/params
```

Request:
```json
{
  "params": [
    {
      "name": "length",
      "value": 100
    },
    {
      "name": "width",
      "value": 50
    }
  ]
}
```

#### Create Work Item

```
POST /mcp/workitems
```

Request:
```json
{
  "activityId": "your.activity.id+label",
  "arguments": {
    "inputModel": {
      "url": "https://example.com/model.f3d"
    },
    "outputSTL": {
      "url": "https://example.com/output.stl",
      "verb": "put"
    }
  }
}
```

#### Get Work Item Status

```
GET /mcp/workitems/:id
```

Check the status of a Design Automation work item.

### Webhooks

#### Receive Webhook Events

```
POST /webhooks
```

Endpoint for receiving webhook events from APS. Requires valid signature in `X-APS-Signature` header.

#### Register Webhook

```
POST /webhooks/register
```

Register a new webhook with APS.

#### List Webhooks

```
GET /webhooks/list
```

List all registered webhooks.

#### Delete Webhook

```
DELETE /webhooks/:hookId
```

Delete a specific webhook.

## MCP Integration

This server implements the Model Context Protocol, allowing it to be used with MCP-compatible applications.

### Available MCP Tools

- `list_models`: List all Fusion 360 models
- `get_model_details`: Get detailed model information
- `export_model`: Export a model to specified format
- `get_design_params`: Retrieve design parameters
- `update_design_params`: Update design parameters
- `create_work_item`: Create Design Automation work item
- `get_work_item_status`: Check work item status

### Example MCP Configuration

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "fusion": {
      "url": "https://your-worker.workers.dev",
      "apiKey": "your-api-key"
    }
  }
}
```

## Webhook Events

The server handles the following APS webhook events:

- `model.version.created`: Triggered when a new model version is created
- `model.version.modified`: Triggered when a model version is modified
- `workitem.completed`: Triggered when a Design Automation work item completes
- `workitem.failed`: Triggered when a Design Automation work item fails

## Security

- Webhook signatures are verified using HMAC-SHA256
- All APS API requests use OAuth2 authentication
- Secrets are stored securely in Cloudflare Workers environment
- CORS is configured for allowed origins only

## Error Handling

All endpoints return JSON responses with appropriate HTTP status codes:

- `200`: Success
- `401`: Unauthorized (invalid signature or credentials)
- `404`: Resource not found
- `500`: Internal server error

Error response format:

```json
{
  "error": "Error message description"
}
```

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT

## Resources

- [Autodesk Platform Services Documentation](https://aps.autodesk.com/)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Hono Framework](https://hono.dev/)
- [Cloudflare Workers](https://workers.cloudflare.com/)

## Support

For issues and questions:

- Open an issue on GitHub
- Check APS documentation
- Review Cloudflare Workers documentation
