# V2 Colors Endpoint Documentation

## Overview

The `/v2/colors` endpoint provides access to Slant3D's V2 API for retrieving filament information with enhanced metadata, availability status, and filtering capabilities.

## Endpoint

```text
GET /v2/colors
```

## Authentication

Requires authentication via cookie-based session token.

**Headers:**

```text
Cookie: token=<your-session-token>
```

## Query Parameters

| Parameter | Type | Required | Description | Valid Values |
|-----------|------|----------|-------------|--------------|
| `profile` | string | No | Filter by material type | `PLA`, `PETG`, `ABS` |
| `available` | string | No | Filter by availability status | `true`, `false` |
| `provider` | string | No | Filter by manufacturer name | Any string (case-insensitive) |

## Response Format

### Success Response (200)

```json
{
  "success": true,
  "message": "Filaments retrieved successfully",
  "data": [
    {
      "publicId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "name": "PLA MATTE BLACK",
      "provider": "eSun",
      "profile": "PLA",
      "color": "matte black",
      "hexValue": "#000000",
      "public": true,
      "available": true
    }
  ],
  "count": 1,
  "lastUpdated": "2025-12-06T10:30:00Z"
}
```

### Error Response (400)

```json
{
  "success": false,
  "message": "Invalid profile parameter",
  "error": "Accepted values are \"PLA\", \"PETG\", or \"ABS\""
}
```

### Error Response (500)

```json
{
  "success": false,
  "message": "Failed to retrieve filaments from Slant3D V2 API",
  "error": "API error details"
}
```

## Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Indicates if the request was successful |
| `message` | string | Human-readable response message |
| `data` | array | Array of filament objects |
| `count` | number | Number of filaments returned |
| `lastUpdated` | string | ISO 8601 timestamp of last data update |

### Filament Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `publicId` | string | UUID used for placing orders with Slant3D V2 API |
| `name` | string | Display name (e.g., "PLA MATTE BLACK") |
| `provider` | string | Filament manufacturer/brand |
| `profile` | string | Material type (`PLA`, `PETG`, or `ABS`) |
| `color` | string | Color description (e.g., "matte black") |
| `hexValue` | string | Hex color code (e.g., "#000000") |
| `public` | boolean | Whether filament is publicly available |
| `available` | boolean | Current in-stock status |

## Usage Examples

### Get All Filaments

```bash
curl -X GET "https://your-api.com/v2/colors" \
  -H "Cookie: token=your-session-token"
```

### Filter by Material Type

```bash
curl -X GET "https://your-api.com/v2/colors?profile=PLA" \
  -H "Cookie: token=your-session-token"
```

### Filter by Availability

```bash
curl -X GET "https://your-api.com/v2/colors?available=true" \
  -H "Cookie: token=your-session-token"
```

### Filter by Provider

```bash
curl -X GET "https://your-api.com/v2/colors?provider=eSun" \
  -H "Cookie: token=your-session-token"
```

### Combine Multiple Filters

```bash
curl -X GET "https://your-api.com/v2/colors?profile=PLA&available=true&provider=eSun" \
  -H "Cookie: token=your-session-token"
```

### JavaScript/TypeScript Example

```typescript
const response = await fetch('/v2/colors?profile=PLA&available=true', {
  method: 'GET',
  credentials: 'include', // Include cookies
  headers: {
    'Content-Type': 'application/json',
  },
});

const data = await response.json();

if (data.success) {
  console.log(`Found ${data.count} filaments`);
  data.data.forEach(filament => {
    console.log(`${filament.name} - ${filament.hexValue}`);
    console.log(`Available: ${filament.available}`);
    console.log(`Use publicId ${filament.publicId} for orders`);
  });
}
```

## Caching

The endpoint implements intelligent caching:

