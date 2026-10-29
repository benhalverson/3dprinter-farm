import type { generateSpecs } from 'hono-openapi';
import { z } from 'zod';
import { createSchema } from 'zod-openapi';
import { ProfileDataSchema, signInSchema, signUpSchema } from '../db/schema';
import { productDraftResponseSchema } from '../modules/productDraftContracts';
import { prepareProductDraftSchema } from '../modules/productInterpretation';
import { saleInputSchema } from '../modules/inPersonSales';
import { refundInput } from '../modules/squareRefunds';

/** Documentation only: route validation and authorization remain in their handlers. */
type Document = Awaited<ReturnType<typeof generateSpecs>>;
type Path = NonNullable<NonNullable<Document['paths']>[string]>;
type Operation = NonNullable<Path['get']>;
type Body = Exclude<NonNullable<Operation['requestBody']>, { $ref: string }>;
type Schema = NonNullable<Body['content'][string]['schema']>;
const schema = (value: z.ZodType): Schema =>
  createSchema(value).schema as Schema;
const jsonBody = (
  value: z.ZodType,
  example?: unknown,
  required = true,
): Operation['requestBody'] => ({
  required,
  content: {
    'application/json': {
      schema: schema(value),
      ...(example === undefined ? {} : { example }),
    },
  },
});
const jsonResponse = (
  description: string,
  value: z.ZodType,
  example?: unknown,
) => ({
  description,
  content: {
    'application/json': {
      schema: schema(value),
      ...(example === undefined ? {} : { example }),
    },
  },
});
const error = (description: string) =>
  jsonResponse(description, z.object({ error: z.string() }));
const uuid = '11111111-1111-4111-8111-111111111111';
const cookie: NonNullable<Operation['security']> = [{ cookieAuth: [] }];
const guest: NonNullable<Operation['security']> = [
  { cookieAuth: [] },
  { cartToken: [] },
];
const account = 'Requires a valid Better Auth session cookie.';
const admin =
  'Requires a valid session and admin or owner membership in the shared organization. A user profile role alone does not grant access.';
const guestAccess =
  'Use the owning account session or X-Cart-Token for an unclaimed guest cart. Missing or inaccessible carts return 404. A cart ID alone grants no access.';
const source = 'https://github.com/benhalverson/3dprinter-farm/blob/main/docs/';

