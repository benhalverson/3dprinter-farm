import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import router from '../../src/routes/productDrafts';
import { interpretProductMessage } from '../../src/modules/productInterpretation';
import {
  productDraftResponse,
  readProductDraft,
  saveProductDraft,
} from '../../src/modules/productDrafts';
import { mockAll } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

vi.mock('../../src/modules/productDrafts', () => ({
  readProductDraft: vi.fn(),
  saveProductDraft: vi.fn(),
  productDraftResponse: vi.fn(),
  beginProductDraft: vi.fn(),
  listProductDrafts: vi.fn(),
}));
vi.mock('../../src/modules/productInterpretation', async original => ({
  ...(await original<
    typeof import('../../src/modules/productInterpretation')
  >()),
  interpretProductMessage: vi.fn(),
  readProductOptions: vi
    .fn()
    .mockResolvedValue([{ material: 'PLA', color: 'Blue' }]),
}));
vi.mock('../../src/utils/authMiddleware', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    if (!c.req.header('x-admin'))
      return c.json({ error: 'Unauthenticated' }, 401);
    c.set('userId', 'owner');
    await next();
  },
  requireCatalogMutationRole: async (c: any, next: () => Promise<void>) => {
    if (c.req.header('x-admin') !== 'admin')
      return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
}));
const id = '11111111-1111-4111-8111-111111111111';
const saved = {
  id,
  revision: 4,
  target: { kind: 'new' as const },
  status: 'active' as const,
  createdAt: 1,
  updatedAt: 1,
  cleanupPending: false,
  context: { status: 'new' as const },
  state: {
    answers: { name: 'Saved name', color: 'Blue' },
    pendingQuestions: [],
    history: [],
  },
  attachments: {
    photos: [],
    printFile: null,
    primaryPhotoId: null,
    photoOrder: [],
    transfers: [],
    validation: [],
    cleanup: [],
  },
};
const app = new Hono().route('/drafts', router);
/** Send a protected preparation request through the real Hono routing/validation seam. */
function request(body: unknown, role = 'admin') {
  return app.request(
    `/drafts/${id}/prepare`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin': role },
      body: JSON.stringify(body),
    },
    mockEnv(),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readProductDraft).mockResolvedValue(saved as never);
  vi.mocked(productDraftResponse).mockImplementation(
    async (_db, row) => row as never,
  );
  vi.mocked(saveProductDraft).mockImplementation(
    async (_db, _owner, _id, input) =>
      ({ ...saved, revision: 5, state: input.state }) as never,
  );
  vi.mocked(interpretProductMessage).mockResolvedValue({
    scope: 'same',
    intent: 'create',
    corrections: { markupPercentage: '50' },
  });
  mockAll.mockResolvedValue([{ categoryId: 1, categoryName: 'Parts' }]);
});
describe('one-card preparation', () => {
  it.each([
    '',
    'member',
  ])('denies %s before reading private drafts or inference', async role => {
    const response = await request(
      { expectedRevision: 4, answers: {}, message: '50% markup' },
      role,
    );
    expect(response.status).toBe(role ? 403 : 401);
    expect(await response.json()).toEqual({
      error: role ? 'Forbidden' : 'Unauthenticated',
    });
    expect(readProductDraft).not.toHaveBeenCalled();
    expect(interpretProductMessage).not.toHaveBeenCalled();
  });
  it('rejects malformed and stale requests before inference', async () => {
    expect(
      (
        await request({
          expectedRevision: 4,
          answers: {},
          target: { kind: 'new' },
        })
      ).status,
    ).toBe(400);
    const response = await request({
      expectedRevision: 3,
      answers: {},
      message: '50',
    });
    expect(await response.json()).toEqual({ error: 'Revision conflict' });
    expect(response.status).toBe(409);
    expect(interpretProductMessage).not.toHaveBeenCalled();
  });
  it('merges supplied corrections with direct edits and saves one revision without catalog writes', async () => {
    const response = await request({
      expectedRevision: 4,
      answers: { description: 'My description' },
      message: '50% markup',
    });
    const body = (await response.json()) as typeof saved;
    expect(response.status).toBe(200);
    expect(body.state.answers).toEqual({
      name: 'Saved name',
      color: 'Blue',
      description: 'My description',
      markupPercentage: '50',
    });
    expect(body.attachments).toEqual(saved.attachments);
    expect(body.revision).toBe(5);
    expect(body.state.pendingQuestions).toEqual(
      expect.arrayContaining([
        { id: 'inPersonPrice', prompt: expect.any(String) },
      ]),
    );
    expect(readProductDraft).toHaveBeenCalledWith(
      expect.anything(),
      'owner',
      id,
    );
    expect(saveProductDraft).toHaveBeenCalledWith(
      expect.anything(),
      'owner',
      id,
      expect.objectContaining({ expectedRevision: 4 }),
    );
  });
  it('bypasses inference for direct edits and resolves existing category names', async () => {
    const response = await request({
      expectedRevision: 4,
      answers: { inPersonPrice: '2.50', categoryNames: ['Parts'] },
    });
    expect(((await response.json()) as any).state.answers.categoryIds).toEqual([
      1,
    ]);
    expect(interpretProductMessage).not.toHaveBeenCalled();
  });
  it('retains inputs and deterministic controls when inference fails', async () => {
    vi.mocked(interpretProductMessage).mockRejectedValue(
      new Error('provider failure'),
    );
    const response = await request({
      expectedRevision: 4,
      answers: { name: 'Direct answer' },
      message: 'A new instruction',
    });
    const body = (await response.json()) as any;
    expect(body.state.answers.name).toBe('Direct answer');
    expect(body.state.interpretation.status).toBe('unavailable');
    expect(body.state.history[0]).toEqual({
      role: 'user',
      content: 'A new instruction',
    });
    expect(body.state.pendingQuestions.length).toBeGreaterThan(0);
  });
  it('rejects a stale model response when another draft update wins', async () => {
    vi.mocked(saveProductDraft).mockResolvedValue(undefined);
    const response = await request({
      expectedRevision: 4,
      answers: {},
      message: '50% markup',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Revision conflict; reload before retrying',
    });
  });
  it('does not merge bulk or other-product instructions', async () => {
    vi.mocked(interpretProductMessage).mockResolvedValue({
      scope: 'bulk',
      intent: 'create',
      corrections: { name: 'Wrong product' },
    });
    const response = await request({
      expectedRevision: 4,
      answers: {},
      message: 'Add several products',
    });
    const body = (await response.json()) as any;
    expect(body.state.answers.name).toBe('Saved name');
    expect(body.state.interpretation.status).toBe('clarification');
  });
  it('lets an explicit existing-category identity replace an unresolved name without inference', async () => {
    const result = await request({
      expectedRevision: 4,
      answers: { categoryNames: [], categoryIds: [1] },
    });
    expect(result.status).toBe(200);
    const body = (await result.json()) as any;
    expect(body.state.answers.categoryIds).toEqual([1]);
    expect(body.state.interpretation.proposedCategoryNames).toEqual([]);
    expect(interpretProductMessage).not.toHaveBeenCalled();
  });
  it('records exact-name confirmation as preparation only, without repeated confirmation questions', async () => {
    const result = await request({
      expectedRevision: 4,
      answers: { categoryNames: ['New parts'] },
      confirmCategoryName: 'New parts',
    });
    expect(result.status).toBe(200);
    const body = (await result.json()) as any;
    expect(body.state.interpretation.confirmedCategoryNames).toEqual([
      'New parts',
    ]);
    expect(body.state.pendingQuestions).toContainEqual({
      id: 'categoryNames',
      prompt:
        'Category “New parts” confirmed for preparation. Category creation remains unavailable.',
    });
    expect(interpretProductMessage).not.toHaveBeenCalled();
  });
});