- **Cache Duration:** 7 days (604,800 seconds)
- **Cache Key Format:** `v2:colors:{profile}:{available}:{provider}`
- **Cache Storage:** Cloudflare KV (COLOR_CACHE namespace)
- Cached responses are returned immediately without calling Slant3D API
- Each unique combination of filters has its own cache entry

## Status Codes

| Code | Description |
|------|-------------|
| 200 | Success - Filaments retrieved |
| 400 | Bad Request - Invalid query parameters |
| 401 | Unauthorized - Missing or invalid authentication |
| 500 | Internal Server Error - Failed to retrieve filaments |

## Data Freshness

- Slant3D updates their filament cache every 30 minutes
- This endpoint caches responses for 7 days
- Filament availability can change during the cache period
- Consider implementing cache invalidation for critical availability checks

## Differences from V1 `/colors` Endpoint

| Feature | V1 `/colors` | V2 `/v2/colors` |
|---------|-------------|-----------------|
| API Source | Slant3D V1 API | Slant3D V2 API |
| Filament ID | ❌ Not included | ✅ `publicId` (UUID) |
| Availability | ❌ Not included | ✅ `available` field |
| Provider Info | ❌ Not included | ✅ `provider` field |
| Public Status | ❌ Not included | ✅ `public` field |
| Filtering | Profile only | Profile, availability, provider |
| Response Format | Simple array | Structured with metadata |
| Material Types | PLA, PETG | PLA, PETG, ABS |

## Using Filaments in Orders

To place an order using a filament from this endpoint:

1. Call `/v2/colors` to get available filaments
2. Extract the `publicId` from your chosen filament
3. Use the `publicId` as the `filamentId` in your order request

Example:

```typescript
// Step 1: Get filaments
const filamentsResponse = await fetch('/v2/colors?available=true');
const filaments = await filamentsResponse.json();

// Step 2: Select a filament
const blackPLA = filaments.data.find(f =>
  f.color === 'matte black' && f.profile === 'PLA'
);

// Step 3: Use publicId in order
const order = {
  items: [{
    type: 'PRINT',
    publicFileServiceId: 'your-file-id',
    filamentId: blackPLA.publicId, // Use the publicId here
    quantity: 1
  }]
};
```

## Best Practices

1. **Check Availability:** Always filter by `available=true` when displaying options to customers
2. **Cache Locally:** Consider caching results in your frontend to reduce API calls
3. **Error Handling:** Always check the `success` field before accessing `data`
4. **Use PublicId:** Store the `publicId` (not the name) for order placement
5. **Provider Filter:** Use case-insensitive provider searches (e.g., "esun", "eSun", "ESUN" all work)

## Migration Guide

If migrating from V1 `/colors` to V2 `/v2/colors`:

1. **Update Response Parsing:**

   ```typescript
   // V1
   const colors = response.filaments;

   // V2
   const colors = response.data;
   ```

2. **Update Field Names:**

   ```typescript
   // V1
   filament.filament  // "PLA"
   filament.hexColor  // "#000000"
   filament.colorTag  // "black"

   // V2
   filament.publicId  // "uuid-string"
   filament.profile   // "PLA"
   filament.hexValue  // "#000000"
   filament.color     // "matte black"
   filament.name      // "PLA MATTE BLACK"
   ```

3. **Add Availability Check:**

   ```typescript
   // V2 only
   if (filament.available) {
     // Allow selection
   }
   ```

4. **Update Order Placement:**

   ```typescript
   // V1 - used color/profile lookup
   // V2 - use publicId directly
   filamentId: filament.publicId
   ```

## Rate Limiting

This endpoint is protected by the same rate limiting as other authenticated endpoints. Excessive requests may result in temporary throttling.

## Support

For issues or questions about the V2 colors endpoint:

- Check Slant3D API documentation: <https://slant3dapi.com/documentation/filaments>
- Review OpenAPI spec: <https://slant3dapi.com/v2/api/openapi.json>
- Contact support with specific error messages from the `error` field