export const referenceDocumentation = {
  info: {
    title: 'Lulu Speedworks API',
    version: '1.0.0',
    description: `Manage the 3D-print storefront catalog, customer profiles, carts, shipping quotes, Square checkout, and fulfillment. Administrative operations also support private product drafts, catalog publication, and order recovery.

Use https://api.luluspeedworks.com as the production base URL. Requests and responses use JSON unless an operation specifies multipart uploads, raw image bytes, redirects, or server-sent events. The machine-readable reference is available at /open-api.

### First request
\`\`\`sh
curl 'https://api.luluspeedworks.com/products?page=1&limit=10'
\`\`\`
Catalog browsing is public. Sign in before accessing profiles, checkout quotes, payments, or customer orders. See Auth for cookie sessions and Shopping Cart for guest capabilities.

### Checkout sequence
Create a cart, add catalog items, sign in and claim any guest cart, save a complete shipping profile, then create and review a quote. Submit the quote ID and a stable requestKey to checkout. Retain that key across timeouts. A redirect from Square does not prove payment: inspect the checkout attempt and customer order state.

### Values and failures
Catalog prices are USD amounts; quote and payment fields ending in Cents are integer USD cents. Keep durable publicFileServiceId values (Slant File IDs); resolved print-file URLs are temporary. UUID examples are illustrative and must be replaced with identifiers returned by your requests.

Check HTTP status before reading success fields. Most application errors contain an error string; validators can return structured validation details, Better Auth can return code/message, and some failures are plain text. 401 means a missing or invalid session, 403 means an origin or permission denial, and ownership checks may return 404. For revision or idempotency conflicts (409), read current state before retrying. For ambiguous provider failures, recover the existing operation using its original key. Do not create a new payment or manufacturing operation merely because a request timed out.

Browser clients must use an allowed origin and credentials: 'include'. An untrusted Origin returns 403 even on public endpoints. Private responses use no-store. The interactive client can make real mutations; examples are not a sandbox.`,
  },
  servers: [
    { url: 'https://api.luluspeedworks.com', description: 'Production' },
    { url: 'http://localhost:8787', description: 'Local development' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey' as const,
        in: 'cookie' as const,
        name: '__Secure-better-auth.session_token',
        description:
          'Better Auth HttpOnly session set by signup/signin. HTTPS uses the __Secure- prefix; local HTTP uses better-auth.session_token. Browser code sends credentials: include rather than reading or setting the cookie.',
      },
      cartToken: {
        type: 'apiKey' as const,
        in: 'header' as const,
        name: 'X-Cart-Token',
        description:
          'Guest capability returned once by POST /cart/create; revoked when claimed. Only authorizes its unclaimed cart.',
      },
      agentCapability: {
        type: 'http' as const,
        scheme: 'bearer',
        description:
          'Visit capability from POST /agent/sessions; used only on that session’s runs and cancellation. This is not a customer login token.',
      },
    },
  },
  tags: [
    {
      name: 'Auth',
      description: `Email/password sessions are owned by Better Auth. POST /auth/signup accepts email, password (8–128 characters), and optional name. POST /auth/signin accepts email/password and sets an HttpOnly cookie. Neither endpoint requires a prior session. POST /auth/signout revokes the current session and clears its cookie. There is no application JWT login flow.

\`\`\`js
await fetch('https://api.luluspeedworks.com/auth/signin', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'customer@example.com', password: 'example-password' })
});
const profile = await fetch('https://api.luluspeedworks.com/profile', { credentials: 'include' });
\`\`\`
For command-line clients, save Set-Cookie with curl -c cookies.txt and send it with -b cookies.txt. Cookies are host-only: sign in again when changing API hosts. Signup is limited to 3 attempts and signin to 5 attempts per IP with a 60-second KV TTL; accepted requests refresh the TTL. A limit returns 429.

The native Better Auth API (including session lookup, passkeys and organization endpoints) is mounted at /api/auth. Its [generated reference](/api/auth/reference) and [schema](/api/auth/open-api/generate-schema) describe those provider routes. Organization operations additionally require shared-organization admin/owner membership. Passkeys depend on the configured RP ID and origin; moving API hosts does not migrate credentials.

Password reset uses /api/auth/request-password-reset and /api/auth/reset-password. Tokens expire after one hour; a successful reset consumes the token and revokes all sessions. Unknown email addresses receive the same success message as registered addresses. [Reset flow](${source}password-reset.md).`,
    },
    {
      name: 'Products',
      description: `Browse Catalog Items without signing in. GET /products returns an array when pagination is omitted, or { products, pagination } when page or limit is supplied. GET /products/search uses q and always returns a paginated result. Prices are USD. Images use image and imageGallery; ordered categories use categoryId/categoryName pairs. Print previews redirect through /product/{id}/print-file.

Example: GET /products?page=1&limit=10, then GET /product/1. Catalog creation, updates and deletion require shared-organization admin/owner membership. Creation uses a confirmed Slant File ID; estimates and print previews do not place orders. Use the private draft workflow for revision-bound preparation and recoverable submission.`,
    },
    {
      name: 'Product',
      description: `Read categories with GET /categories; administrators create or reuse normalized category names with POST /add-category and { "categoryName": "RC parts" }. Responses contain categoryId and categoryName. A 409 means the normalized name is ambiguous; select an existing category identity.`,
    },
    {
      name: 'User',
      description: `Read and update the signed-in customer's shipping profile. GET /profile returns address; POST /profile accepts shippingAddress along with firstName, lastName, city, state, zipCode, country and phone. POST /profile/{id} requires that ID to match the current user. Profile data is encrypted at rest.

Example body: { "firstName": "Alex", "lastName": "Rider", "shippingAddress": "123 Example Street", "city": "Austin", "state": "TX", "zipCode": "78701", "country": "US", "phone": "5125550100" }.

Organization-role changes require an administrator and accept { "role": "admin" } or { "role": "member" }. Callers cannot change their own membership through this endpoint.`,
    },
    {
      name: 'Printer',
      description: `GET /v2/colors lists filament IDs; POST /v2/estimate estimates a confirmed file without ordering. Both are public. File upload and listing require a session.

For Slant3D uploads: POST /v2/presigned-upload with { "fileName": "part.stl" }, PUT the STL bytes to data.presignedUrl, then POST /v2/confirm with the exact data.filePlaceholder. The owner is taken from the session, not the request. Keep data.publicFileServiceId from confirmation. A presigned upload alone does not finish registration.

POST /upload is a separate multipart public-storage upload (file field); it does not register a Slant File ID. Photos support JPEG, PNG and WebP up to 5,000,000 bytes. GET /list lists only the current user's STL namespace.`,
    },
    {
      name: 'Shopping Cart',
      description: `POST /cart/create accepts {} and returns cartId, ownerId, message and, for an anonymous cart only, guestToken. Retain the token immediately and send X-Cart-Token for guest reads/edits. Account carts require their owner's session.

After signing in, POST /cart/{cartId}/claim with { "expectedUserId": "your-session-user-id" } and X-Cart-Token. Claim revokes the guest capability; repeating it as the owner is idempotent. Shipping, quotes and checkout require an account-owned cart.

Add example: { "cartId": "${uuid}", "skuNumber": "catalog-sku", "quantity": 2, "color": "Black", "filamentType": "PLA", "filamentId": "76fe1f79-3f1e-43e4-b8f4-61159de5b93c" }. Cart writes use validated catalog configuration. PUT /cart/update accepts itemId and quantity (0 removes the line; maximum 69). DELETE /cart/remove uses a JSON body, not query parameters. Re-read after 409. [Cart ownership and agent usage](${source}shopping-cart-agent.md).`,
    },
    {
      name: 'Checkout quotes',
      description: `Create a shipping-inclusive quote with POST /cart/{cartId}/quotes and {}. Requires the owning session and a complete saved shipping profile. The response contains an immutable snapshot, integer USD cents, timestamps in epoch milliseconds and current validity. Quotes last 15 minutes. Reads revalidate cart, profile, prices and filament availability; observed staleness permanently invalidates a quote.

Review the returned totals, then pass the returned id as quoteId to checkout. Do not submit client-calculated amounts or addresses. A quote does not collect payment or create manufacturing work. [Quote contract](${source}checkout-quotes.md).`,
    },
    {
      name: 'Square payments',
      description: `POST /cart/{cartId}/checkout accepts { "quoteId": "${uuid}", "requestKey": "22222222-2222-4222-8222-222222222222" }. Requires an owned cart and valid quote. Save attemptId and open paymentUrl for hosted Square payment. Reuse the same requestKey and input after a timeout; changed input conflicts.

GET /checkout-attempts/{attemptId} or /checkout-attempts/by-request-key/{requestKey} recovers the owned outcome even after cart cleanup. Pending and unknown are not paid. Only verified Square payment evidence authorizes fulfillment; browser redirects never do. [Checkout and recovery](${source}square-online-checkout.md).`,
    },
    {
      name: 'Orders',
      description: `GET /orders returns the authenticated customer's order history; GET /orders/{id} returns a buyer-safe order projection and timeline for that customer. IDs are numeric local order IDs, not Square payment IDs or Slant File IDs. Payment and fulfillment states are separate. Orders belonging to another customer are denied. [Customer response contract](${source}customer-orders.md).`,
    },
    {
      name: 'Admin Orders',
      description: `Shared-organization admin/owner sessions can inspect orders and event history, retry eligible fulfillment, reconcile uncertain provider state, and request a full Square refund. Example: GET /admin/orders/1, then POST /admin/orders/1/reconcile with {} to inspect/recover provider evidence.

Retry eligibility depends on saved fulfillment state. Reconciliation of ambiguous manufacturing is read-only and does not manufacture again. Refunds use a durable operation; success is true only when completed. An explicit override is required when cancellation policy cannot establish a safe refund. Read the operation before retrying. [Recovery policy](${source}order-reconciliation.md), [refund policy](${source}square-refunds.md).`,
    },
    {
      name: 'Admin Catalog',
      description: `Requires shared-organization admin/owner membership. Read /admin/catalog/readiness for missing file IDs or filament diagnostics. Square publication is explicit: set a positive In-Person Price, then publish; saving an Online Price alone does not publish.

PATCH /admin/catalog/1/in-person-price with { "inPersonPrice": 12.50 } changes only that channel price. Inspect /admin/catalog/1/square for status, mapping, error and pendingOperation. An unresolved operation replays its saved request before a newer or opposite action; inspect the response and invoke the desired action again when appropriate. [Publication contract](${source}square-catalog-publication.md).`,
    },
    {
      name: 'Admin product drafts',
      description: `Private, owner-scoped product conversations require an admin/owner session. Start with POST /admin/product-drafts and { "target": { "kind": "new" }, "requestKey": "${uuid}" }. Save the returned id and revision. All edits and attachment changes must use the current expectedRevision; 409 means reload before retrying.

Reserve an attachment intent, follow its returned upload method/URL/headers, then confirm the same transfer. Photos remain private until referenced by a catalog item. Prepare answers and pricing, review the current preparation, then explicitly submit its action. Saving text or restoring history never submits. Inspect operation and reconcile after uncertain submission. Discard keeps cleanup recovery evidence. [Draft workflow](${source}product-drafts.md), [mutation recovery](${source}admin-mutation-recovery-verification.md).`,
    },
    {
      name: 'In-person sales',
      description: `Admin/owner sessions create QR sales from explicit In-Person Prices. POST /admin/in-person-sales accepts { "requestKey": "${uuid}", "items": [{ "productId": 1, "quantity": 2 }] }. Retain saleId and requestKey; replay identical inputs after an uncertain response. The response includes lines, totalCents, currency, paymentStatus, paymentUrl and outcome. Payment is confirmed by verified Square evidence, not the QR redirect.

Square phone intake can be inspected by paymentId and reconciled from saved provider identity. These sales represent handed-over goods and do not create print fulfillment. [In-person sales](${source}square-in-person-sales.md).`,
    },
    {
      name: 'Notifications',
      description: `Admin/owner sessions inspect order notification attempts and failed/ambiguous deliveries. GET /notifications/order/1 lists attempts; POST /notifications/order/1/reconcile recovers notification intent only from saved, verified evidence. POST /notifications/resend/{id} delivers a pending or pre-provider-failed attempt with its original envelope. Sending/unknown outcomes need reconciliation; accepted, ambiguous or permanent failures cannot be blindly resent. These endpoints do not authorize payments or manufacturing.`,
    },
    {
      name: 'Shopping agent',
      description: `POST /agent/sessions returns sessionId, capability, expiresAt and absoluteExpiresAt. Pass Authorization: Bearer <capability> to that session's runs and cancellations. Visits last 30 minutes. Never put capabilities in query strings; queries and upgrade requests are rejected. Requests are capped at 32 KiB.

Run body: { "runId": "${uuid}", "uiRevision": 0, "message": "Find RC parts", "context": [] }. Successful runs stream AG-UI server-sent events; duplicate run IDs return JSON status. A customer cookie or cart token is additionally needed for owned cart operations; the visit capability alone does not grant cart access. Cancel via /agent/sessions/{id}/runs/{runId}/cancel. [Transport and recovery](${source}shopping-agent.md).`,
    },
    {
      name: 'Webhooks',
      description: `Provider-to-server endpoints use signed raw bodies, not browser session cookies. Square requires X-Square-Hmacsha256-Signature computed with the configured fixed notification URL and raw body. Slant3D requires X-Webhook-Timestamp (epoch milliseconds) and X-Webhook-Signature-256 (sha256= plus hex digest) over timestamp + '.' + raw body, within five minutes and with matching platform identity.

Do not reserialize signed JSON. Authenticated duplicates are handled idempotently. Acknowledgement alone does not imply a completed payment, manufacture, or email. See each operation for invalid-signature, conflict and unavailable responses.`,
    },
    {
      name: 'Slant3D',
      description: `Slant3D supplies confirmed print files, estimates and manufacturing lifecycle events. Store durable Slant File IDs and resolve temporary preview URLs on demand. The signed lifecycle webhook updates the local order monotonically and rejects conflicting event identities. An estimate or upload does not place an order. [Lifecycle recovery](${source}order-reconciliation.md).`,
    },
    {
      name: 'Service health',
      description: `GET /live returns { "status": "ok" } without validating integrations. GET /ready checks configuration and reports square, squareWebhook, slant and slantWebhook as ready, disabled or unready; it does not contact providers. GET /health retains the legacy status/message response. Readiness failures return 503. These endpoints do not require a session.`,
    },
  ],
};

