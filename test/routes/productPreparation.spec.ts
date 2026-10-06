import { and, eq, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { type Context, Hono } from 'hono';
import { generateSpecs } from 'hono-openapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  categoryTable,
  type productAssets,
  productDrafts,
  type productsTable,
} from '../../src/db/schema';
import type { WorkerEnv } from '../../src/factory';
import {
  estimateSlant3DFile,
  getSlant3DFile,
} from '../../src/lib/slant3d-v2-files';
import { emptyAttachments } from '../../src/modules/productAttachmentState';
import type { ProductDraft } from '../../src/modules/productDraftContracts';
import { productQuestions } from '../../src/modules/productInterpretation';
import type { ProductPreparation } from '../../src/modules/productPreparationContracts';
import router from '../../src/routes/productDrafts';
import { mockEnv } from '../mocks/env';

type Draft = typeof productDrafts.$inferSelect;
type Product = typeof productsTable.$inferSelect;
type Asset = typeof productAssets.$inferSelect;
const boundary = vi.hoisted(() => ({ db: {} as WorkerEnv['Variables']['db'] }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => boundary.db }));
vi.mock('../../src/modules/productDrafts', async original => ({
  ...(await original<typeof import('../../src/modules/productDrafts')>()),
  readProductDraftContext: vi.fn(async () => ({
    status: 'available',
    categories: [{ categoryId: 9, categoryName: 'Mounts' }],
  })),
}));
vi.mock('../../src/lib/slant3d-v2-files', async original => ({
  ...(await original<typeof import('../../src/lib/slant3d-v2-files')>()),
  getSlant3DFile: vi.fn(),
  estimateSlant3DFile: vi.fn(),
}));
vi.mock('../../src/utils/authMiddleware', () => ({
  authMiddleware: async (c: Context<WorkerEnv>, next: () => Promise<void>) => {
    if (!c.req.header('x-admin'))
      return c.json({ error: 'Unauthenticated' }, 401);
    c.set('userId', 'owner');
    await next();
  },
  requireCatalogMutationRole: async (
    c: Context<WorkerEnv>,
    next: () => Promise<void>,
  ) => {
    if (c.req.header('x-admin') !== 'admin')
      return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
}));
const id = '11111111-1111-4111-8111-111111111111';
const filamentId = '22222222-2222-4222-8222-222222222222';
const dialect = new SQLiteSyncDialect();
let row: Draft | undefined;
let product: Product;
let assets: Asset[];
let categories: { categoryId: number; categoryName: string }[];
let writes: { value: Partial<Draft>; condition?: SQL }[];
let reads: SQL[];
let loseCas: boolean;
const app = new Hono().route('/drafts', router);
function request(
  body: unknown = { expectedRevision: 4 },
  role = 'admin',
  read = false,
) {
  return app.request(
    `/drafts/${id}/${read ? 'preparation' : 'pricing/prepare'}`,
    {
      method: read ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-admin': role },
      ...(read ? {} : { body: JSON.stringify(body) }),
    },
    mockEnv(),
  );
}
function currentDraft() {
  if (!row) throw new Error('Missing mock draft');
  return row;
}
async function prepare() {
  const response = await request();
  expect(response.status).toBe(200);
  return ((await response.json()) as { preparation: ProductPreparation })
    .preparation;
}
beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  reads = [];
  loseCas = false;
  row = {
    id,
    ownerId: 'owner',
    target: { kind: 'existing', productId: 7 },
    revision: 4,
    createdAt: 1,
    updatedAt: 1,
    status: 'active',
    attachments: null,
    preparation: null,
    categoryConfirmationToken: null,
    categoryConfirmationName: null,
    categoryConfirmationKey: null,
    categoryConfirmationId: null,
    state: { answers: {}, history: [], pendingQuestions: [] },
  };
  product = {
    id: 7,
    name: 'Bracket',
    description: 'A useful bracket',
    filamentType: 'PLA',
    color: 'Blue',
    markupPercentage: 50,
    inPersonPrice: 725,
    price: 99999,
    image: 'catalog-photo',
    imageGallery: '[]',
    publicFileServiceId: 'file-7',
    squareRevision: 3,
  } as Product;
  categories = [{ categoryId: 9, categoryName: 'Mounts' }];
  assets = [
    {
      id: 'asset-print',
      revision: 2,
      status: 'active',
      providerId: 'file-7',
      objectKey: null,
      fileUrl: 'https://files.example/7.stl',
      references: ['product:7'],
    },
  ] as unknown as Asset[];
  boundary.db = {
    select: () => {
      let table: unknown;
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        where(condition: SQL) {
          if (table === productDrafts) reads.push(condition);
          return query;
        },
        async get() {
          return structuredClone(table === productDrafts ? row : product);
        },
        async all() {
          return structuredClone(table === categoryTable ? categories : assets);
        },
      };
      return query;
    },
    update: () => {
      const write: { value: Partial<Draft>; condition?: SQL } = { value: {} };
      const query = {
        set(value: Partial<Draft>) {
          write.value = value;
          return query;
        },
        where(condition: SQL) {
          write.condition = condition;
          return query;
        },
        async returning() {
          writes.push(write);
          if (loseCas) return [];
          if (!row) throw new Error('Missing mock draft');
          row = { ...row, ...structuredClone(write.value) };
          return [{ id }];
        },
      };
      return query;
    },
  } as unknown as WorkerEnv['Variables']['db'];
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: [
          {
            publicId: filamentId,
            profile: 'PLA',
            color: 'Blue',
            hexValue: '#0000ff',
            provider: 'Slant 3D',
            available: true,
          },
        ],
      }),
    ),
  );
  vi.mocked(getSlant3DFile).mockResolvedValue({
    publicFileServiceId: 'file-7',
    fileURL: 'https://files.example/7.stl',
    name: 'Bracket',
    platformId: 'test',
    type: 'stl',
  });
  vi.mocked(estimateSlant3DFile).mockResolvedValue({
    publicFileServiceId: 'file-7',
    filamentId,
    quantity: 1,
    total: 2,
  });
});

