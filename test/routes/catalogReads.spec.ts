import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import {
  categoryTable,
  productsTable,
  productsToCategories,
} from '../../src/db/schema';
import { mockEnv } from '../mocks/env';
import { scriptedDatabase } from '../mocks/scriptedDatabase';

const origin = 'https://api.luluspeedworks.com';
const category = { categoryId: 4, categoryName: 'RC Parts' };
const categories = [category, { categoryId: 8, categoryName: 'Pit Tools' }];
const env = mockEnv();

function item(id: number) {
  return {
    id,
    name: `Catalog item ${id}`,
    description: `Description ${id}`,
    image: `https://photos.example.com/${id}.png`,
    imageGallery: JSON.stringify([`https://photos.example.com/${id}.png`]),
    price: 12.34,
    inPersonPrice: id % 2 ? 975 : null,
    publicFileServiceId: `shared-file-${id % 3}`,
    stl: 'https://expired.example.com/temporary.stl',
    filamentType: 'PLA',
    skuNumber: `SKU-${id}`,
    color: 'Black',
    categoryId: category.categoryId,
  };
}

function links(items: ReturnType<typeof item>[]) {
  return items
    .flatMap(product =>
      categories.map((value, orderIndex) => ({
        ...value,
        productId: product.id,
        orderIndex,
      })),
    )
    .reverse();
}

function expected(product: ReturnType<typeof item>) {
  return {
    ...product,
    imageGallery: JSON.parse(product.imageGallery),
    inPersonPrice:
      product.inPersonPrice === null ? null : product.inPersonPrice / 100,
    stl: `${origin}/product/${product.id}/print-file`,
    categories,
  };
}

function withoutLegacyCategory<T extends { categoryId: number }>(product: T) {
  const { categoryId: _legacyCategory, ...fields } = product;
  return fields;
}

function database(...responses: unknown[]) {
  const fixture = scriptedDatabase(...responses);
  vi.mocked(drizzle).mockReturnValue(fixture.db);
  return fixture;
}

function request(path: string, browserOrigin = 'https://luluspeedworks.com') {
  return app.request(
    `${origin}${path}`,
    { headers: { Origin: browserOrigin } },
    env,
  );
}

beforeEach(() => {
  vi.mocked(fetch)
    .mockReset()
    .mockRejectedValue(new Error('Slant unavailable'));
});
afterEach(() => vi.restoreAllMocks());