const profileExample = {
  firstName: 'Alex',
  lastName: 'Rider',
  shippingAddress: '123 Example Street',
  city: 'Austin',
  state: 'TX',
  zipCode: '78701',
  country: 'US',
  phone: '5125550100',
};
const profileFields = ProfileDataSchema.omit({ id: true });
const sale = z.object({
  saleId: z.string(),
  lines: z.array(
    z.object({
      productId: z.number(),
      name: z.string(),
      quantity: z.number(),
      unitAmountCents: z.number(),
    }),
  ),
  totalCents: z.number(),
  currency: z.literal('USD'),
  paymentStatus: z.string(),
  paymentUrl: z.string().nullable(),
  outcome: z.string(),
});
const cartState = z.object({
  cartId: z.string().uuid(),
  revision: z.number().int(),
  items: z.array(
    z.object({
      id: z.number(),
      productId: z.number().nullable(),
      name: z.string().nullable(),
      quantity: z.number(),
      filamentId: z.string().nullable(),
      color: z.string().nullable(),
      material: z.string(),
      unitPrice: z.number().nullable(),
    }),
  ),
});
const query = (
  name: string,
  value: z.ZodType,
  description: string,
  required = false,
) => ({
  name,
  in: 'query' as const,
  required,
  schema: schema(value),
  description,
});
const pagination = [
  query(
    'page',
    z.number().int().default(1),
    'Page number; values below 1 are clamped to 1',
  ),
  query('limit', z.number().int().default(10), 'Page size; clamped to 1–100'),
];
const expectedRevision = query(
  'expectedRevision',
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  'Current saved draft revision; read again after a conflict',
  true,
);
const catalogItem = z
  .object({
    id: z.number().int(),
    name: z.string(),
    description: z.string(),
    image: z.string(),
    imageGallery: z.array(z.string()),
    stl: z
      .string()
      .nullable()
      .describe(
        'API preview URL when a Slant File ID exists; otherwise the legacy value',
      ),
    publicFileServiceId: z.string().nullable(),
    price: z.number().describe('Online Price in USD'),
    inPersonPrice: z.number().nullable().describe('In-Person Price in USD'),
    filamentType: z.string(),
    skuNumber: z.string(),
    color: z.string(),
    categories: z.array(
      z.object({ categoryId: z.number(), categoryName: z.string() }),
    ),
  })
  .passthrough();