describe('authoritative prepared pricing HTTP boundary', () => {
  it('documents the exact revision-bound pricing request in HTTP OpenAPI', async () => {
    const specs = await generateSpecs(app);
    const operation = specs.paths?.['/drafts/{id}/pricing/prepare']?.post;
    expect(operation?.requestBody).toMatchObject({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['expectedRevision'],
            properties: { expectedRevision: { type: 'integer', minimum: 1 } },
            additionalProperties: false,
          },
        },
      },
    });
    expect(operation?.responses).toHaveProperty('409');
  });
  it('suppresses the markup question when the current catalog has known retained markup', () => {
    const draft = {
      ...currentDraft(),
      context: {
        status: 'available',
        product: { ...product, inPersonPrice: 7.25 },
        categories,
      },
      attachments: { ...emptyAttachments(), validation: [] },
      cleanupPending: false,
    } as unknown as ProductDraft;
    expect(productQuestions(draft).map(question => question.id)).not.toContain(
      'markupPercentage',
    );
    draft.context = {
      ...draft.context,
      product: { ...product, markupPercentage: null },
    } as ProductDraft['context'];
    expect(productQuestions(draft).map(question => question.id)).toContain(
      'markupPercentage',
    );
  });
  it('binds the retained catalog photo asset revision through its catalog image route', async () => {
    const assetId = '44444444-4444-4444-8444-444444444444';
    product.image = `/catalog/assets/${assetId}/image`;
    assets.push({
      ...assets[0],
      id: assetId,
      objectKey: 'private-photo-object',
      providerId: null,
      revision: 9,
    });
    const result = await prepare();
    expect(result.snapshot?.primaryPhotoAssetId).toBe(assetId);
    expect(result.snapshot?.assetRevisions).toContainEqual({
      id: assetId,
      revision: 9,
    });
    assets[1].revision++;
    const read = await request(undefined, 'admin', true);
    expect(
      ((await read.json()) as { preparation: ProductPreparation }).preparation
        .status,
    ).toBe('stale');
  });
  it('preserves explicit gallery order separately from primary selection for multiple saved photos', async () => {
    const draft = currentDraft();
    const first = '55555555-5555-4555-8555-555555555555';
    const second = '66666666-6666-4666-8666-666666666666';
    draft.attachments = emptyAttachments();
    draft.attachments.photos = [first, second].map(assetId => ({
      id: assetId,
      assetId,
      kind: 'photo',
      name: 'Bracket.png',
      size: 12,
      contentType: 'image/png',
      status: 'saved',
      imageUrl: `/admin/product-drafts/${id}/assets/${assetId}/image`,
      publicFileServiceId: null,
    }));
    draft.attachments.primaryPhotoId = first;
    draft.attachments.primaryExplicit = true;
    draft.attachments.photoOrder = [second, first];
    assets.push(
      ...[first, second].map(assetId => ({
        ...assets[0],
        id: assetId,
        ownerId: 'owner',
        draftId: id,
        providerId: null,
        objectKey: `photo-${assetId}`,
      })),
    );
    const result = await prepare();
    expect(result.status).toBe('ready');
    expect(result.snapshot?.imageGallery).toEqual([
      `/catalog/assets/${second}/image`,
      `/catalog/assets/${first}/image`,
    ]);
    expect(result.snapshot?.primaryPhotoAssetId).toBe(first);
  });
  it('prepares deletion with unknown markup and unavailable production service without provider calls', async () => {
    product.markupPercentage = null;
    product.image = null;
    product.publicFileServiceId = null;
    product.stl = 'legacy.stl';
    product.inPersonPrice = null;
    vi.mocked(fetch).mockRejectedValue(new Error('Production unavailable'));
    const response = await request({ expectedRevision: 4, action: 'delete' });
    expect(response.status).toBe(200);
    const result = (
      (await response.json()) as { preparation: ProductPreparation }
    ).preparation;
    expect(result.status).toBe('ready');
    expect(result.snapshot?.action).toBe('delete');
    expect(result.pricing).toMatchObject({
      productionCost: null,
      markupPercentage: null,
      basis: null,
      inPersonPrice: null,
    });
    expect(result.readiness.submissionAuthorized).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(getSlant3DFile).not.toHaveBeenCalled();
    expect(estimateSlant3DFile).not.toHaveBeenCalled();
  });
  it('separates replacement assets used by the snapshot from original cleanup identities', async () => {
    const draft = currentDraft();
    const oldId = '77777777-7777-4777-8777-777777777777';
    const newId = '88888888-8888-4888-8888-888888888888';
    product.image = `/catalog/assets/${oldId}/image`;
    draft.attachments = emptyAttachments();
    draft.attachments.photos = [
      {
        id: newId,
        assetId: newId,
        kind: 'photo',
        name: 'New.png',
        size: 12,
        contentType: 'image/png',
        status: 'saved',
        imageUrl: `/catalog/assets/${newId}/image`,
        publicFileServiceId: null,
      },
    ];
    draft.attachments.primaryPhotoId = newId;
    draft.attachments.photoOrder = [newId];
    assets.push(
      ...[oldId, newId].map(assetId => ({
        ...assets[0],
        id: assetId,
        kind: 'photo' as const,
        ownerId: 'owner',
        draftId: id,
        providerId: null,
        objectKey: `photo-${assetId}`,
      })),
    );
    const result = await prepare();
    expect(result.snapshot?.assetIds).toContain(newId);
    expect(result.snapshot?.assetIds).not.toContain(oldId);
    expect(result.snapshot?.cleanupAssetIds).toEqual(
      expect.arrayContaining([oldId, newId]),
    );
  });
  it('retains explicit markup, prices in USD independently, and never authorizes submission', async () => {
    const result = await prepare();
    expect(result.status).toBe('ready');
    expect(result.readiness).toEqual({
      ready: true,
      submissionAuthorized: false,
    });
    expect(result.pricing).toEqual({
      currency: 'USD',
      productionCost: 2,
      markupPercentage: 50,
      onlinePrice: 3,
      inPersonPrice: 7.25,
      basis: {
        publicFileServiceId: 'file-7',
        filamentId,
        material: 'PLA',
        color: 'Blue',
        quantity: 1,
      },
    });
    expect(estimateSlant3DFile).toHaveBeenCalledWith(
      expect.anything(),
      'file-7',
      { filamentId, quantity: 1 },
    );
    expect(result.snapshot?.assetRevisions).toEqual([
      { id: 'asset-print', revision: 2 },
    ]);
    expect(result.snapshot?.productRevision).toBe(3);
    const condition = writes[0].condition;
    if (!condition) throw new Error('Missing update predicate');
    expect(dialect.sqlToQuery(condition)).toEqual(
      dialect.sqlToQuery(
        and(
          eq(productDrafts.id, id),
          eq(productDrafts.ownerId, 'owner'),
          eq(productDrafts.revision, 4),
          eq(productDrafts.status, 'active'),
        ) as SQL,
      ),
    );
    expect(
      reads.every(condition =>
        dialect.sqlToQuery(condition).params.includes('owner'),
      ),
    ).toBe(true);
  });
  it.each([
    '',
    'member',
  ])('rejects unauthorized role %s without provider or persistence work', async role => {
    expect((await request(undefined, role)).status).toBe(role ? 403 : 401);
    expect(writes).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects stale and malformed revisions and missing drafts before estimating', async () => {
    expect((await request({ expectedRevision: 3 })).status).toBe(409);
    expect(
      (await request({ expectedRevision: 4, submissionAuthorized: true }))
        .status,
    ).toBe(400);
    row = undefined;
    expect((await request()).status).toBe(404);
    expect((await request(undefined, 'admin', true)).status).toBe(404);
    expect(estimateSlant3DFile).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it('keeps legacy unknown markup nullable and blocked instead of inferring it from sale price', async () => {
    product.markupPercentage = null;
    const result = await prepare();
    expect(result.status).toBe('blocked');
    expect(result.pricing.markupPercentage).toBeNull();
    expect(result.pricing.onlinePrice).toBeNull();
    expect(result.pricing.inPersonPrice).toBe(7.25);
    expect(result.validation).toContainEqual(
      expect.objectContaining({ field: 'markupPercentage', code: 'required' }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    'provider',
    'profile',
    'color',
    'available',
    'duplicate',
  ])('blocks a non-exact %s production option', async mismatch => {
    const option = {
      publicId: filamentId,
      profile: 'PLA',
      color: 'Blue',
      hexValue: '#0000ff',
      provider: 'Slant 3D',
      available: true,
    };
    const data =
      mismatch === 'duplicate'
        ? [option, option]
        : [
            {
              ...option,
              ...(mismatch === 'available'
                ? { available: false }
                : { [mismatch]: 'Other' }),
            },
          ];
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true, data })),
    );
    const result = await prepare();
    expect(result.status).toBe('blocked');
    expect(result.pricing.productionCost).toBeNull();
    expect(result.validation).toContainEqual(
      expect.objectContaining({ code: 'unsupported_basis' }),
    );
    expect(estimateSlant3DFile).not.toHaveBeenCalled();
  });
  it.each([
    'publicFileServiceId',
    'filamentId',
    'quantity',
  ])('refuses an estimate with mismatched %s', async field => {
    vi.mocked(estimateSlant3DFile).mockResolvedValue({
      publicFileServiceId: 'file-7',
      filamentId,
      quantity: 1,
      total: 2,
      [field]: field === 'quantity' ? 2 : 'different',
    });
    const result = await prepare();
    expect(result.status).toBe('unavailable');
    expect(result.snapshot).toBeNull();
    expect(result.readiness.ready).toBe(false);
  });
  it.each([
    'ownership',
    'identity',
    'inactive',
  ])('blocks an attached file with invalid %s before provider calls', async invalidity => {
    const draft = currentDraft();
    const assetId = '33333333-3333-4333-8333-333333333333';
    draft.attachments = emptyAttachments();
    draft.attachments.printFile = {
      id: filamentId,
      assetId,
      kind: 'print',
      name: 'Bracket.stl',
      size: 12,
      contentType: 'model/stl',
      status: 'saved',
      imageUrl: null,
      publicFileServiceId: 'file-7',
    };
    assets = [
      {
        ...assets[0],
        id: assetId,
        ownerId: invalidity === 'ownership' ? 'other' : 'owner',
        draftId: id,
        providerId: invalidity === 'identity' ? 'other-file' : 'file-7',
        status: invalidity === 'inactive' ? 'deleted' : 'active',
      },
    ] as Asset[];
    const result = await prepare();
    expect(result.status).toBe('blocked');
    expect(result.readiness.ready).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts explicit markup override and keeps in-person price independent of online pricing', async () => {
    currentDraft().state.answers = {
      markupPercentage: '125',
      inPersonPrice: '1.25',
    };
    const result = await prepare();
    expect(result.pricing).toMatchObject({
      productionCost: 2,
      markupPercentage: 125,
      onlinePrice: 4.5,
      inPersonPrice: 1.25,
    });
  });
  it('uses the exact current filament identity when the draft selects its hex color', async () => {
    currentDraft().state.answers.color = '#0000FF';
    const result = await prepare();
    expect(result.pricing.basis).toEqual({
      publicFileServiceId: 'file-7',
      filamentId,
      material: 'PLA',
      color: 'Blue',
      quantity: 1,
    });
  });
  it.each([
    '1.234',
    'unknown',
    '0',
    '100000000',
    '9'.repeat(400),
  ])('blocks invalid independent in-person price %s before estimation', async price => {
    currentDraft().state.answers.inPersonPrice = price;
    const result = await prepare();
    expect(result.status).toBe('blocked');
    expect(result.validation).toContainEqual(
      expect.objectContaining({ field: 'inPersonPrice', code: 'invalid' }),
    );
    expect(estimateSlant3DFile).not.toHaveBeenCalled();
  });
  it('persists unavailable pricing safely and returns the saved result without another provider call', async () => {
    vi.mocked(estimateSlant3DFile).mockRejectedValue(
      new Error('provider failed'),
    );
    const result = await prepare();
    expect(result.status).toBe('unavailable');
    const read = await request(undefined, 'admin', true);
    expect(await read.json()).toEqual({ preparation: result });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    'revision',
    'product',
    'asset',
    'category',
    'category reassignment',
  ])('invalidates saved preparation when %s changes', async changed => {
    currentDraft().state.answers.categoryNames = ['Mounts'];
    await prepare();
    if (changed === 'revision') currentDraft().revision++;
    if (changed === 'product') product.description = 'Catalog changed';
    if (changed === 'asset') assets[0].revision++;
    if (changed === 'category') categories[0].categoryName = 'Renamed';
    if (changed === 'category reassignment')
      categories = [{ categoryId: 12, categoryName: 'Mounts' }];
    const read = await request(undefined, 'admin', true);
    const result = (await read.json()) as { preparation: ProductPreparation };
    expect(result.preparation.status).toBe('stale');
    expect(result.preparation.readiness).toEqual({
      ready: false,
      submissionAuthorized: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('returns a conflict when catalog changes during the provider call or save CAS loses', async () => {
    vi.mocked(estimateSlant3DFile).mockImplementation(async () => {
      assets[0].revision++;
      return {
        publicFileServiceId: 'file-7',
        filamentId,
        quantity: 1,
        total: 2,
      };
    });
    expect((await request()).status).toBe(409);
    expect(writes).toEqual([]);
    vi.mocked(estimateSlant3DFile).mockResolvedValue({
      publicFileServiceId: 'file-7',
      filamentId,
      quantity: 1,
      total: 2,
    });
    loseCas = true;
    expect((await request()).status).toBe(409);
    expect(row?.preparation).toBeNull();
  });
});
