import { DrizzleQueryError, eq } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/app';
import { productDrafts } from '../../src/db/schema';
import { AttachmentError } from '../../src/modules/productAssets';
import * as attachments from '../../src/modules/productAttachments';
import * as drafts from '../../src/modules/productDrafts';
import { mockEnv } from '../mocks/env';

const auth = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  status: 200,
}));
vi.mock('../../src/utils/authMiddleware', async importOriginal => {
  const original =
    await importOriginal<typeof import('../../src/utils/authMiddleware')>();
  return {
    ...original,
    requireCatalogMutationRole: vi.fn(async (c, next) => {
      if (auth.failure) throw auth.failure;
      if (auth.status !== 200)
        return c.json({ error: 'Forbidden' }, auth.status);
      return next();
    }),
  };
});
vi.mock('../../src/modules/productDrafts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/modules/productDrafts')>()),
  beginProductDraft: vi.fn(),
  listProductDrafts: vi.fn(),
  readProductDraft: vi.fn(),
  saveProductDraft: vi.fn(),
}));
vi.mock('../../src/modules/productAttachments', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../src/modules/productAttachments')
  >()),
  discardAttachments: vi.fn(),
  retryAttachmentCleanup: vi.fn(),
  createAttachmentIntent: vi.fn(),
  uploadAttachmentPhoto: vi.fn(),
  confirmAttachment: vi.fn(),
  retryAttachmentTransfer: vi.fn(),
  editAttachments: vi.fn(),
  removeAttachment: vi.fn(),
  readAttachmentPhoto: vi.fn(),
  attachmentDraft: vi.fn(),
}));

const id = '4a1a372c-cbd7-4bac-bc73-6c29d2a9e292';
const transferId = '5a1a372c-cbd7-4bac-bc73-6c29d2a9e292';
const attachmentId = '6a1a372c-cbd7-4bac-bc73-6c29d2a9e292';
const base = '/admin/product-drafts';
const state = {
  answers: { notes: 'private-conversation' },
  pendingQuestions: [],
  history: [],
};
const errorLog = vi.fn();
const env = mockEnv();
const request = (path: string, method = 'GET', body?: unknown, ray = true) =>
  app.request(
    `${base}${path}${path.includes('?') ? '' : '?secret=private-query'}`,
    {
      method,
      headers: {
        cookie: 'session=private-cookie',
        authorization: 'Bearer private-credential',
        'content-type': 'application/json',
        ...(ray ? { 'cf-ray': 'draft-test-ray' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );

function failure() {
  const query = new SQLiteSyncDialect().sqlToQuery(
    eq(productDrafts.ownerId, 'private-database-value'),
  );
  const cause = Object.assign(new Error('D1_ERROR: storage unavailable'), {
    cause: new TypeError('Underlying database failure'),
    uploadUrl: 'https://upload.example/private-capability',
    credentials: 'private-error-property',
  });
  return new DrizzleQueryError(query.sql, query.params, cause);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const run of [...Object.values(drafts), ...Object.values(attachments)]) {
    if (vi.isMockFunction(run)) run.mockReset();
  }
  auth.failure = undefined;
  auth.status = 200;
  vi.spyOn(console, 'error').mockImplementation(errorLog);
});
afterEach(() => vi.restoreAllMocks());

async function expectFailure(
  response: Response,
  context: Record<string, unknown>,
  attachment = false,
) {
  expect(response.status).toBe(500);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    error: attachment
      ? 'Attachment request failed; reload to recover saved state'
      : 'Product draft request failed',
  });
  expect(errorLog).toHaveBeenCalledExactlyOnceWith({
    event: 'product_draft.request.failed',
    rayId: 'draft-test-ray',
    draftId: id,
    attachmentId: null,
    transferId: null,
    ...context,
    error: {
      name: 'Error',
      message: 'Failed database query (SQL and parameters omitted)',
      stack: expect.any(String),
      cause: {
        name: 'Error',
        message: 'D1_ERROR: storage unavailable',
        stack: expect.any(String),
        cause: {
          name: 'TypeError',
          message: 'Underlying database failure',
          stack: expect.any(String),
        },
      },
    },
  });
  const logged = JSON.stringify(errorLog.mock.calls);
  for (const secret of [
    'private-',
    'upload.example',
    'owner_id',
    env.BETTER_AUTH_SECRET,
  ])
    expect(logged).not.toContain(secret);
}

