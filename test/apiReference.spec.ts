import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { generateSpecs } from 'hono-openapi';
import app from '../src/app';
import {
  ProfileDataSchema,
  signInSchema,
  signUpSchema,
  addCartItemSchema,
} from '../src/db/schema';
import { prepareProductDraftSchema } from '../src/modules/productInterpretation';
import { saleInputSchema } from '../src/modules/inPersonSales';
import { mockEnv } from './mocks/env';

type Document = Awaited<ReturnType<typeof generateSpecs>>;
type Path = NonNullable<NonNullable<Document['paths']>[string]>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
let document: Document;
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error('Expected documented value');
  return value;
}
const operation = (path: string, method: Method = 'get') =>
  required(document.paths?.[path]?.[method]);
const body = (path: string, method: Method = 'post') => {
  const request = required(operation(path, method).requestBody);
  if ('$ref' in request) throw new Error('Expected inline request body');
  return request.content['application/json'];
};

beforeAll(async () => {
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockClear();
  const res = await app.request('/open-api', {}, mockEnv());
  expect(res.status).toBe(200);
  document = await res.json();
  expect(fetch).not.toHaveBeenCalled();
  // Optional artifacts for local browser inspection; never contact the deployed API.
  if (process.env.API_DOCS_ARTIFACT_DIR) {
    writeFileSync(
      `${process.env.API_DOCS_ARTIFACT_DIR}/open-api.json`,
      JSON.stringify(document, null, 2),
    );
    writeFileSync(
      `${process.env.API_DOCS_ARTIFACT_DIR}/docs.html`,
      await (await app.request('/docs', {}, mockEnv())).text(),
    );
  }
});