describe('D1 catalog consumer contracts', () => {
  test.each([
    'down',
    'slow',
  ] as const)('%s provider cannot block list, pagination, search or ordinary detail', async provider => {
    if (provider === 'slow')
      vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const products = [item(1), item(2), item(4)];
    for (const path of [
      '/products',
      '/products?page=1&limit=100',
      '/products/search?q=Catalog&page=1&limit=100',
    ]) {
      const paginated = path !== '/products';
      const search = path.startsWith('/products/search');
      const fixture = database(
        ...(paginated ? [[{ count: 3 }]] : []),
        search ? products.map(withoutLegacyCategory) : products,
        links(products),
      );
      const response = await request(path);
      expect(response.status).toBe(200);
      const body = await response.json();
      const expectedProducts = products.map(expected);
      expect(paginated ? body.products : body).toEqual(
        search ? expectedProducts.map(withoutLegacyCategory) : expectedProducts,
      );
      expect(fixture.replies).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    }
    for (const product of products) {
      const fixture = database([product], categories);
      const response = await request(`/product/${product.id}`);
      expect(response.status).toBe(200);
      const { categoryId: _legacyCategory, ...detail } = expected(product);
      expect(await response.json()).toEqual(detail);
      expect(fixture.calls).toContainEqual({
        method: 'orderBy',
        args: [productsToCategories.orderIndex, categoryTable.categoryId],
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  test.each([
    '/products',
    '/products/search?q=Catalog',
  ])('%s bounds pages and includes categories for a complete Lulu snapshot', async path => {
    const all = Array.from({ length: 205 }, (_, index) => item(index + 1));
    const search = path.startsWith('/products/search');
    const responseItem = (product: ReturnType<typeof item>) =>
      search ? withoutLegacyCategory(expected(product)) : expected(product);
    const received: unknown[] = [];
    for (const page of [1, 2, 3, 4]) {
      const rows = all.slice((page - 1) * 100, page * 100);
      const fixture = database(
        [{ count: 205 }],
        search ? rows.map(withoutLegacyCategory) : rows,
        ...(rows.length ? [links(rows)] : []),
      );
      const response = await request(
        `${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=999`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        products: rows.map(responseItem),
        pagination: {
          page,
          limit: 100,
          totalItems: 205,
          totalPages: 3,
          hasNextPage: page < 3,
          hasPreviousPage: page > 1,
        },
      });
      expect(fixture.calls).toContainEqual({ method: 'limit', args: [100] });
      expect(fixture.calls).toContainEqual({
        method: 'offset',
        args: [(page - 1) * 100],
      });
      expect(fixture.calls).toContainEqual({
        method: 'orderBy',
        args: [productsTable.id],
      });
      expect(
        fixture.calls.filter(call => call.method === 'innerJoin'),
      ).toHaveLength(rows.length ? 1 : 0);
      if (rows.length)
        expect(fixture.calls).toContainEqual({
          method: 'where',
          args: [
            inArray(
              productsToCategories.productId,
              rows.map(product => product.id),
            ),
          ],
        });
      expect(fixture.replies).toEqual([]);
      received.push(...body.products);
    }
    expect(received).toEqual(all.map(responseItem));
    expect(fetch).not.toHaveBeenCalled();
  });

  test('legacy array response retains every item and chunks category reads, including repeated file IDs', async () => {
    const rows = Array.from({ length: 205 }, (_, index) => item(index + 1));
    const chunks = [rows.slice(0, 100), rows.slice(100, 200), rows.slice(200)];
    const fixture = database(rows, ...chunks.map(links));
    const response = await request('/products');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(rows.map(expected));
    expect(fixture.calls.filter(call => call.method === 'where')).toEqual(
      chunks.map(chunk => ({
        method: 'where',
        args: [
          inArray(
            productsToCategories.productId,
            chunk.map(product => product.id),
          ),
        ],
      })),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    '/products',
    '/products?page=1&limit=100',
    '/products/search?q=missing',
  ])('%s preserves the empty response contract without category or provider work', async path => {
    const paginated = path !== '/products';
    const fixture = database(...(paginated ? [[{ count: 0 }]] : []), []);
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      paginated
        ? {
            products: [],
            pagination: {
              page: 1,
              limit: path.includes('100') ? 100 : 10,
              totalItems: 0,
              totalPages: 0,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          }
        : [],
    );
    expect(fixture.calls.some(call => call.method === 'innerJoin')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('category ties and legacy null positions have a stable order; uncategorized items stay empty', async () => {
    database(
      [item(1), item(2)],
      [
        { productId: 1, categoryId: 9, categoryName: 'Last', orderIndex: 0 },
        {
          productId: 1,
          categoryId: 7,
          categoryName: 'First',
          orderIndex: null,
        },
        { productId: 1, categoryId: 3, categoryName: 'Middle', orderIndex: 0 },
      ],
    );
    const body = await (await request('/products')).json();
    expect(
      body.map((product: { categories: unknown[] }) => product.categories),
    ).toEqual([
      [
        { categoryId: 7, categoryName: 'First' },
        { categoryId: 3, categoryName: 'Middle' },
        { categoryId: 9, categoryName: 'Last' },
      ],
      [],
    ]);
  });

  test.each([
    '/products?page=9007199254740991&limit=100',
    '/products/search?q=Catalog&page=9007199254740992',
    '/products?page=no',
    '/products/search?q=Catalog&limit=no',
  ])('%s rejects unsafe pagination before querying', async path => {
    const fixture = database();
    expect((await request(path)).status).toBe(400);
    expect(fixture.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('legacy STL and gallery behavior is preserved without claiming a durable Slant identity', async () => {
    database(
      [
        {
          ...item(1),
          publicFileServiceId: null,
          stl: 'https://legacy.example.com/file.stl',
          imageGallery: 'invalid JSON',
        },
      ],
      [],
    );
    expect(await (await request('/products')).json()).toMatchObject([
      {
        publicFileServiceId: null,
        stl: 'https://legacy.example.com/file.stl',
        imageGallery: [],
        categories: [],
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('OpenAPI describes list category membership and the on-demand preview contract', async () => {
    const response = await request('/open-api');
    expect(response.status).toBe(200);
    const spec = await response.json();
    for (const path of ['/products', '/products/search']) {
      const properties =
        spec.paths[path].get.responses['200'].content['application/json'].schema
          .properties.products.items.properties;
      expect(properties.categories.items.properties).toMatchObject({
        categoryId: { type: 'number' },
        categoryName: { type: 'string' },
      });
      expect(properties.stl.description).toContain('on-demand');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('explicit original-store STL preview contract', () => {
  const storeOrigin = 'https://rc-store.benhalverson.dev';
  function fileResponse(
    fileURL = 'https://files.example.com/model.stl?signature=temporary',
  ) {
    return Response.json({
      data: { publicFileServiceId: 'shared-file-1', fileURL },
    });
  }

  test('product.stl is a directly loadable URL with a no-store redirect and original-store CORS', async () => {
    database([item(1)], categories, item(1));
    const metadata = await request('/product/1', storeOrigin);
    const product = await metadata.json();
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(fileResponse());
    // The original store passes product.stl directly to useLoader(STLLoader, url).
    const preview = await app.request(
      product.stl,
      { headers: { Origin: storeOrigin } },
      env,
    );
    expect(preview.status).toBe(302);
    expect(preview.headers.get('location')).toBe(
      'https://files.example.com/model.stl?signature=temporary',
    );
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(preview.headers.get('access-control-allow-origin')).toBe(
      storeOrigin,
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/files/shared-file-1');
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });

  test.each([
    'not-an-id',
    '0',
    '1.5',
  ])('rejects invalid product identity %s before database/provider work', async id => {
    const fixture = database();
    expect((await request(`/product/${id}/print-file`)).status).toBe(404);
    expect(fixture.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    undefined,
    { ...item(1), publicFileServiceId: null },
  ])('missing product or durable file identity does not call Slant', async row => {
    const fixture = database(row);
    expect((await request('/product/1/print-file')).status).toBe(404);
    expect(fixture.calls).toContainEqual({
      method: 'where',
      args: [eq(productsTable.id, 1)],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    'http://files.example.com/model.stl',
    'https://user:secret@files.example.com/model.stl',
    'not a url',
    '',
  ])('rejects unsafe provider URL %s independently of metadata reads', async url => {
    database(item(1), [item(1)], categories);
    vi.mocked(fetch).mockResolvedValueOnce(fileResponse(url));
    const preview = await request('/product/1/print-file');
    expect(preview.status).toBe(502);
    expect(preview.headers.get('location')).toBeNull();
    expect(await preview.json()).toEqual({ error: 'Preview unavailable' });
    expect((await request('/product/1')).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test.each([
    'request',
    'response body',
  ])('five-second timeout aborts a stalled provider %s and releases admission', async phase => {
    database(item(1), item(1));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let signal: AbortSignal | null | undefined;
    vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
      signal = options?.signal;
      if (phase === 'request')
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), {
            once: true,
          });
        });
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener(
              'abort',
              () => controller.error(signal?.reason),
              { once: true },
            );
          },
        }),
      );
    });
    const response = await request('/product/1/print-file');
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(signal?.aborted).toBe(true);
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    vi.mocked(fetch).mockResolvedValueOnce(fileResponse());
    expect((await request('/product/1/print-file')).status).toBe(302);
  }, 8000);

  test('four pending lookups reject excess work while browsing and failures stay independent', async () => {
    database(
      item(1),
      item(1),
      item(1),
      item(1),
      item(1),
      [item(1)],
      categories,
      item(1),
    );
    const pending: Array<{
      resolve: (value: Response) => void;
      reject: (error: Error) => void;
    }> = [];
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve, reject) =>
          pending.push({ resolve, reject }),
        ),
    );
    const requests = Array.from({ length: 4 }, () =>
      request('/product/1/print-file'),
    );
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(4));
      const excess = await request('/product/1/print-file');
      expect(excess.status).toBe(503);
      expect(await excess.json()).toEqual({ error: 'Preview resolver busy' });
      expect((await request('/product/1')).status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(4);
      pending[0].reject(new Error('One provider file failed'));
      expect((await requests[0]).status).toBe(502);
      vi.mocked(fetch).mockResolvedValueOnce(fileResponse());
      expect((await request('/product/1/print-file')).status).toBe(302);
      for (const lookup of pending.slice(1)) lookup.resolve(fileResponse());
      expect(
        (await Promise.all(requests)).map(response => response.status),
      ).toEqual([502, 302, 302, 302]);
    } finally {
      for (const lookup of pending) lookup.resolve(fileResponse());
      await Promise.all(requests);
    }
  });
});