const catalogPage = z.object({
  products: z.array(catalogItem),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    totalItems: z.number(),
    totalPages: z.number(),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  }),
});
const photo = {
  description: 'Decoded photo bytes; no-store',
  content: Object.fromEntries(
    ['image/png', 'image/jpeg', 'image/webp'].map(type => [
      type,
      { schema: { type: 'string' as const, format: 'binary' } },
    ]),
  ),
};
const draftResponse = jsonResponse(
  'Current private draft, revision and authoritative catalog context',
  productDraftResponseSchema,
);
const draftErrors = {
  400: error('Invalid input or upload limit exceeded'),
  404: error('Owned draft, attachment or transfer not found'),
  409: error('Revision conflict or transfer state requires recovery'),
  500: error(
    'Persistence/provider failure; reload saved state before retrying',
  ),
};
const resetErrors = {
  400: {
    description:
      'Invalid input or expired/used token; Better Auth code/message response',
  },
  403: { description: 'Origin or redirect URL not trusted' },
  429: error('IP request limit exceeded'),
  500: { description: 'Auth persistence or email delivery failed' },
};

/** Supplements fields absent from route annotations; response merging preserves existing schemas. */
const supplements: Record<string, Partial<Operation>> = {
  'get /cart/{cartId}/quotes/{quoteId}': {
    summary: 'Read and revalidate an owned checkout quote',
    description:
      'Read the immutable quote and revalidate the current cart, shipping profile, Online Price and filament availability. An observed change permanently marks the quote stale; provider failures fail closed. A valid read is not payment authorization. Submit its id as quoteId to POST /cart/{cartId}/checkout, which validates and consumes the quote.',
  },
  'get /orders': {
    parameters: [
      query(
        'limit',
        z.number().int().default(20),
        'Maximum rows; clamped to 1–100',
      ),
      query(
        'offset',
        z.number().int().min(0).default(0),
        'Number of rows to skip',
      ),
      query(
        'direction',
        z.enum(['asc', 'desc']).default('desc'),
        'Creation-time sort direction',
      ),
    ],
  },
  'get /admin/orders': {
    parameters: [
      'status',
      'slantStatus',
      'email',
      'orderNumber',
      'slantPublicOrderId',
      'squareOrderId',
      'squarePaymentId',
      'createdAfter',
      'createdBefore',
      'q',
    ].map(name =>
      query(
        name,
        z.string(),
        name === 'q'
          ? 'Substring match on customer email or order number'
          : name.startsWith('created')
            ? 'Inclusive creation-time bound'
            : 'Exact-match filter',
      ),
    ),
  },
  'post /upload': {
    summary: 'Upload a file to public storage',
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: ['file'],
            properties: {
              file: {
                type: 'string',
                format: 'binary',
                description: 'JPEG, PNG, WebP photo or STL file',
              },
            },
          },
        },
      },
    },
    responses: { 409: error('Upload identity conflict; retry upload') },
  },
  'post /auth/signup': {
    summary: 'Create a customer account',
    description:
      'Create an email/password account and return success, message and the provider user. Sets the session cookie on successful automatic sign-in. Name defaults to the email local part. Maximum 3 attempts per IP with a refreshed 60-second TTL.',
    requestBody: jsonBody(
      signUpSchema.extend({
        password: z.string().min(8).max(128),
        name: z.string().optional(),
      }),
      {
        email: 'customer@example.com',
        password: 'example-password',
        name: 'Alex',
      },
    ),
    responses: { 429: error('Too many signup attempts') },
  },
  'post /auth/signin': {
    summary: 'Sign in with email and password',
    description:
      'Verify credentials, set the HttpOnly session cookie, and return message plus safe user fields (id, email, name, role). Maximum 5 attempts per IP with a refreshed 60-second TTL. Provider failures preserve their status and body; 502 means the provider returned an invalid success payload.',
    requestBody: jsonBody(signInSchema, {
      email: 'customer@example.com',
      password: 'example-password',
    }),
  },
  'post /auth/signout': {
    summary: 'Revoke the current session',
    description:
      'Forward the current cookie to Better Auth, revoke the session and forward the clearing Set-Cookie header. Send no JSON body. Returns { "message": "signout success" }; provider errors retain their original status and body.',
  },
  'post /api/auth/request-password-reset': {
    tags: ['Auth'],
    summary: 'Request a password reset email',
    description:
      'Send a reset link with an optional trusted redirectTo callback. Unknown emails receive the same generic success response. Tokens expire in one hour. At most 5 requests per IP with a refreshed 900-second TTL; delivery failures do not report success.',
    requestBody: jsonBody(
      z.object({
        email: z.string().email(),
        redirectTo: z.string().url().optional(),
      }),
      {
        email: 'customer@example.com',
        redirectTo: 'https://luluspeedworks.com/reset-password',
      },
    ),
    responses: {
      200: jsonResponse(
        'Generic acknowledgement for registered and unknown email addresses',
        z.object({ status: z.literal(true), message: z.string() }),
        {
          status: true,
          message:
            'If this email exists in our system, check your email for the reset link',
        },
      ),
      ...resetErrors,
    },
  },
  'post /api/auth/reset-password': {
    tags: ['Auth'],
    summary: 'Set a password using a reset token',
    description:
      'Consume the token from the reset link, set a password of 8–128 characters, and revoke all existing sessions. Sign in again afterwards. Invalid, expired and reused tokens return 400. At most 10 submissions per IP with a refreshed 900-second TTL.',
    requestBody: jsonBody(
      z.object({ token: z.string(), newPassword: z.string().min(8).max(128) }),
      { token: '<token-from-reset-link>', newPassword: 'new-example-password' },
    ),
    responses: {
      200: jsonResponse(
        'Password changed; sessions revoked',
        z.object({ status: z.literal(true) }),
        { status: true },
      ),
      ...resetErrors,
    },
  },
  'get /live': {
    tags: ['Service health'],
    summary: 'Check process liveness',
    description:
      'Returns status ok without checking bindings or contacting providers.',
    responses: {
      200: jsonResponse(
        'Worker responded',
        z.object({ status: z.literal('ok') }),
        { status: 'ok' },
      ),
    },
  },
  'get /ready': {
    tags: ['Service health'],
    summary: 'Check configured feature readiness',
    description:
      'Validate core bindings and integration configuration without provider requests. Fully absent optional integrations are disabled; partial configuration is unready and returns 503.',
    responses: {
      200: jsonResponse(
        'Core configuration valid',
        z.object({
          status: z.literal('ok'),
          features: z.object({
            square: z.enum(['ready', 'disabled', 'unready']),
            squareWebhook: z.enum(['ready', 'disabled', 'unready']),
            slant: z.enum(['ready', 'disabled', 'unready']),
            slantWebhook: z.enum(['ready', 'disabled', 'unready']),
          }),
        }),
      ),
      503: {
        description:
          'Configuration invalid; status error and the same features map',
      },
    },
  },
  'get /health': {
    tags: ['Service health'],
    summary: 'Check legacy configuration health',
    description:
      'Validate the same configuration as /ready; on failure return status error and a message describing the configuration problem. Does not contact providers.',
    responses: {
      200: jsonResponse(
        'Configuration valid',
        z.object({ status: z.literal('ok') }),
        { status: 'ok' },
      ),
      503: jsonResponse(
        'Configuration invalid',
        z.object({ status: z.literal('error'), message: z.string() }),
      ),
    },
  },
  'get /catalog/assets/{id}/image': {
    tags: ['Products'],
    summary: 'Read a published catalog photo',
    description:
      'Return an active photo only when its exact URL is referenced by a current catalog image or gallery. Unpublished/private assets return 404. Bytes are decrypted on read and served with detected MIME and no-store.',
    responses: {
      200: photo,
      404: error('Photo not found or not referenced by the catalog'),
      503: error('Photo storage/decryption unavailable'),
    },
  },
  'get /product/{id}': {
    summary: 'Read one Catalog Item',
    description:
      'Return the Catalog Item with USD prices, parsed imageGallery and ordered categories. The stl compatibility field is the API preview URL; follow /product/{id}/print-file for a temporary provider URL.',
    responses: {
      200: jsonResponse(
        'Catalog Item with categories and channel prices',
        catalogItem,
      ),
      404: error('Product not found'),
    },
  },
  'get /products': {
    parameters: pagination,
    responses: {
      200: jsonResponse(
        'Array without pagination; envelope when page or limit is supplied',
        z.union([z.array(catalogItem), catalogPage]),
        {
          products: [],
          pagination: {
            page: 1,
            limit: 10,
            totalItems: 0,
            totalPages: 0,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        },
      ),
    },
    summary: 'Browse Catalog Items',
    description:
      'Omit page and limit to receive an array. Supply either to receive { products, pagination }. Page defaults to 1; limit defaults to 10 and is clamped to 1–100. Includes ordered categories and API print preview URLs. Prices are USD.',
  },
  'get /products/search': {
    parameters: [
      query('q', z.string().min(2), 'Search name and description', true),
      ...pagination,
    ],
    responses: {
      200: jsonResponse('Matching Catalog Items and pagination', catalogPage),
    },
    summary: 'Search Catalog Items',
    description:
      'Search name and description with q (at least 2 trimmed characters). Returns { products, pagination }; page defaults to 1 and limit defaults to 10, clamped to 1–100.',
  },
  'put /update-product': {
    summary: 'Update a Catalog Item',
    description:
      'Save the existing item and channel prices under the catalog concurrency guard. Managed attachments cannot be bypassed through a legacy update. This route uses the existing update price semantics; draft preparation provides the guided workflow.',
  },
  'delete /delete-product/{id}': {
    summary: 'Delete a Catalog Item',
    description:
      'Delete a catalog item and its category links through the catalog guard. Published or unresolved Square operations can block deletion; resolve publication state before retrying.',
    responses: {
      400: error('Invalid item ID'),
      409: error('Catalog publication or concurrent change prevents deletion'),
      500: error('Persistence failure'),
    },
  },
  'post /profile': {
    requestBody: jsonBody(ProfileDataSchema, profileExample),
    responses: {
      200: jsonResponse(
        'Saved shipping profile; address is returned as shippingAddress',
        profileFields.extend({ id: z.string(), email: z.string() }),
        { id: 'user_123', email: 'customer@example.com', ...profileExample },
      ),
    },
  },
  'post /profile/{id}': {
    responses: {
      200: jsonResponse(
        'Saved shipping profile',
        profileFields.extend({ id: z.string(), email: z.string() }),
      ),
    },
    requestBody: jsonBody(ProfileDataSchema, profileExample),
  },
  'get /profile': {
    responses: {
      200: jsonResponse(
        'Decrypted shipping profile; address is returned as address',
        profileFields
          .omit({ shippingAddress: true })
          .extend({ id: z.string(), email: z.string(), address: z.string() }),
      ),
      500: error('Profile decryption or configuration failure'),
    },
  },
  'post /users/{id}/organization-role': {
    responses: {
      200: jsonResponse(
        'Updated membership and target user',
        z.object({
          success: z.literal(true),
          member: z
            .object({
              id: z.string(),
              organizationId: z.string(),
              userId: z.string(),
              role: z.string(),
            })
            .passthrough(),
          user: z.object({
            id: z.string(),
            email: z.string(),
            name: z.string(),
          }),
        }),
      ),
    },
    requestBody: jsonBody(z.object({ role: z.enum(['admin', 'member']) }), {
      role: 'member',
    }),
  },
  'get /cart/{cartId}/agent-state': {
    tags: ['Shopping Cart'],
    summary: 'Read authoritative cart state',
    description:
      'Recover the owned cart revision and current catalog-bound lines after an agent operation or reload. Does not execute a cart mutation.',
    responses: {
      200: jsonResponse('Current cart state', cartState, {
        cartId: uuid,
        revision: 0,
        items: [],
      }),
      400: { description: 'Invalid cart UUID' },
      404: error('Cart not found or caller lacks access'),
    },
  },
  'get /cart/{cartId}/agent-actions/{sessionId}/{runId}': {
    tags: ['Shopping Cart'],
    summary: 'Recover an agent cart action receipt',
    description:
      'Look up a confirmed action by cart, session and run UUIDs. Returns appliedRevision and current cart; the current cart revision can be newer than the applied revision. Missing receipts return 404.',
    responses: {
      200: jsonResponse(
        'Confirmed receipt and current cart',
        z.object({
          status: z.literal('applied'),
          appliedRevision: z.number().int(),
          cart: cartState,
        }),
      ),
      400: { description: 'Invalid cart/session/run UUID' },
      404: error('No confirmed cart action or inaccessible cart'),
    },
  },
  'get /admin/product-drafts/by-request-key/{requestKey}': {
    tags: ['Admin product drafts'],
    summary: 'Recover a draft by creation request key',
    description:
      'Find the current owner’s saved draft after a timed-out creation. The request key must be a UUID. Discarded drafts return 410 rather than beginning another conversation.',
    responses: {
      200: draftResponse,
      ...draftErrors,
      410: error('Draft discarded'),
    },
  },
  'post /admin/product-drafts/{id}/prepare': {
    tags: ['Admin product drafts'],
    summary: 'Prepare answers and interpret a product instruction',
    description:
      'Save answers at expectedRevision, optionally interpret one message, and return pending questions and authoritative context. Confirm a proposed category separately from a message. Interpretation failure retains user input and does not submit catalog changes.',
    requestBody: jsonBody(prepareProductDraftSchema, {
      expectedRevision: 1,
      answers: { name: 'RC bracket' },
    }),
    responses: {
      200: draftResponse,
      ...draftErrors,
      503: error('Save outcome unavailable; reload before retrying'),
    },
  },
  'get /admin/product-drafts': {
    description:
      'List only the current owner’s active conversations, newest updated first. Each result retains its immutable new/existing target and saved revision; listing does not submit or authorize a change.',
  },
  'get /admin/product-drafts/{id}/operation': {
    description:
      'Inspect the saved mutation, catalog result and readiness independently of conversation history. A null operation means none is saved; only succeeded confirms local completion. Recover uncertain outcomes through reconcile.',
  },
  'post /admin/product-drafts/{id}/attachments/intents': {
    description:
      'Reserve a durable transfer for a photo or print file at expectedRevision. Save the returned transfer identity and follow upload.method, upload.url and upload.headers. A missing upload instruction means inspect/recover the transfer instead of inventing another upload.',
  },
  'put /admin/product-drafts/{id}/attachments/transfers/{transferId}/content': {
    parameters: [expectedRevision],
    description:
      'Send raw photo bytes to the reserved photo transfer with expectedRevision in the query. JPEG, PNG and WebP are byte-validated, limited to 5,000,000 bytes and stored encrypted. This is not a multipart upload.',
    requestBody: {
      required: true,
      content: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    },
  },
  'post /admin/product-drafts/{id}/attachments/transfers/{transferId}/confirm':
    {
      description:
        'Confirm the exact saved transfer after upload, or recover its existing confirmation. Send the current expectedRevision. Keep the same transfer identity after an uncertain provider response.',
    },
  'post /admin/product-drafts/{id}/attachments/transfers/{transferId}/retry': {
    description:
      'Recover the existing transfer at expectedRevision. Inspect the returned upload instruction and requiresReselection state; unresolved provider outcomes retain their identity instead of silently creating a duplicate.',
  },
  'patch /admin/product-drafts/{id}/attachments': {
    description:
      'Update primaryPhotoId and/or photoOrder using saved attachment IDs and the current expectedRevision. Primary selection and gallery order are independent; the gallery allows up to five photos.',
  },
  'delete /admin/product-drafts/{id}/attachments/{attachmentId}': {
    parameters: [expectedRevision],
    description:
      'Remove the saved attachment using expectedRevision in the query, then attempt reference-aware cleanup. Inspect the returned draft for pending cleanup; removal does not promise immediate provider deletion.',
  },
  'get /admin/product-drafts/{id}/attachments/{attachmentId}/image': {
    description:
      'Decrypt a saved photo belonging to this private draft. Returns image bytes and detected Content-Type. Requires the owning administrator session.',
    responses: { 200: photo },
  },
  'get /admin/product-drafts/{id}/cleanup': {
    description:
      'Read cleanup entries and transfer identities even after the draft is discarded. Pending or protected assets remain visible for safe recovery.',
  },
  'post /admin/product-drafts/{id}/cleanup/retry': {
    description:
      'Retry cleanup using expectedRevision. Reference checks protect shared/catalog assets; inspect pending and protected entries in the response before any further retry.',
  },
  'patch /admin/catalog/{id}/in-person-price': {
    description:
      'Set an explicit positive In-Person Price in USD, at most two decimal places, while preserving Online Price and print metadata. A concurrent catalog revision returns 409; reload before retrying.',
  },
  'post /admin/in-person-sales': {
    tags: ['In-person sales'],
    summary: 'Create or recover an in-person QR sale',
    description:
      'Snapshot explicit In-Person Prices and request a Square hosted payment link. Reuse requestKey with identical item quantities after a timeout. A changed input or seller conflicts. The response is not evidence of completed payment or manufacturing.',
    requestBody: jsonBody(saleInputSchema, {
      requestKey: uuid,
      items: [{ productId: 1, quantity: 2 }],
    }),
    responses: {
      201: jsonResponse('Durable sale and hosted payment state', sale),
      400: { description: 'Invalid input or missing positive In-Person Price' },
      409: { description: 'Key/input or seller configuration conflict' },
      502: {
        description:
          'Square/configuration failure; inspect the saved sale and retry the same key',
      },
    },
  },
  'get /admin/in-person-sales/{id}': {
    tags: ['In-person sales'],
    summary: 'Read in-person sale payment state',
    description:
      'Inspect a saved sale, immutable line prices and current payment outcome. A pending sale without a payment URL reports outcome unknown. Paid sales return paymentUrl null.',
    responses: {
      200: jsonResponse('Saved sale', sale),
      404: error('Sale not found'),
    },
  },
  'get /admin/square-phone-intake/{paymentId}': {
    tags: ['In-person sales'],
    summary: 'Inspect Square POS intake',
    description:
      'Read the saved intake row by Square payment ID, including provider identity, state and any unmatched-evidence error. This ID is not a numeric local order ID.',
    responses: {
      200: jsonResponse(
        'Saved Square POS intake receipt',
        z.object({
          paymentId: z.string(),
          squareOrderId: z.string(),
          merchantId: z.string(),
          locationId: z.string(),
          state: z.string(),
          error: z.string().nullable(),
          orderId: z.number().nullable(),
          createdAt: z.number(),
        }),
      ),
      404: error('Intake not found'),
    },
  },
  'post /admin/square-phone-intake/{paymentId}/reconcile': {
    tags: ['In-person sales'],
    summary: 'Reconcile saved Square POS payment evidence',
    description:
      'Retrieve and verify payment evidence using the saved merchant/payment identities. Send no body. Only supported completed Square POS payments can become handed-over orders; unmatched evidence remains inspectable.',
    responses: {
      200: jsonResponse(
        'Payment evidence acknowledged; inspect saved intake for resulting state',
        z.object({ received: z.literal(true), orderId: z.number().optional() }),
      ),
      404: error('Intake not found'),
    },
  },
  'post /admin/orders/{id}/cancel-refund': {
    requestBody: jsonBody(
      refundInput,
      { reason: 'Customer requested cancellation', override: false },
      false,
    ),
    responses: {
      200: jsonResponse(
        'Durable full-refund state; success only when completed',
        z.object({
          orderId: z.number(),
          operationId: z.string(),
          state: z.string(),
          squareRefundId: z.string().nullable(),
          error: z.string().nullable(),
          success: z.boolean(),
        }),
      ),
    },
  },
  'post /webhook/square': {
    responses: {
      200: jsonResponse(
        'Acknowledged; orderId is present for a verified online order',
        z.object({ received: z.literal(true), orderId: z.number().optional() }),
        { received: true },
      ),
    },
    parameters: [
      {
        in: 'header',
        name: 'X-Square-Hmacsha256-Signature',
        required: true,
        schema: { type: 'string' },
        description:
          'Base64 HMAC-SHA256 signature over configured notification URL plus exact raw body',
      },
    ],
    requestBody: jsonBody(
      z.object({
        type: z.string(),
        merchant_id: z.string(),
        data: z.object({ id: z.string(), type: z.string() }),
      }),
      {
        type: 'payment.updated',
        merchant_id: 'merchant-id',
        data: { id: 'payment-id', type: 'payment' },
      },
    ),
  },
  'post /agent/sessions/{id}/runs/{runId}/cancel': {
    responses: {
      200: jsonResponse(
        'Known run status; a new cancellation creates a fallback/cancelled tombstone',
        z.object({
          runId: z.string().uuid(),
          uiRevision: z.number().int(),
          status: z.enum(['running', 'completed', 'fallback']),
          reason: z.string().nullable(),
        }),
        { runId: uuid, uiRevision: 0, status: 'fallback', reason: 'cancelled' },
      ),
    },
  },
  'post /notifications/order/{orderId}/reconcile': {
    responses: {
      200: jsonResponse(
        'Verified evidence and resulting notification delivery states',
        z.object({
          verified: z.literal(true),
          notifications: z.array(
            z.object({
              id: z.number(),
              status: z.string(),
              providerMessageId: z.string().nullable(),
            }),
          ),
        }),
        { verified: true, notifications: [] },
      ),
    },
  },
  'post /agent/sessions': {
    summary: 'Create a shopping visit capability',
    responses: {
      201: jsonResponse(
        'New anonymous visit; retain the capability privately',
        z.object({
          sessionId: z.string().uuid(),
          capability: z.string(),
          expiresAt: z.number().int(),
          absoluteExpiresAt: z.number().int(),
        }),
      ),
    },
  },
};