describe('generated API reference', () => {
  it('documents every concrete mounted API operation without inventing wildcard routes', () => {
    const expected = new Set(
      app.routes
        .filter(
          route =>
            route.method !== 'ALL' &&
            !route.path.includes('*') &&
            !['/docs', '/open-api'].includes(route.path),
        )
        .map(
          route =>
            `${route.method.toLowerCase()} ${route.path.replace(/:([^/]+)/g, '{$1}')}`,
        ),
    );
    const actual = new Set(
      Object.entries(document.paths ?? {}).flatMap(([path, methods]) =>
        Object.keys(methods ?? {}).map(method => `${method} ${path}`),
      ),
    );
    expect(actual).toEqual(expected);
    expect([...actual]).not.toContain('post /v2/upload');
  });

  it('fills the introduction, every section and each operation with usable content', () => {
    expect(document.info.title).toBe('Lulu Speedworks API');
    expect(document.info.description).toContain('Checkout sequence');
    expect(JSON.stringify(document)).not.toMatch(
      /Heyo|Hono Documentation|Development documentation/,
    );
    const tags = new Map(
      required(document.tags).map(tag => [tag.name, tag.description]),
    );
    expect(tags.get('Auth')).toContain("credentials: 'include'");
    for (const description of tags.values())
      expect(required(description).length).toBeGreaterThan(100);
    for (const [path, methods] of Object.entries(required(document.paths))) {
      for (const op of Object.values(
        methods as Record<Method, NonNullable<Path['get']>>,
      )) {
        expect(op.summary, path).toBeTruthy();
        expect(required(op.description).length, path).toBeGreaterThan(25);
        expect(required(op.tags).length, path).toBeGreaterThan(0);
        for (const tag of required(op.tags))
          expect(tags.has(tag), `${path}: ${tag}`).toBe(true);
        expect(
          Object.keys(required(op.responses)).some(status =>
            /^[23]\d\d$/.test(status),
          ),
          path,
        ).toBe(true);
        for (const response of Object.values(required(op.responses))) {
          if (!('$ref' in response))
            expect(response.description, path).toBeTruthy();
        }
      }
    }
  });

  it('distinguishes public access, account cookies, guest capabilities and admin membership', () => {
    for (const [path, method] of [
      ['/auth/signin', 'post'],
      ['/auth/signup', 'post'],
      ['/api/auth/reset-password', 'post'],
      ['/products', 'get'],
      ['/v2/colors', 'get'],
      ['/v2/estimate', 'post'],
      ['/cart/create', 'post'],
      ['/webhook/slant3d', 'post'],
      ['/webhook/square', 'post'],
      ['/ready', 'get'],
    ] as const)
      expect(operation(path, method).security, path).toEqual([]);
    expect(operation('/profile').security).toEqual([{ cookieAuth: [] }]);
    expect(operation('/cart/{cartId}').security).toEqual([
      { cookieAuth: [] },
      { cartToken: [] },
    ]);
    expect(operation('/cart/{cartId}/quotes', 'post').security).toEqual([
      { cookieAuth: [] },
    ]);
    expect(operation('/agent/sessions/{id}/runs', 'post').security).toEqual([
      { agentCapability: [] },
    ]);
    for (const path of [
      '/admin/orders',
      '/admin/in-person-sales/{id}',
      '/admin/product-drafts',
      '/notifications/failed',
    ]) {
      expect(operation(path).description).toContain(
        'admin or owner membership',
      );
      expect(operation(path).responses).toHaveProperty('401');
      expect(operation(path).responses).toHaveProperty('403');
    }
    expect(document.components.securitySchemes?.cookieAuth).toMatchObject({
      in: 'cookie',
      name: '__Secure-better-auth.session_token',
    });
    expect(document.security).toBeUndefined();
  });

  it('resolves formerly empty request and parameter schemas before JSON serialization', () => {
    expect(body('/auth/signin').schema).toMatchObject({
      required: ['email', 'password'],
    });
    expect(body('/v2/estimate').schema).toMatchObject({
      properties: {
        publicFileServiceId: { type: 'string', format: 'uuid' },
        options: { type: 'object' },
      },
    });
    expect(body('/v2/add-product').schema).toMatchObject({
      type: 'object',
      properties: { publicFileServiceId: { type: 'string' } },
    });
    expect(body('/v2/update-product', 'put').schema).toMatchObject({
      properties: { inPersonPrice: { type: 'number' } },
    });
    expect(body('/add-category').schema).toMatchObject({
      properties: { categoryName: { type: 'string' } },
    });
    expect(operation('/v2/colors').parameters).toContainEqual(
      expect.objectContaining({
        name: 'profile',
        schema: { type: 'string', enum: ['PLA', 'PETG', 'ABS'] },
      }),
    );
    for (const methods of Object.values(required(document.paths))) {
      for (const op of Object.values(
        methods as Record<Method, NonNullable<Path['get']>>,
      )) {
        const request = op.requestBody;
        if (request && !('$ref' in request))
          for (const media of Object.values(request.content)) {
            expect(media.schema).toBeDefined();
            expect(Object.keys(required(media.schema)).length).toBeGreaterThan(
              0,
            );
          }
      }
    }
  });

  it('documents binary uploads, revision parameters and the actual presigned flow', () => {
    expect(operation('/upload', 'post').requestBody).toMatchObject({
      content: {
        'multipart/form-data': {
          schema: {
            properties: { file: { type: 'string', format: 'binary' } },
          },
        },
      },
    });
    const upload = operation(
      '/admin/product-drafts/{id}/attachments/transfers/{transferId}/content',
      'put',
    );
    expect(upload.requestBody).toMatchObject({
      content: { 'application/octet-stream': { schema: { format: 'binary' } } },
    });
    expect(upload.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'expectedRevision',
          in: 'query',
          required: true,
        }),
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({
          name: 'transferId',
          in: 'path',
          required: true,
        }),
      ]),
    );
    expect(body('/v2/presigned-upload').schema).not.toHaveProperty(
      'properties.ownerId',
    );
    expect(operation('/v2/confirm', 'post').description).toContain(
      '/v2/presigned-upload',
    );
  });

  it('keeps request examples valid against implemented validation contracts', () => {
    for (const [path, validator] of [
      ['/auth/signup', signUpSchema],
      ['/auth/signin', signInSchema],
      ['/profile', ProfileDataSchema],
      ['/admin/in-person-sales', saleInputSchema],
      ['/admin/product-drafts/{id}/prepare', prepareProductDraftSchema],
    ] as const)
      expect(validator.safeParse(body(path).example).success, path).toBe(true);
    const cartSection = required(
      required(
        required(document.tags).find(tag => tag.name === 'Shopping Cart'),
      ).description,
    );
    const example = required(cartSection.match(/Add example: (\{.*?\})\./))[1];
    expect(addCartItemSchema.safeParse(JSON.parse(example)).success).toBe(true);
  });

  it('retains existing schemas and webhook headers while adding missing responses', () => {
    const checkout = operation('/cart/{cartId}/checkout', 'post');
    expect(checkout.responses?.['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { properties: { attemptId: { type: 'string' } } },
        },
      },
    });
    expect(operation('/webhook/slant3d', 'post').parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'X-Webhook-Timestamp' }),
        expect.objectContaining({ name: 'X-Webhook-Signature-256' }),
      ]),
    );
    expect(operation('/products').responses?.['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            anyOf: expect.arrayContaining([
              expect.objectContaining({ type: 'array' }),
              expect.objectContaining({ type: 'object' }),
            ]),
          },
        },
      },
    });
  });

  it('serves Scalar with the same generated document on repeated requests', async () => {
    const page = await app.request('/docs', {}, mockEnv());
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('/open-api');
    expect(html).toContain('api-reference');
    expect(
      await (await app.request('/open-api', {}, mockEnv())).json(),
    ).toEqual(document);
  });
});