describe('admin failure diagnostics through HTTP', () => {
  it.each([
    [
      '',
      'POST',
      { target: { kind: 'new' }, state },
      'draft.begin',
      drafts.beginProductDraft,
    ],
    ['', 'GET', undefined, 'draft.list', drafts.listProductDrafts],
    [`/${id}`, 'GET', undefined, 'draft.read', drafts.readProductDraft],
    [
      `/${id}`,
      'PUT',
      { expectedRevision: 1, state },
      'draft.save',
      drafts.saveProductDraft,
    ],
    [
      `/${id}?expectedRevision=1`,
      'DELETE',
      undefined,
      'draft.discard.save',
      attachments.discardAttachments,
    ],
  ] as const)('logs %s %s once', async (path, method, body, operation, run) => {
    vi.mocked(run).mockRejectedValueOnce(failure());
    await expectFailure(await request(path, method, body), {
      operation,
      method,
      path: `${base}${path.split('?')[0]}`,
      draftId: path ? id : null,
    });
  });

  it('distinguishes discard cleanup failure after the tombstone was saved', async () => {
    vi.mocked(attachments.discardAttachments).mockResolvedValueOnce({
      id,
      revision: 2,
    } as Awaited<ReturnType<typeof attachments.discardAttachments>>);
    vi.mocked(attachments.retryAttachmentCleanup).mockRejectedValueOnce(
      failure(),
    );
    await expectFailure(await request(`/${id}?expectedRevision=1`, 'DELETE'), {
      operation: 'draft.discard.cleanup',
      method: 'DELETE',
      path: `${base}/${id}`,
    });
    expect(attachments.discardAttachments).toHaveBeenCalledOnce();
    expect(attachments.retryAttachmentCleanup).toHaveBeenCalledWith(
      expect.anything(),
      env,
      'user_123',
      id,
      2,
    );
  });

  it.each([
    [
      `/attachments/transfers/${transferId}/confirm`,
      'POST',
      { expectedRevision: 1 },
      'attachment.confirm',
      attachments.confirmAttachment,
      { transferId },
    ],
    [
      `/attachments/${attachmentId}/image`,
      'GET',
      undefined,
      'attachment.read',
      attachments.readAttachmentPhoto,
      { attachmentId },
    ],
    [
      `/attachments/${attachmentId}?expectedRevision=1`,
      'DELETE',
      undefined,
      'attachment.remove',
      attachments.removeAttachment,
      { attachmentId },
    ],
    [
      '/cleanup',
      'GET',
      undefined,
      'attachment.cleanup.read',
      attachments.attachmentDraft,
      {},
    ],
    [
      '/cleanup/retry',
      'POST',
      { expectedRevision: 1 },
      'attachment.cleanup.retry',
      attachments.retryAttachmentCleanup,
      {},
    ],
  ] as const)('logs attachment operation %s', async (suffix, method, body, operation, run, identifiers) => {
    vi.mocked(run).mockRejectedValueOnce(failure());
    await expectFailure(
      await request(`/${id}${suffix}`, method, body),
      {
        operation,
        method,
        path: `${base}/${id}${suffix.split('?')[0]}`,
        ...identifiers,
      },
      true,
    );
  });

  it('logs middleware exceptions once without Hono dumping the raw error', async () => {
    auth.failure = failure();
    await expectFailure(await request(`/${id}`, 'GET', undefined, false), {
      operation: 'draft.middleware',
      method: 'GET',
      path: `${base}/${id}`,
      rayId: null,
    });
  });

  it.each([
    400, 404, 409,
  ] as const)('does not log expected attachment status %s', async status => {
    vi.mocked(attachments.confirmAttachment).mockRejectedValueOnce(
      new AttachmentError(status, 'Expected failure'),
    );
    const result = await request(
      `/${id}/attachments/transfers/${transferId}/confirm`,
      'POST',
      { expectedRevision: 1 },
    );
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error: 'Expected failure' });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('does not log authorization or validation responses', async () => {
    const unauthenticated = await app.request(`${base}/${id}`, {}, env);
    expect(unauthenticated.status).toBe(401);
    auth.status = 403;
    expect((await request(`/${id}`)).status).toBe(403);
    auth.status = 200;
    expect((await request('/invalid-id')).status).toBe(400);
    const malformed = await app.request(
      base,
      {
        method: 'POST',
        headers: {
          cookie: 'session=private-cookie',
          'content-type': 'application/json',
        },
        body: '{',
      },
      env,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Invalid input' });
    expect(errorLog).not.toHaveBeenCalled();
  });
});
