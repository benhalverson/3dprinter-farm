import { Param, SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/app';
import * as schema from '../../src/db/schema';
import { createPaidOrderFulfillment } from '../../src/modules/paidOrderFulfillment';
import { emptyAttachments } from '../../src/modules/productAttachmentState';
import { productPhotoBase64 } from '../fixtures/productPhotoBytes';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';

const id = '4a1a372c-cbd7-4bac-bc73-6c29d2a9e292';
const missing = '5a1a372c-cbd7-4bac-bc73-6c29d2a9e292';
type Row = Record<string, unknown>;
const tables = new Map<SQLiteTable, Row[]>();
const bucket = new Map<string, Uint8Array>();
let beforeUpdate: ((table: SQLiteTable, changes: Row) => void) | undefined;
let rejectUpdate = false;
let failRead: SQLiteTable | undefined;
let failReadError: Error;
let beforeRead: ((table: SQLiteTable) => void) | undefined;
function records(table: SQLiteTable) {
  return tables.get(table) ?? [];
}
function matching(row: Row, condition?: SQL): boolean {
  if (!condition) return true;
  const chunks = condition.queryChunks;
  const column = chunks.find(chunk => chunk instanceof SQLiteColumn);
  const parameter = chunks.find(chunk => chunk instanceof Param);
  if (column instanceof SQLiteColumn && parameter instanceof Param) {
    const key = Object.keys(column.table).find(
      key => (column.table as unknown as Row)[key] === column,
    )!;
    return row[key] === parameter.value;
  }
  return chunks
    .filter(chunk => chunk instanceof SQL)
    .every(chunk => matching(row, chunk as SQL));
}
const db = {
  select: vi.fn(() => ({
    from: (table: SQLiteTable) => {
      const query = (condition?: SQL) => ({
        get: async () => {
          beforeRead?.(table);
          if (failRead === table) throw failReadError;
          return structuredClone(
            records(table).find(row => matching(row, condition)),
          );
        },
        all: async () =>
          structuredClone(
            records(table).filter(row => matching(row, condition)),
          ),
        orderBy: () => ({
          all: async () =>
            structuredClone(
              records(table).filter(row => matching(row, condition)),
            ),
        }),
      });
      return { ...query(), where: query };
    },
  })),
  insert: vi.fn((table: SQLiteTable) => ({
    values: (value: Row) => {
      const insert = () => {
        const rows = records(table);
        if (!rows.some(row => row.id === value.id)) {
          if (table === schema.ordersTable) value.id = 42;
          rows.push(
            structuredClone({
              ...value,
              ...(table === schema.productDrafts
                ? { status: 'active', attachments: null }
                : {}),
            }),
          );
          tables.set(table, rows);
        }
        return structuredClone(rows.filter(row => row.id === value.id));
      };
      return {
        returning: async () => insert(),
        onConflictDoNothing: async () => {
          insert();
        },
      };
    },
  })),
  update: vi.fn((table: SQLiteTable) => ({
    set: (changes: Row) => ({
      where: (condition: SQL) => ({
        returning: async () => {
          beforeUpdate?.(table, changes);
          if (rejectUpdate) {
            rejectUpdate = false;
            return [];
          }
          const rows = records(table).filter(row => matching(row, condition));
          rows.forEach(row => {
            Object.assign(row, structuredClone(changes));
          });
          return structuredClone(rows);
        },
      }),
    }),
  })),
};
const put = vi.fn(async (key: string, bytes: Uint8Array) => {
  if (bucket.has(key)) return null;
  bucket.set(key, bytes.slice());
  return { key };
});
const get = vi.fn(async (key: string) => {
  const bytes = bucket.get(key);
  return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
});
const remove = vi.fn(async (key: string) => {
  bucket.delete(key);
});
const env = {
  ...mockEnv(),
  PHOTO_BUCKET: { put, get, delete: remove } as unknown as R2Bucket,
};
const bytes = (mime: keyof typeof productPhotoBase64 = 'image/png') =>
  Uint8Array.from(atob(productPhotoBase64[mime]), value => value.charCodeAt(0));
function draft() {
  return records(
    schema.productDrafts,
  )[0] as unknown as typeof schema.productDrafts.$inferSelect;
}
const revision = () => draft().revision;
function authorize(ownerId = 'user_123', role = 'admin') {
  mockBetterAuth.getSession.mockResolvedValue({
    session: { id: 'session' },
    user: { id: ownerId, email: 'admin@example.com', name: 'Admin', role },
  });
  tables.set(schema.organizationTable, [{ id: 'org_shared_catalog' }]);
  tables.set(schema.memberTable, [
    {
      id: 'member',
      userId: ownerId,
      organizationId: 'org_shared_catalog',
      role,
    },
  ]);
}
const request = (path: string, method = 'GET', body?: unknown) =>
  app.request(
    `/admin/product-drafts/${id}${path}`,
    {
      method,
      headers: {
        cookie: 'session=yes',
        'Content-Type':
          body instanceof Uint8Array ? 'image/jpeg' : 'application/json',
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    },
    env,
  );
async function intent(kind = 'photo', extra: Row = {}) {
  const response = await request('/attachments/intents', 'POST', {
    expectedRevision: revision(),
    kind,
    name: 'same-name.png',
    size: bytes().length,
    ...extra,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}
async function upload(extra: Row = {}, data = bytes()) {
  const started = await intent('photo', { size: data.length, ...extra });
  const response = await app.request(
    started.transfer.upload.url,
    {
      method: 'PUT',
      body: data,
      headers: { cookie: 'session=yes', 'Content-Type': 'text/plain' },
    },
    env,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
function provider() {
  const providerId = crypto.randomUUID();
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        data: {
          presignedUrl: 'https://upload.example.com/file',
          key: 'key',
          filePlaceholder: {
            publicFileServiceId: providerId,
            name: 'part.stl',
            ownerId: 'user_123',
            platformId: 'platform',
            type: 'stl',
            createdAt: '',
            updatedAt: '',
          },
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );
  return providerId;
}
async function savedPrint(extra: Row = {}) {
  const providerId = provider();
  await intent('print', extra);
  const transfer = draft().attachments!.transfers.at(-1)!;
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({
      data: {
        publicFileServiceId: providerId,
        fileURL: `https://files.example.com/${providerId}`,
      },
    }),
  );
  const response = await request(
    `/attachments/transfers/${transfer.id}/confirm`,
    'POST',
    {
      expectedRevision: revision(),
    },
  );
  expect(response.status).toBe(200);
  return { providerId, assetId: transfer.attachmentId };
}
function orderRequest(reference: string) {
  return new Hono()
    .post('/fulfill', async c => {
      try {
        return c.json(
          await createPaidOrderFulfillment({
            db: db as never,
            env,
          }).fulfillPaidOrder({
            fulfillment: {
              cartId: 'cart',
              userId: 'user',
              stripeEventId: 'event',
              stripeObjectId: 'object',
              idempotencyKey: 'payment',
            },
            profile: {
              email: 'customer@example.com',
              firstName: 'A',
              lastName: 'B',
              shippingAddress: '1 Main',
              city: 'City',
              state: 'CA',
              zipCode: '12345',
              phone: '5555555555',
            },
            items: [
              {
                id: 1,
                skuNumber: 'SKU',
                quantity: 1,
                color: 'black',
                filamentType: 'PLA',
                filamentId: 'filament',
                productName: 'Part',
                productImage: reference,
                productPrice: 1,
                stl: null,
                publicFileServiceId: 'provider',
              },
            ],
          }),
        );
      } catch {
        return c.json({ error: 'Could not fulfill' }, 500);
      }
    })
    .request('/fulfill', { method: 'POST' });
}
describe('durable product attachments through Hono', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetch)
      .mockReset()
      .mockRejectedValue(new Error('Unexpected provider request'));
    tables.clear();
    bucket.clear();
    beforeUpdate = undefined;
    rejectUpdate = false;
    failRead = undefined;
    failReadError = new Error('Read failed');
    beforeRead = undefined;
    put.mockReset().mockImplementation(async (key, data) => {
      if (bucket.has(key)) return null;
      bucket.set(key, data.slice());
      return { key };
    });
    get.mockReset().mockImplementation(async key => {
      const data = bucket.get(key);
      return data ? { arrayBuffer: async () => data.slice().buffer } : null;
    });
    remove.mockReset().mockImplementation(async key => {
      bucket.delete(key);
    });
    vi.mocked(drizzle).mockReturnValue(
      db as unknown as ReturnType<typeof drizzle>,
    );
    tables.set(schema.productDrafts, [
      {
        id,
        ownerId: 'user_123',
        target: { kind: 'new' },
        state: {
          answers: { name: 'Saved name' },
          history: [],
          pendingQuestions: [],
        },
        status: 'active',
        attachments: null,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    authorize();
  });
  it.each([
    'image/png',
    'image/jpeg',
    'image/webp',
  ] as const)('decodes %s bytes, encrypts public bucket objects, and serves private bytes with detected MIME', async mime => {
    const data = bytes(mime);
    const { draft: saved } = await upload({}, data);
    const photo = saved.attachments.photos[0];
    expect(photo.contentType).toBe(mime);
    expect(saved.state.answers).toEqual({ name: 'Saved name' });
    expect(saved.attachments.primaryPhotoId).toBe(photo.id);
    expect([...bucket.values()][0]).not.toEqual(data);
    expect(put.mock.calls[0][2]).toMatchObject({
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    expect(JSON.stringify(saved)).not.toContain(
      records(schema.productAssets)[0].encryptionKey,
    );
    const response = await request(`/attachments/${photo.id}/image`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(mime);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
    authorize('another-admin');
    expect((await request(`/attachments/${photo.id}/image`)).status).toBe(404);
  });
  it('preserves primary independently of order, requires explicit choice after the second photo, and retains old replacement until success', async () => {
    const first = (await upload()).draft.attachments.photos[0];
    const second = (await upload()).draft.attachments.photos[1];
    expect(draft().attachments?.primaryPhotoId).toBeNull();
    const resumed = await (await request('')).json();
    expect(resumed.attachments.validation[0].code).toBe('primary_required');
    let response = await request('/attachments', 'PATCH', {
      expectedRevision: revision(),
      primaryPhotoId: first.id,
      photoOrder: [second.id, first.id],
    });
    expect(response.status).toBe(200);
    const replacement = await intent('photo', { replacesId: first.id });
    expect(draft().attachments?.photos[0].id).toBe(first.id);
    response = await app.request(
      replacement.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    expect(response.status).toBe(200);
    const replaced = await response.json();
    expect(replaced.draft.attachments.primaryPhotoId).toBe(
      replaced.draft.attachments.photos[0].id,
    );
    expect(replaced.draft.attachments.photoOrder[0]).toBe(second.id);
    expect(bucket.size).toBe(3);
    response = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect(response.status).toBe(200);
    expect(bucket.size).toBe(2);
  });
  it('rejects capacity, size, forged bodies, invalid ordering and stale revisions without dropping attachments', async () => {
    for (let i = 0; i < 5; i++) await upload();
    const before = structuredClone(draft());
    for (const body of [
      { kind: 'photo', name: 'sixth', size: 1 },
      { kind: 'photo', name: 'large', size: 5_000_001 },
      { kind: 'photo', name: 'replace', size: 1, replacesId: missing },
      { kind: 'photo', name: 'forged', size: 1, ownerId: 'forged' },
    ])
      expect(
        (
          await request('/attachments/intents', 'POST', {
            expectedRevision: revision(),
            ...body,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await request('/attachments', 'PATCH', {
          expectedRevision: 1,
          primaryPhotoId: missing,
        })
      ).status,
    ).toBe(409);
    for (const changes of [
      { primaryPhotoId: missing },
      { photoOrder: [] },
      { photoOrder: [missing] },
      {
        photoOrder: draft().attachments!.photos.map(
          () => draft().attachments!.photos[0].id,
        ),
      },
    ])
      expect(
        (
          await request('/attachments', 'PATCH', {
            expectedRevision: revision(),
            ...changes,
          })
        ).status,
      ).toBe(400);
    expect(draft()).toEqual(before);
    await upload({ replacesId: draft().attachments!.photos[0].id });
    expect(draft().attachments?.photos).toHaveLength(5);
  });
  it('restores incomplete transfer identity, rejects actual oversized/mismatched/forged image content and allows targeted reselection', async () => {
    const start = await intent();
    const transfer = draft().attachments!.transfers[0];
    const resumed = await (await request('')).json();
    expect(resumed.attachments.transfers[0]).toMatchObject({
      id: transfer.id,
      status: 'incomplete',
      requiresReselection: true,
    });
    for (const data of [
      new Uint8Array(5_000_001),
      new Uint8Array(1),
      new Uint8Array(bytes().length),
      new Uint8Array([
        ...bytes().slice(0, 12),
        ...new Uint8Array(bytes().length - 12),
      ]),
    ]) {
      const response = await request(
        `/attachments/transfers/${transfer.id}/content?expectedRevision=${revision()}`,
        'PUT',
        data,
      );
      expect(response.status).toBe(400);
    }
    expect(put).not.toHaveBeenCalled();
    const retry = await (
      await request(`/attachments/transfers/${transfer.id}/retry`, 'POST', {
        expectedRevision: revision(),
      })
    ).json();
    expect(retry.transfer.id).toBe(transfer.id);
    expect(retry.transfer.upload.url).toContain(
      `expectedRevision=${revision()}`,
    );
  });
  it('retains allocation identities before Slant calls and confirms the same file idempotently', async () => {
    const providerId = provider();
    const started = await intent('print');
    const transfer = draft().attachments!.transfers[0];
    expect(started.transfer.upload.url).toBe('https://upload.example.com/file');
    expect(records(schema.productAssets)[0].providerId).toBe(providerId);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            publicFileServiceId: providerId,
            fileURL: 'https://files.example.com/file',
            name: 'part.stl',
          },
        }),
      ),
    );
    const response = await request(
      `/attachments/transfers/${transfer.id}/confirm`,
      'POST',
      { expectedRevision: revision() },
    );
    expect(response.status).toBe(200);
    expect(draft().attachments?.printFile?.publicFileServiceId).toBe(
      providerId,
    );
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(
      (
        await request('/attachments/intents', 'POST', {
          expectedRevision: revision(),
          kind: 'print',
          size: 10,
          name: 'extra',
        })
      ).status,
    ).toBe(400);
    provider();
    await intent('print', { replacesId: transfer.attachmentId });
    expect(draft().attachments?.printFile?.publicFileServiceId).toBe(
      providerId,
    );
  });
  it('does not reallocate an unknown Slant outcome and protects unresolved cleanup', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection lost'));
    await intent('print');
    const transfer = draft().attachments!.transfers[0];
    expect(transfer.status).toBe('unresolved');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/attachments/${transfer.attachmentId}?expectedRevision=${revision()}`,
          'DELETE',
        )
      ).status,
    ).toBe(409);
    const discarded = await request(
      `?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect(discarded.status).toBe(200);
    expect((await discarded.json()).cleanup[0].status).toBe('protected');
    expect((await request('')).status).toBe(404);
    expect((await request('/cleanup')).status).toBe(200);
  });
  it.each([
    401, 403, 429, 503,
  ])('retains failed print deletion (%s) for retry without losing other attachments or answers', async status => {
    const photo = (await upload()).draft.attachments.photos[0];
    const print = await savedPrint();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        { success: false, message: 'Provider rejected deletion' },
        { status },
      ),
    );
    const response = await request(
      `/attachments/${print.assetId}?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect(response.status).toBe(200);
    expect((await response.json()).draft.attachments.cleanup[0]).toMatchObject({
      status: 'pending',
      reason: 'Slant3D file cleanup failed; retry cleanup',
    });
    expect(
      records(schema.productAssets).find(asset => asset.id === print.assetId)
        ?.status,
    ).toBe('deleting');
    expect(draft().state.answers).toEqual({ name: 'Saved name' });
    expect(draft().attachments!.photos[0]).toEqual(photo);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: true, message: 'File deleted' }),
    );
    const retried = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await retried.json()).cleanup[0].status).toBe('deleted');
    const calls = vi.mocked(fetch).mock.calls.length;
    await request('/cleanup/retry', 'POST', { expectedRevision: revision() });
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(remove).not.toHaveBeenCalled();
  });
  it('reconciles a lost deletion response with a confirmed missing file', async () => {
    const print = await savedPrint();
    vi.mocked(fetch).mockRejectedValueOnce(
      new Error('Response lost after deletion'),
    );
    const response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect((await response.json()).cleanup[0].status).toBe('pending');
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json(
          { success: false, message: 'File not found' },
          { status: 404 },
        ),
      );
    const retry = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await retry.json()).cleanup[0].status).toBe('deleted');
    expect(fetch).toHaveBeenLastCalledWith(
      `https://slant3dapi.com/v2/api/files/${print.providerId}`,
      {
        method: 'GET',
        headers: { Authorization: 'Bearer fake-api-key-v2' },
      },
    );
  });
  it('keeps a successful provider deletion pending if saving its result fails and retries safely', async () => {
    const print = await savedPrint();
    beforeUpdate = (table, changes) => {
      if (table === schema.productAssets && changes.status === 'deleted') {
        beforeUpdate = undefined;
        throw new Error('Persistence unavailable');
      }
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: true, message: 'File deleted' }),
    );
    const response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect((await response.json()).cleanup[0].status).toBe('pending');
    expect(records(schema.productAssets)[0]).toMatchObject({
      id: print.assetId,
      status: 'deleting',
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(Response.json({}, { status: 404 }));
    const retry = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await retry.json()).cleanup[0].status).toBe('deleted');
  });
  it('protects print files referenced by catalog items, orders and retained drafts', async () => {
    const print = await savedPrint();
    vi.mocked(fetch).mockClear();
    tables.set(schema.productsTable, [
      { id: 42, publicFileServiceId: print.providerId },
    ]);
    let response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect((await response.json()).cleanup[0].status).toBe('protected');
    tables.set(schema.productsTable, []);
    tables.set(schema.ordersTable, [
      { id: 1, fileUrl: `https://files.example.com/${print.providerId}` },
    ]);
    response = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await response.json()).cleanup[0].status).toBe('protected');
    tables.set(schema.ordersTable, []);
    tables.get(schema.productDrafts)!.push({
      ...structuredClone(draft()),
      id: missing,
      status: 'active',
      attachments: { printFile: { publicFileServiceId: print.providerId } },
    });
    response = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await response.json()).cleanup[0].status).toBe('protected');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('claims print deletion before provider access and refuses racing reference creation', async () => {
    const print = await savedPrint();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      expect(records(schema.productAssets)[0].status).toBe('deleting');
      const reserve = await app.request(
        '/update-product',
        {
          method: 'PUT',
          headers: {
            cookie: 'session=yes',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ image: `product-drafts/${print.assetId}` }),
        },
        env,
      );
      expect(reserve.status).toBe(409);
      return Response.json({ success: true, message: 'File deleted' });
    });
    const response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect((await response.json()).cleanup[0].status).toBe('deleted');
  });
  it('does not call Slant when a reference wins the deletion claim', async () => {
    await savedPrint();
    vi.mocked(fetch).mockClear();
    beforeUpdate = (table, changes) => {
      if (table === schema.productAssets && changes.status === 'deleting') {
        beforeUpdate = undefined;
        const asset = records(schema.productAssets)[0];
        asset.references = ['order-attempt:concurrent'];
        asset.revision = Number(asset.revision) + 1;
      }
    };
    const response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect(response.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    const retry = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await retry.json()).cleanup[0].status).toBe('protected');
  });
  it('keeps a print asset with a missing provider identity pending without guessing an identifier', async () => {
    await savedPrint();
    records(schema.productAssets)[0].providerId = null;
    vi.mocked(fetch).mockClear();
    const response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect((await response.json()).cleanup[0]).toMatchObject({
      status: 'pending',
      reason: 'File storage identity is not available; retry cleanup',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('deletes only the replaced print after the replacement saves', async () => {
    const first = await savedPrint();
    const nextId = provider();
    await intent('print', { replacesId: first.assetId });
    const transfer = draft().attachments!.transfers.at(-1)!;
    expect(draft().attachments!.printFile!.publicFileServiceId).toBe(
      first.providerId,
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([, options]) => options?.method === 'DELETE'),
    ).toBe(false);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          data: {
            publicFileServiceId: nextId,
            fileURL: `https://files.example.com/${nextId}`,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ success: true, message: 'File deleted' }),
      );
    const response = await request(
      `/attachments/transfers/${transfer.id}/confirm`,
      'POST',
      { expectedRevision: revision() },
    );
    expect(response.status).toBe(200);
    expect(draft().attachments!.printFile!.publicFileServiceId).toBe(nextId);
    await request('/cleanup/retry', 'POST', { expectedRevision: revision() });
    expect(fetch).toHaveBeenLastCalledWith(
      `https://slant3dapi.com/v2/api/files/${first.providerId}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer fake-api-key-v2' },
      },
    );
    expect(draft().attachments!.cleanup[0].status).toBe('deleted');
  });
  it('discards saved draft-only photos and leaves a discoverable retryable cleanup tombstone', async () => {
    await upload();
    remove.mockRejectedValueOnce(new Error('R2 unavailable'));
    let response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect(response.status).toBe(200);
    expect((await response.json()).cleanup[0].status).toBe('pending');
    expect(draft().state.answers).toEqual({});
    response = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).cleanup[0].status).toBe('deleted');
    expect(bucket.size).toBe(0);
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    const list = await app.request(
      '/admin/product-drafts',
      { headers: { cookie: 'session=yes' } },
      env,
    );
    expect((await list.json()).drafts[0]).toMatchObject({
      status: 'discarded',
      cleanupPending: false,
    });
  });
  it('preserves catalog/order/other draft references and prevents reference creation after a cleanup claim', async () => {
    const photo = (await upload()).draft.attachments.photos[0];
    tables.set(schema.productsTable, [{ id: 42, image: photo.imageUrl }]);
    let response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect((await response.json()).cleanup[0].status).toBe('protected');
    expect(remove).not.toHaveBeenCalled();
    tables.set(schema.productsTable, []);
    tables.set(schema.ordersTable, [{ id: 1, itemSnapshot: photo.imageUrl }]);
    response = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await response.json()).cleanup[0].status).toBe('protected');
    tables.set(schema.ordersTable, []);
    tables.get(schema.productDrafts)!.push({
      ...structuredClone(draft()),
      id: missing,
      status: 'active',
      attachments: { photos: [photo] },
    });
    response = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await response.json()).cleanup[0].status).toBe('protected');
    tables.get(schema.productDrafts)!.pop();
    remove.mockRejectedValueOnce(new Error('Interrupted delete'));
    await request('/cleanup/retry', 'POST', { expectedRevision: revision() });
    const reserve = await app.request(
      '/update-product',
      {
        method: 'PUT',
        headers: { cookie: 'session=yes', 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: photo.imageUrl }),
      },
      env,
    );
    expect(reserve.status).toBe(409);
    expect(records(schema.productAssets)[0].status).toBe('deleting');
  });
  it('checks role, owner, malformed ids and missing attachments without provider access', async () => {
    mockBetterAuth.getSession.mockResolvedValueOnce(null);
    expect((await request('/attachments/intents', 'POST', {})).status).toBe(
      401,
    );
    authorize('user_123', 'member');
    expect((await request('/cleanup')).status).toBe(403);
    authorize('other');
    expect((await request('/cleanup')).status).toBe(404);
    authorize();
    expect((await request('/attachments/not-uuid/image')).status).toBe(400);
    expect((await request(`/attachments/${missing}/image`)).status).toBe(404);
    expect(
      (
        await request(
          `/attachments/${missing}?expectedRevision=${revision()}`,
          'DELETE',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/attachments/transfers/${missing}/retry`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('persists failed validation, accepts the exact 5MB boundary, and rejects empty bodies', async () => {
    const data = new Uint8Array(5_000_000);
    data.set(bytes());
    await upload({}, data);
    const start = await intent();
    const transfer = draft().attachments!.transfers[1];
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(400);
    expect(draft().attachments!.transfers[1]).toMatchObject({
      status: 'failed',
      requiresReselection: true,
    });
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(409);
    const riff = new Uint8Array(bytes().length);
    riff.set(new TextEncoder().encode('RIFFbadformat'));
    expect(
      (
        await request(
          `/attachments/transfers/${transfer.id}/content?expectedRevision=${revision()}`,
          'PUT',
          riff,
        )
      ).status,
    ).toBe(400);
  });
  it('recovers unknown photo outcomes and requests only the missing photo again', async () => {
    const start = await intent();
    const transfer = draft().attachments!.transfers[0];
    put.mockRejectedValueOnce(new Error('Unknown write'));
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(draft().attachments!.transfers[0].status).toBe('unresolved');
    expect(
      (
        await request(
          `/attachments/transfers/${transfer.id}/content?expectedRevision=${revision()}`,
          'PUT',
          bytes(),
        )
      ).status,
    ).toBe(409);
    let response = await request(
      `/attachments/transfers/${transfer.id}/retry`,
      'POST',
      { expectedRevision: revision() },
    );
    expect(response.status).toBe(200);
    expect(draft().attachments!.transfers[0].status).toBe('pending');
    const retry = await response.json();
    put.mockImplementationOnce(async (key, data) => {
      bucket.set(key, data.slice());
      throw new Error('Lost acknowledgment');
    });
    response = await app.request(
      retry.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    expect(response.status).toBe(200);
    response = await request(
      `/attachments/transfers/${transfer.id}/confirm`,
      'POST',
      { expectedRevision: revision() },
    );
    expect(response.status).toBe(200);
    expect(draft().attachments!.photos).toHaveLength(1);
  });
  it('never overwrites a colliding R2 object and retains unresolved recovery', async () => {
    const start = await intent();
    const transfer = draft().attachments!.transfers[0];
    const key = `product-drafts/${transfer.attachmentId}`;
    bucket.set(key, new Uint8Array([1, 2, 3]));
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(bucket.get(key)).toEqual(new Uint8Array([1, 2, 3]));
    expect(draft().attachments!.transfers[0].status).toBe('unresolved');
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(500);
  });
  it('does not finalize an upload into a discarded draft and later safely cleans it', async () => {
    const start = await intent();
    put.mockImplementationOnce(async (key, data) => {
      const response = await request(
        `?expectedRevision=${revision()}`,
        'DELETE',
      );
      expect(response.status).toBe(200);
      expect((await response.json()).cleanup[0].status).toBe('protected');
      bucket.set(key, data.slice());
      return { key };
    });
    const response = await app.request(
      start.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    expect(response.status).toBe(200);
    expect(draft().status).toBe('discarded');
    expect(draft().attachments!.photos).toEqual([]);
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(bucket.size).toBe(0);
    expect(
      (await request(`?expectedRevision=${revision()}`, 'DELETE')).status,
    ).toBe(200);
  });
  it('keeps saved answers changed during upload completion', async () => {
    const start = await intent();
    put.mockImplementationOnce(async (key, data) => {
      draft().state.answers.name = 'Concurrent saved correction';
      draft().revision++;
      bucket.set(key, data.slice());
      return { key };
    });
    const response = await app.request(
      start.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).draft.state.answers.name).toBe(
      'Concurrent saved correction',
    );
  });
  it('retries print confirmation without reallocating and deletes the confirmed file on removal', async () => {
    const providerId = provider();
    await intent('print');
    const transfer = draft().attachments!.transfers[0];
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Unknown confirmation'));
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(draft().attachments!.transfers[0].status).toBe('unresolved');
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            publicFileServiceId: missing,
            fileURL: 'https://wrong.example.com',
          },
        }),
      ),
    );
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(draft().attachments!.printFile).toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            publicFileServiceId: providerId,
            fileURL: 'https://files.example.com/part',
          },
        }),
      ),
    );
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(draft().attachments!.printFile).not.toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: true, message: 'File deleted' }),
    );
    const removed = await request(
      `/attachments/${transfer.attachmentId}?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).draft.attachments.cleanup[0]).toMatchObject({
      status: 'deleted',
      reason: null,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      `https://slant3dapi.com/v2/api/files/${providerId}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer fake-api-key-v2' },
      },
    );
    expect(draft().attachments!.printFile).toBeNull();
    expect(draft().state.answers).toEqual({ name: 'Saved name' });
  });
  it('removes saved photos and abandoned intents without selecting a new primary from several photos', async () => {
    const first = (await upload()).draft.attachments.photos[0];
    await upload();
    await upload();
    await request('/attachments', 'PATCH', {
      expectedRevision: revision(),
      primaryPhotoId: first.id,
    });
    let response = await request(
      `/attachments/${first.id}?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect(response.status).toBe(200);
    expect((await response.json()).draft.attachments.primaryPhotoId).toBeNull();
    const second = draft().attachments!.photos[0].id;
    await request('/attachments', 'PATCH', {
      expectedRevision: revision(),
      primaryPhotoId: second,
    });
    response = await request(
      `/attachments/${second}?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect(response.status).toBe(200);
    expect(draft().attachments!.primaryPhotoId).toBe(
      draft().attachments!.photos[0].id,
    );
    await intent();
    const pending = draft().attachments!.transfers.at(-1)!;
    response = await request(
      `/attachments/${pending.attachmentId}?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect(response.status).toBe(200);
    expect(
      draft().attachments!.transfers.some(item => item.id === pending.id),
    ).toBe(false);
    await request('/attachments', 'PATCH', {
      expectedRevision: revision(),
      primaryPhotoId: null,
    });
    expect(
      (
        await request('/attachments', 'PATCH', {
          expectedRevision: revision(),
          photoOrder: draft().attachments!.photoOrder,
        })
      ).status,
    ).toBe(200);
  });
  it('blocks duplicate replacement and removal of a slot with an in-progress replacement', async () => {
    const first = (await upload()).draft.attachments.photos[0];
    await intent('photo', { replacesId: first.id });
    expect(
      (
        await request('/attachments/intents', 'POST', {
          expectedRevision: revision(),
          kind: 'photo',
          name: 'another',
          size: 1,
          replacesId: first.id,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/attachments/${first.id}?expectedRevision=${revision()}`,
          'DELETE',
        )
      ).status,
    ).toBe(409);
    const photo = draft().attachments!.photos[0];
    bucket.clear();
    expect((await request(`/attachments/${photo.id}/image`)).status).toBe(404);
  });
  it('handles persistence conflicts and unavailable reads without pretending a successful transfer', async () => {
    rejectUpdate = true;
    expect(
      (
        await request('/attachments/intents', 'POST', {
          expectedRevision: revision(),
          kind: 'photo',
          name: 'a',
          size: 1,
        })
      ).status,
    ).toBe(409);
    failRead = schema.productDrafts;
    expect((await request('/cleanup')).status).toBe(500);
    failRead = undefined;
    await upload();
    tables.set(schema.productAssets, []);
    expect(
      (await request(`/attachments/${draft().attachments!.photos[0].id}/image`))
        .status,
    ).toBe(404);
    const response = await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect(response.status).toBe(200);
    expect((await response.json()).cleanup[0].status).toBe('pending');
  });
  it('keeps a durable intent when registry insertion is interrupted and retries the same identity', async () => {
    db.insert.mockImplementationOnce(() => {
      throw new Error('Registry unavailable');
    });
    expect(
      (
        await request('/attachments/intents', 'POST', {
          expectedRevision: revision(),
          kind: 'photo',
          name: 'photo',
          size: bytes().length,
        })
      ).status,
    ).toBe(500);
    const transfer = draft().attachments!.transfers[0];
    expect(transfer.phase).toBe('intent');
    const response = await request(
      `/attachments/transfers/${transfer.id}/retry`,
      'POST',
      { expectedRevision: revision() },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).transfer.id).toBe(transfer.id);
  });
  it('reserves catalog references before writes, preserves ambiguous reservations, and guards claim races', async () => {
    const photo = (await upload()).draft.attachments.photos[0];
    const catalogRequest = () =>
      app.request(
        '/update-product',
        {
          method: 'PUT',
          headers: {
            cookie: 'session=yes',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ image: photo.imageUrl }),
        },
        env,
      );
    expect((await catalogRequest()).status).toBe(400);
    expect(records(schema.productAssets)[0].references).toEqual([
      `draft:${id}`,
    ]);
    expect((await catalogRequest()).status).toBe(400);
    failRead = schema.productsTable;
    const unknown = await app.request(
      '/update-product',
      {
        method: 'PUT',
        headers: { cookie: 'session=yes', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 42,
          name: 'part',
          description: '',
          price: 1,
          filamentType: 'PLA',
          color: '',
          image: photo.imageUrl,
        }),
      },
      env,
    );
    expect(unknown.status).toBe(500);
    failRead = undefined;
    expect(records(schema.productAssets)[0].references).toEqual(
      expect.arrayContaining([expect.stringMatching(/^catalog-attempt:/)]),
    );
    const protectedReferences = structuredClone(
      records(schema.productAssets)[0].references,
    );
    expect((await catalogRequest()).status).toBe(400);
    expect(records(schema.productAssets)[0].references).toEqual(
      protectedReferences,
    );
    expect(
      (await request(`?expectedRevision=${revision()}`, 'DELETE')).status,
    ).toBe(200);
    expect(remove).not.toHaveBeenCalled();
    records(schema.productAssets)[0].references = [];
    beforeUpdate = (table, changes) => {
      if (table === schema.productAssets && changes.status === 'deleting') {
        records(schema.productAssets)[0].revision =
          Number(records(schema.productAssets)[0].revision) + 1;
        records(schema.productAssets)[0].references = ['order:concurrent'];
      }
    };
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(409);
    expect(remove).not.toHaveBeenCalled();
  });
  it('bounds JSON and preserves structured errors for middleware failures', async () => {
    const preflight = await app.request(
      `/admin/product-drafts/${id}/attachments`,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://luluspeedworks.com',
          'Access-Control-Request-Method': 'PATCH',
        },
      },
      env,
    );
    expect(preflight.headers.get('access-control-allow-methods')).toContain(
      'PATCH',
    );
    expect((await request('/cleanup')).status).toBe(200);
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    draft().attachments = null;
    expect(
      (
        await request('/attachments', 'PATCH', {
          expectedRevision: revision(),
          photoOrder: [],
        })
      ).status,
    ).toBe(200);
    const huge = { expectedRevision: revision(), text: 'x'.repeat(270_000) };
    expect((await request('/attachments/intents', 'POST', huge)).status).toBe(
      400,
    );
    expect((await request('', 'PUT', huge)).status).toBe(400);
    failRead = schema.memberTable;
    failReadError = new HTTPException(418);
    expect((await request('/cleanup')).status).toBe(500);
  });
  it.each([
    'missing',
    'draftId',
    'ownerId',
    'objectKey',
    'references',
  ])('rejects an asset registry identity collision: %s', async field => {
    const original = db.insert.getMockImplementation()!;
    db.insert.mockImplementationOnce(table => ({
      values: value => {
        const statement = original(table).values(value);
        return {
          ...statement,
          onConflictDoNothing: async () => {
            await statement.onConflictDoNothing();
            if (field === 'missing') tables.set(schema.productAssets, []);
            else
              records(schema.productAssets)[0][field] =
                field === 'references' ? [] : 'other';
          },
        };
      },
    }));
    expect(
      (
        await request('/attachments/intents', 'POST', {
          expectedRevision: revision(),
          kind: 'photo',
          name: 'photo',
          size: bytes().length,
        })
      ).status,
    ).toBe(409);
    expect(put).not.toHaveBeenCalled();
  });
  it('keeps provider identity when registry persistence disappears after print allocation', async () => {
    const result = {
      data: {
        presignedUrl: 'https://upload.example.com',
        key: 'key',
        filePlaceholder: {
          publicFileServiceId: missing,
          name: 'a',
          ownerId: 'user_123',
          platformId: 'platform',
          type: 'stl',
          createdAt: '',
          updatedAt: '',
        },
      },
    };
    vi.mocked(fetch).mockImplementationOnce(async () => {
      tables.set(schema.productAssets, []);
      return new Response(JSON.stringify(result));
    });
    const started = await intent('print');
    expect(started.transfer.upload).toBeNull();
    expect(draft().attachments!.transfers[0]).toMatchObject({
      status: 'unresolved',
      phase: 'confirming',
      placeholder: { publicFileServiceId: missing },
    });
  });
  it('retains photo recovery after missing asset metadata and detects mismatched stored byte identity', async () => {
    const start = await intent();
    const transfer = draft().attachments!.transfers[0];
    const asset = structuredClone(records(schema.productAssets)[0]);
    put.mockImplementationOnce(async (key, data) => {
      bucket.set(key, data.slice());
      tables.set(schema.productAssets, []);
      return { key };
    });
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(500);
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(409);
    tables.set(schema.productAssets, [asset]);
    draft().attachments!.transfers[0].size++;
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(409);
  });
  it('preserves references acquired while upload completes after discard', async () => {
    const start = await intent();
    put.mockImplementationOnce(async (key, data) => {
      (records(schema.productAssets)[0].references as string[]).push(
        'unresolved:catalog',
      );
      await request(`?expectedRevision=${revision()}`, 'DELETE');
      bucket.set(key, data.slice());
      return { key };
    });
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(records(schema.productAssets)[0].references).toEqual([
      'unresolved:catalog',
    ]);
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(remove).not.toHaveBeenCalled();
  });
  it('leaves missing prior asset cleanup pending after successful replacement and removal', async () => {
    const first = (await upload()).draft.attachments.photos[0];
    tables.set(schema.productAssets, []);
    await upload({ replacesId: first.id });
    expect(draft().attachments!.cleanup[0].assetId).toBe(first.id);
    tables.set(schema.productAssets, []);
    expect(
      (
        await request(
          `/attachments/${draft().attachments!.photos[0].id}?expectedRevision=${revision()}`,
          'DELETE',
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(`?expectedRevision=${revision()}`, 'DELETE')).status,
    ).toBe(200);
    expect(draft().attachments!.cleanup).toHaveLength(2);
  });
  it('counts pending slots and deletes saved print files on discard', async () => {
    await intent();
    await intent();
    const providerId = provider();
    await intent('print');
    const transfer = draft().attachments!.transfers[2];
    expect(
      (
        await request('/attachments/intents', 'POST', {
          expectedRevision: revision(),
          kind: 'print',
          size: 1,
          name: 'extra',
        })
      ).status,
    ).toBe(400);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            publicFileServiceId: providerId,
            fileURL: 'https://files.example.com/part',
          },
        }),
      ),
    );
    await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
      expectedRevision: revision(),
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: true, message: 'File deleted' }),
    );
    expect(
      (await request(`?expectedRevision=${revision()}`, 'DELETE')).status,
    ).toBe(200);
    expect(
      draft().attachments!.cleanup.find(
        item => item.assetId === transfer.attachmentId,
      )?.status,
    ).toBe('deleted');
    expect(fetch).toHaveBeenLastCalledWith(
      `https://slant3dapi.com/v2/api/files/${providerId}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer fake-api-key-v2' },
      },
    );
  });
  it('handles catalog requests without private references, unmatched references, object keys and malformed JSON', async () => {
    const photo = (await upload()).draft.attachments.photos[0];
    const printId = provider();
    await intent('print');
    for (const value of [
      'plain-public-url',
      'product-drafts/not-an-asset',
      `product-drafts/${photo.id}`,
      `/attachments/${printId}`,
    ]) {
      const response = await app.request(
        '/update-product',
        {
          method: 'PUT',
          headers: {
            cookie: 'session=yes',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ image: value }),
        },
        env,
      );
      expect(response.status).toBe(400);
    }
    const malformed = await app.request(
      '/update-product',
      {
        method: 'PUT',
        headers: { cookie: 'session=yes', 'Content-Type': 'application/json' },
        body: '{',
      },
      env,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: 'Could not reserve attachment references',
    });
  });
  it('does not convert request-stream failures into successful uploads', async () => {
    const start = await intent();
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error('Disconnected'));
      },
    });
    const response = await app.request(
      start.transfer.upload.url,
      {
        method: 'PUT',
        body: stream,
        headers: { cookie: 'session=yes' },
        duplex: 'half',
      } as RequestInit,
      env,
    );
    expect(response.status).toBe(500);
    expect(put).not.toHaveBeenCalled();
  });
  it('retains cleanup candidates added by another mutation while a deletion is running', async () => {
    const photo = (await upload()).draft.attachments.photos[0];
    remove.mockImplementationOnce(async key => {
      draft().attachments!.cleanup.push({
        id: missing,
        assetId: missing,
        status: 'pending',
        reason: null,
      });
      draft().revision++;
      bucket.delete(key);
    });
    expect(
      (
        await request(
          `/attachments/${photo.id}?expectedRevision=${revision()}`,
          'DELETE',
        )
      ).status,
    ).toBe(200);
    expect(draft().attachments!.cleanup).toEqual(
      expect.arrayContaining([
        { id: missing, assetId: missing, status: 'pending', reason: null },
      ]),
    );
  });
  it.each([
    false,
    true,
  ])('finalizes a concurrent confirm and original PUT exactly once (replacement=%s)', async replacing => {
    const old = replacing ? (await upload()).draft.attachments.photos[0] : null;
    const start = await intent('photo', old ? { replacesId: old.id } : {});
    const transfer = draft().attachments!.transfers.at(-1)!;
    put.mockImplementationOnce(async (key, data) => {
      bucket.set(key, data.slice());
      expect(
        (
          await request(
            `/attachments/transfers/${transfer.id}/confirm`,
            'POST',
            { expectedRevision: revision() },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request('/attachments', 'PATCH', {
            expectedRevision: revision(),
            photoOrder: [transfer.attachmentId],
            primaryPhotoId: transfer.attachmentId,
          })
        ).status,
      ).toBe(200);
      draft().state.answers.name = 'Changed after confirmation';
      draft().revision++;
      return { key };
    });
    const response = await app.request(
      start.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    expect(response.status).toBe(200);
    expect(draft().attachments!.photos.map(photo => photo.id)).toEqual([
      transfer.attachmentId,
    ]);
    expect(draft().attachments!.photoOrder).toEqual([transfer.attachmentId]);
    expect(draft().state.answers.name).toBe('Changed after confirmation');
  });
  it('fences a deferred PUT after missing-object recovery and removal of its new generation', async () => {
    const start = await intent();
    const original = structuredClone(draft().attachments!.transfers[0]);
    put.mockImplementationOnce(async (key, data) => {
      const recovered = await request(
        `/attachments/transfers/${original.id}/confirm`,
        'POST',
        { expectedRevision: revision() },
      );
      expect(recovered.status).toBe(200);
      const replacement = draft().attachments!.transfers[0];
      expect(replacement.attachmentId).not.toBe(original.attachmentId);
      expect(records(schema.productAssets)[0].references as string[]).toContain(
        `transfer:${original.id}`,
      );
      expect(
        (
          await request(
            `/attachments/${replacement.attachmentId}?expectedRevision=${revision()}`,
            'DELETE',
          )
        ).status,
      ).toBe(200);
      expect(records(schema.productAssets)[0].status).toBe('active');
      bucket.set(key, data.slice());
      return { key };
    });
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(draft().attachments!.photos).toEqual([]);
    expect(draft().attachments!.transfers).toEqual([]);
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(bucket.size).toBe(0);
  });
  it('can reconcile an abandoned immutable upload if its bytes appear after the original request is lost', async () => {
    const start = await intent();
    const original = structuredClone(draft().attachments!.transfers[0]);
    let lateBytes: Uint8Array;
    put.mockImplementationOnce(async (_key, data) => {
      lateBytes = data.slice();
      throw new Error('Write may complete later');
    });
    await app.request(
      start.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    await request(`/attachments/transfers/${original.id}/confirm`, 'POST', {
      expectedRevision: revision(),
    });
    const currentId = draft().attachments!.transfers[0].attachmentId;
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(remove).not.toHaveBeenCalled();
    bucket.set(`product-drafts/${original.attachmentId}`, lateBytes!);
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(bucket.size).toBe(0);
    expect(draft().attachments!.transfers[0].attachmentId).toBe(currentId);
    expect(draft().attachments!.photos).toEqual([]);
  });
  it('ignores a late failed PUT response after its generation was replaced', async () => {
    const start = await intent();
    const original = structuredClone(draft().attachments!.transfers[0]);
    put.mockImplementationOnce(async () => {
      await request(`/attachments/transfers/${original.id}/confirm`, 'POST', {
        expectedRevision: revision(),
      });
      throw new Error('Late failure');
    });
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(draft().attachments!.transfers[0]).toMatchObject({
      status: 'incomplete',
      phase: 'intent',
    });
    expect(draft().attachments!.transfers[0].attachmentId).not.toBe(
      original.attachmentId,
    );
  });
  it('deduplicates two confirms that read the same stored photo before either returns', async () => {
    const start = await intent();
    const transfer = draft().attachments!.transfers[0];
    put.mockImplementationOnce(async (key, data) => {
      bucket.set(key, data.slice());
      throw new Error('Lost acknowledgment');
    });
    await app.request(
      start.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    get.mockImplementationOnce(async key => {
      const stored = bucket.get(key)!;
      expect(
        (
          await request(
            `/attachments/transfers/${transfer.id}/confirm`,
            'POST',
            { expectedRevision: revision() },
          )
        ).status,
      ).toBe(200);
      return { arrayBuffer: async () => stored.slice().buffer };
    });
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(draft().attachments!.photos).toHaveLength(1);
    expect(draft().attachments!.photoOrder).toHaveLength(1);
  });
  it.each([
    'claim',
    'phase',
  ])('rejects late finalization after an invalid %s transition', async transition => {
    const start = await intent();
    put.mockImplementationOnce(async (key, data) => {
      bucket.set(key, data.slice());
      if (transition === 'claim')
        records(schema.productAssets)[0].status = 'deleting';
      else draft().attachments!.transfers[0].phase = 'intent';
      return { key };
    });
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(409);
    expect(draft().attachments!.photos).toEqual([]);
  });
  it('keeps in-flight protection on a discarded draft when recovery still finds no bytes', async () => {
    const start = await intent();
    const transfer = draft().attachments!.transfers[0];
    put.mockImplementationOnce(async (key, data) => {
      await request(`?expectedRevision=${revision()}`, 'DELETE');
      expect(
        (
          await request(
            `/attachments/transfers/${transfer.id}/confirm`,
            'POST',
            { expectedRevision: revision() },
          )
        ).status,
      ).toBe(200);
      expect(draft().attachments!.transfers[0].attachmentId).toBe(
        transfer.attachmentId,
      );
      expect(draft().attachments!.transfers[0].status).toBe('unresolved');
      bucket.set(key, data.slice());
      return { key };
    });
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(draft().attachments!.photos).toEqual([]);
  });
  it('validates abandoned generation bytes and preserves unrelated transfers when rotating', async () => {
    await upload();
    const start = await intent();
    const original = structuredClone(draft().attachments!.transfers[1]);
    let lateBytes: Uint8Array;
    put.mockImplementationOnce(async (_key, data) => {
      lateBytes = data.slice();
      throw new Error('Late write');
    });
    await app.request(
      start.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    await request(`/attachments/transfers/${original.id}/confirm`, 'POST', {
      expectedRevision: revision(),
    });
    expect(draft().attachments!.transfers[0].status).toBe('saved');
    bucket.set(`product-drafts/${original.attachmentId}`, lateBytes!);
    draft().attachments!.abandonedTransfers![0].size++;
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(409);
    expect(remove).not.toHaveBeenCalled();
    draft().attachments!.abandonedTransfers![0].size--;
    expect(
      (
        await request('/cleanup/retry', 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(draft().attachments!.photos).toHaveLength(1);
  });
  it('does not modify an asset record that disappeared before known-rejection reservation release', async () => {
    const photo = (await upload()).draft.attachments.photos[0];
    let reads = 0;
    beforeRead = table => {
      if (table === schema.productAssets && ++reads === 2)
        tables.set(schema.productAssets, []);
    };
    const response = await app.request(
      '/update-product',
      {
        method: 'PUT',
        headers: { cookie: 'session=yes', 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: photo.imageUrl }),
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(records(schema.productAssets)).toEqual([]);
  });
  it('recovers a stored unresolved photo from only the discarded cleanup surface after reload', async () => {
    const start = await intent();
    put.mockImplementationOnce(async (key, data) => {
      bucket.set(key, data.slice());
      throw new Error('Invocation lost after storage');
    });
    expect(
      (
        await app.request(
          start.transfer.upload.url,
          { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
          env,
        )
      ).status,
    ).toBe(200);
    expect(draft().attachments!.transfers[0].status).toBe('unresolved');
    get.mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
    const discarded = await request(
      `?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect(discarded.status).toBe(200);
    expect((await discarded.json()).cleanup[0].status).toBe('protected');
    expect((await request('')).status).toBe(404);
    const persisted = await (await request('/cleanup')).json();
    const retried = await request('/cleanup/retry', 'POST', {
      expectedRevision: persisted.revision,
    });
    expect(retried.status).toBe(200);
    expect((await retried.json()).cleanup[0].status).toBe('deleted');
    expect(bucket.size).toBe(0);
    expect(draft().attachments!.photos).toEqual([]);
    expect(draft().attachments!.transfers[0].status).toBe('saved');
  });
  it('keeps unobserved discarded uploads protected across cleanup retries', async () => {
    const start = await intent();
    put.mockRejectedValueOnce(new Error('Unknown write outcome'));
    await app.request(
      start.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    await request(`?expectedRevision=${revision()}`, 'DELETE');
    const identity = draft().attachments!.transfers[0].attachmentId;
    const recovered = await (await request('/cleanup')).json();
    const response = await request('/cleanup/retry', 'POST', {
      expectedRevision: recovered.revision,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).cleanup[0].status).toBe('protected');
    expect(remove).not.toHaveBeenCalled();
    expect(draft().attachments!.transfers[0].attachmentId).toBe(identity);
    expect(draft().attachments!.transfers[0].status).toBe('unresolved');
  });
  it('recovers and deletes a known unresolved print placeholder after discard', async () => {
    const providerId = provider();
    await intent('print');
    const transfer = draft().attachments!.transfers[0];
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Confirmation unknown'));
    await request(`/attachments/transfers/${transfer.id}/confirm`, 'POST', {
      expectedRevision: revision(),
    });
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Still unavailable'));
    await request(`?expectedRevision=${revision()}`, 'DELETE');
    expect(draft().attachments!.transfers[0].status).toBe('unresolved');
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            publicFileServiceId: providerId,
            fileURL: 'https://files.example.com/part',
          },
        }),
      ),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: true, message: 'File deleted' }),
    );
    const response = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).cleanup[0]).toMatchObject({
      status: 'deleted',
      reason: null,
    });
    expect(draft().attachments!.printFile).toBeNull();
    expect(draft().attachments!.transfers[0].status).toBe('saved');
  });
  it('normalizes the sole surviving photo to primary when no explicit choice existed', async () => {
    const first = (await upload()).draft.attachments.photos[0];
    const second = (await upload()).draft.attachments.photos[1];
    expect(draft().attachments!.primaryPhotoId).toBeNull();
    await request('/attachments', 'PATCH', {
      expectedRevision: revision(),
      photoOrder: [second.id, first.id],
    });
    const response = await request(
      `/attachments/${first.id}?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect(response.status).toBe(200);
    expect(draft().attachments!).toMatchObject({
      primaryPhotoId: second.id,
      primaryExplicit: false,
      photoOrder: [second.id],
    });
    await request('/attachments', 'PATCH', {
      expectedRevision: revision(),
      primaryPhotoId: null,
    });
    expect(draft().attachments!.primaryPhotoId).toBe(second.id);
    const added = await upload();
    expect(added.draft.attachments.primaryPhotoId).toBeNull();
    expect(added.draft.attachments.validation[0].code).toBe('primary_required');
  });
  it('recovers a removed intent after interruption before its asset references were released', async () => {
    await intent();
    const transfer = draft().attachments!.transfers[0];
    beforeRead = table => {
      if (
        table === schema.productAssets &&
        draft().attachments!.transfers.length === 0
      ) {
        beforeRead = undefined;
        throw new Error('Invocation interrupted');
      }
    };
    expect(
      (
        await request(
          `/attachments/${transfer.attachmentId}?expectedRevision=${revision()}`,
          'DELETE',
        )
      ).status,
    ).toBe(500);
    expect(draft().attachments!.abandonedTransfers![0].id).toBe(transfer.id);
    expect(records(schema.productAssets)[0].references).toContain(
      `transfer:${transfer.id}`,
    );
    const response = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).cleanup[0].status).toBe('deleted');
    expect(records(schema.productAssets)[0].references).toEqual([]);
  });
  it('allows explicit print reselection after premature confirmation and reconciles the abandoned placeholder', async () => {
    await upload();
    const oldProvider = provider();
    await intent('print');
    const old = draft().attachments!.transfers[1];
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Bytes not uploaded'));
    await request(`/attachments/transfers/${old.id}/confirm`, 'POST', {
      expectedRevision: revision(),
    });
    const nextProvider = provider();
    const retried = await request(
      `/attachments/transfers/${old.id}/retry`,
      'POST',
      { expectedRevision: revision() },
    );
    expect(retried.status).toBe(200);
    expect((await retried.json()).transfer.upload).not.toBeNull();
    const current = draft().attachments!.transfers[1];
    expect(current.id).toBe(old.id);
    expect(current.attachmentId).not.toBe(old.attachmentId);
    expect(draft().attachments!.abandonedTransfers![0].attachmentId).toBe(
      old.attachmentId,
    );
    const confirmed = (providerId: string) =>
      new Response(
        JSON.stringify({
          data: {
            publicFileServiceId: providerId,
            fileURL: 'https://files.example.com/part',
          },
        }),
      );
    vi.mocked(fetch).mockResolvedValueOnce(confirmed(nextProvider));
    await request(`/attachments/transfers/${old.id}/confirm`, 'POST', {
      expectedRevision: revision(),
    });
    expect(draft().attachments!.printFile!.publicFileServiceId).toBe(
      nextProvider,
    );
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Unknown old outcome'));
    let cleanup = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await cleanup.json()).cleanup[0].status).toBe('protected');
    vi.mocked(fetch).mockResolvedValueOnce(confirmed('different-provider'));
    cleanup = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await cleanup.json()).cleanup[0].status).toBe('protected');
    vi.mocked(fetch).mockResolvedValueOnce(confirmed(oldProvider));
    cleanup = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await cleanup.json()).cleanup[0].status).toBe('pending');
    expect(draft().attachments!.printFile!.publicFileServiceId).toBe(
      nextProvider,
    );
  });
  it('retains an unknown print allocation during explicit reselection and fences its late confirmation', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Unknown allocation'));
    await intent('print');
    const unknown = draft().attachments!.transfers[0];
    provider();
    await request(`/attachments/transfers/${unknown.id}/retry`, 'POST', {
      expectedRevision: revision(),
    });
    const current = draft().attachments!.transfers[0];
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>(done => {
          resolve = done;
        }),
    );
    const confirming = request(
      `/attachments/transfers/${current.id}/confirm`,
      'POST',
      { expectedRevision: revision() },
    );
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    provider();
    await request(`/attachments/transfers/${current.id}/retry`, 'POST', {
      expectedRevision: revision(),
    });
    const latest = draft().attachments!.transfers[0];
    resolve(
      new Response(
        JSON.stringify({
          data: {
            publicFileServiceId: current.placeholder!.publicFileServiceId,
            fileURL: 'https://files.example.com/late',
          },
        }),
      ),
    );
    expect((await confirming).status).toBe(200);
    expect(draft().attachments!.printFile).toBeNull();
    expect(draft().attachments!.transfers[0].attachmentId).toBe(
      latest.attachmentId,
    );
    const cleanup = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect(
      (await cleanup.json()).cleanup.map((item: Row) => item.status),
    ).toEqual(['protected', 'pending']);
  });
  it('protects pending order photos through provider awaits and releases reservations only after the snapshot exists', async () => {
    const photo = (await upload()).draft.attachments.photos[0];
    const orderApp = new Hono().post('/fulfill', async c =>
      c.json(
        await createPaidOrderFulfillment({
          db: db as never,
          env,
        }).fulfillPaidOrder({
          fulfillment: {
            cartId: 'cart',
            userId: 'user',
            stripeEventId: 'event',
            stripeObjectId: 'object',
            idempotencyKey: 'payment',
          },
          profile: {
            email: 'customer@example.com',
            firstName: 'A',
            lastName: 'B',
            shippingAddress: '1 Main',
            city: 'City',
            state: 'CA',
            zipCode: '12345',
            phone: '5555555555',
          },
          items: [
            {
              id: 1,
              skuNumber: 'SKU',
              quantity: 1,
              color: 'black',
              filamentType: 'PLA',
              filamentId: 'filament',
              productName: 'Part',
              productImage: photo.imageUrl,
              productPrice: 1,
              stl: null,
              publicFileServiceId: 'provider',
            },
          ],
        }),
      ),
    );
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>(done => {
          resolve = done;
        }),
    );
    const pending = orderApp.request('/fulfill', { method: 'POST' });
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(records(schema.productAssets)[0].references).toEqual(
      expect.arrayContaining([expect.stringMatching(/^order-attempt:/)]),
    );
    const discarded = await request(
      `?expectedRevision=${revision()}`,
      'DELETE',
    );
    expect((await discarded.json()).cleanup[0].status).toBe('protected');
    expect(remove).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}'));
    resolve(new Response(JSON.stringify({ publicOrderId: 'order' })));
    expect((await pending).status).toBe(200);
    expect(records(schema.productAssets)[0].references).toEqual([]);
    expect(records(schema.ordersTable)[0].itemSnapshot).toContain(
      photo.imageUrl,
    );
    const cleanup = await request('/cleanup/retry', 'POST', {
      expectedRevision: revision(),
    });
    expect((await cleanup.json()).cleanup[0].status).toBe('protected');
    expect(remove).not.toHaveBeenCalled();
  });
  it('coordinates order reservations against deletion claims and releases partial reservations before provider calls', async () => {
    const first = (await upload()).draft.attachments.photos[0];
    const second = (await upload()).draft.attachments.photos[1];
    records(schema.productAssets)[1].status = 'deleting';
    expect((await orderRequest(`${first.id} ${second.id}`)).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
    expect(records(schema.productAssets)[0].references).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^order-attempt:/)]),
    );
  });
  it('preserves ambiguous order operations and releases definitive draft rejection reservations for every supported reference form', async () => {
    await upload();
    const asset = records(schema.productAssets)[0];
    for (const reference of [
      'unrelated',
      String(asset.objectKey),
      'known-provider',
      'https://files.example.com/retained',
    ]) {
      asset.providerId = 'known-provider';
      asset.fileUrl = 'https://files.example.com/retained';
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('{}', { status: 400 }),
      );
      expect((await orderRequest(reference)).status).toBe(500);
      expect(asset.references).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^order-attempt:/)]),
      );
    }
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    expect((await orderRequest(String(asset.id))).status).toBe(500);
    const retained = [...(asset.references as string[])];
    expect(retained).toEqual(
      expect.arrayContaining([expect.stringMatching(/^order-attempt:/)]),
    );
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Ambiguous submission'));
    expect((await orderRequest(String(asset.id))).status).toBe(500);
    expect((asset.references as string[]).length).toBe(retained.length + 1);
  });
  it('retries a stored photo without rotation and removes saved attachments lacking a retained transfer', async () => {
    const started = await intent();
    put.mockImplementationOnce(async (key, data) => {
      bucket.set(key, data.slice());
      throw new Error('response lost');
    });
    await app.request(
      started.transfer.upload.url,
      { method: 'PUT', body: bytes(), headers: { cookie: 'session=yes' } },
      env,
    );
    const transfer = draft().attachments!.transfers[0];
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/retry`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    expect(draft().attachments!.photos).toHaveLength(1);
    expect(
      (
        await request(`/attachments/transfers/${transfer.id}/retry`, 'POST', {
          expectedRevision: revision(),
        })
      ).status,
    ).toBe(200);
    draft().attachments!.transfers = [];
    expect(
      (
        await request(
          `/attachments/${transfer.attachmentId}?expectedRevision=${revision()}`,
          'DELETE',
        )
      ).status,
    ).toBe(200);
  });
});