const publicOperations = new Set([
  'get /live',
  'get /ready',
  'get /health',
  'post /auth/signup',
  'post /auth/signin',
  'post /api/auth/request-password-reset',
  'post /api/auth/reset-password',
  'get /products',
  'get /products/search',
  'get /product/{id}',
  'get /product/{id}/print-file',
  'get /catalog/assets/{id}/image',
  'get /categories',
  'get /v2/colors',
  'post /v2/estimate',
  'post /cart/create',
  'post /agent/sessions',
  'post /webhook/square',
  'post /webhook/slant3d',
]);
const guestOperations = new Set([
  'get /cart/{cartId}',
  'post /cart/add',
  'put /cart/update',
  'delete /cart/remove',
  'get /cart/{cartId}/agent-state',
  'get /cart/{cartId}/agent-actions/{sessionId}/{runId}',
]);
const adminOperations = new Set([
  'post /v2/add-product',
  'put /update-product',
  'put /v2/update-product',
  'delete /delete-product/{id}',
  'post /add-category',
  'post /users/{id}/organization-role',
]);

/** Enrich the generated document, never the application's request handlers. */
export async function completeReference(document: Document): Promise<Document> {
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = methods?.[method];
      if (!operation) continue;
      operation.responses ??= {};
      const key = `${method} ${path}`;
      const extra = supplements[key];
      if (extra)
        Object.assign(operation, {
          ...extra,
          responses: { ...operation.responses, ...extra.responses },
          parameters: [
            ...(operation.parameters ?? []),
            ...(extra.parameters ?? []),
          ],
        });
      operation.parameters = [
        ...new Map(
          (operation.parameters ?? []).map(parameter => [
            '$ref' in parameter
              ? parameter.$ref
              : `${parameter.in}:${parameter.name}`,
            parameter,
          ]),
        ).values(),
      ];
      // Route summaries remain the source of truth; first sentences supply missing sidebar labels.
      operation.summary ??= operation.description?.split(/\.\s/)[0];
      operation.description ??= operation.summary;
      const isAdmin =
        path.startsWith('/admin/') ||
        path.startsWith('/notifications/') ||
        adminOperations.has(key);
      const isAgent =
        path.startsWith('/agent/sessions/') && path.includes('/runs');
      operation.security = publicOperations.has(key)
        ? []
        : guestOperations.has(key)
          ? guest
          : isAgent
            ? [{ agentCapability: [] }]
            : cookie;
      const access = isAdmin
        ? admin
        : guestOperations.has(key)
          ? guestAccess
          : isAgent
            ? 'Requires the bearer capability belonging to this visit. Cart access additionally requires its owner session or guest token.'
            : operation.security.length
              ? account
              : '';
      if (access)
        operation.description = `${operation.description}\n\n${access}`;
      if (operation.security === cookie)
        operation.responses[401] ??= error(
          'Missing, invalid or expired session',
        );
      if (isAdmin)
        operation.responses[403] ??= error(
          'Shared-organization admin or owner membership required',
        );
      if (
        path.startsWith('/admin/product-drafts/') &&
        /attachments|cleanup/.test(path)
      ) {
        for (const [status, response] of Object.entries(draftErrors))
          operation.responses[status] ??= response;
      }
      operation.responses[403] ??= error('Browser Origin is not allowed');
    }
  }
  // hono-openapi 0.4 resolves response builders but leaves request/parameter builders
  // untouched. JSON serialization otherwise turns those schemas into empty objects.
  await resolveSchemaBuilders(document, document);
  return document;
}

async function resolveSchemaBuilders(
  value: unknown,
  document: Document,
): Promise<void> {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'schema' &&
      child &&
      typeof child === 'object' &&
      'builder' in child &&
      typeof child.builder === 'function'
    ) {
      const built = await child.builder({
        version: '3.1.0',
        components: document.components?.schemas ?? {},
      });
      (value as Record<string, unknown>)[key] = built.schema;
      if (built.components) {
        document.components ??= { schemas: {} };
        document.components.schemas = {
          ...document.components.schemas,
          ...built.components,
        };
      }
    } else {
      await resolveSchemaBuilders(child, document);
    }
  }
}
