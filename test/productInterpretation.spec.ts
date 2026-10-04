import { beforeEach, expect, it, vi } from 'vitest';
import {
  interpretProductMessage,
  productQuestions,
} from '../src/modules/productInterpretation';
import type { ProductDraft } from '../src/modules/productDraftContracts';
import { PRICE } from '../src/shopping/pricing';
import { mockEnv } from './mocks/env';

const draft: ProductDraft = {
  id: '11111111-1111-4111-8111-111111111111',
  target: { kind: 'new' },
  revision: 4,
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  cleanupPending: false,
  state: {
    answers: { name: 'Retained name' },
    history: [],
    pendingQuestions: [],
  },
  context: { status: 'new' },
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
const ledger = { admit: vi.fn(), reserve: vi.fn(), settle: vi.fn() };
const infer = vi.fn();
/** Supply only mock provider and accounting boundaries, never a live invocation. */
function environment() {
  return {
    ...mockEnv(),
    AGENT_ENABLED: 'true',
    AGENT_PRICE_VERSION: PRICE.version,
    AI: { run: infer },
    SHOPPING_LEDGER: {
      idFromName: vi.fn(name => name),
      get: vi.fn(() => ledger),
    },
  } as unknown as ReturnType<typeof mockEnv>;
}
/** Wrap a correction in the provider's validated completion envelope. */
function response(
  corrections: unknown,
  usage: unknown = { prompt_tokens: 10, completion_tokens: 20 },
) {
  return {
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            scope: 'same',
            intent: 'create',
            corrections,
          }),
        },
      },
    ],
    usage,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  ledger.admit.mockResolvedValue(true);
  ledger.reserve.mockResolvedValue({ status: 'reserved', id: 'reservation' });
  ledger.settle.mockResolvedValue(10);
  infer.mockResolvedValue(response({ markupPercentage: '50' }));
});
it('reserves the shared cap under authenticated admin identity and settles valid usage', async () => {
  const result = await interpretProductMessage(
    environment(),
    'owner',
    draft,
    'Use 50% markup',
  );
  expect(result.corrections).toEqual({ markupPercentage: '50' });
  expect(ledger.admit).toHaveBeenCalledWith(
    'admin-product:owner',
    `admin-product:owner:${draft.id}`,
    'revision:4',
  );
  expect(ledger.reserve).toHaveBeenCalledWith(
    {
      sessionId: `admin-product:owner:${draft.id}`,
      runId: 'revision:4',
      invocation: 0,
    },
    PRICE.version,
  );
  expect(ledger.settle).toHaveBeenCalledWith('reservation', {
    prompt_tokens: 10,
    completion_tokens: 20,
  });
  expect(infer).toHaveBeenCalledTimes(1);
  expect(infer.mock.calls[0][1]).toMatchObject({
    stream: false,
    store: false,
    max_completion_tokens: PRICE.output,
  });
});
it.each([
  '',
  'invented',
])('rejects unsupported model correction %s without clearing saved answers', async value => {
  infer.mockResolvedValue(response({ name: value }));
  await expect(
    interpretProductMessage(environment(), 'owner', draft, 'Use 50% markup'),
  ).rejects.toThrow();
  expect(draft.state.answers.name).toBe('Retained name');
  expect(ledger.settle).toHaveBeenCalledTimes(1);
});
it('rejects empty category replacement and malformed output while accounting independently', async () => {
  infer.mockResolvedValue(response({ categoryNames: [] }, null));
  await expect(
    interpretProductMessage(environment(), 'owner', draft, 'Use 50% markup'),
  ).rejects.toThrow();
  expect(ledger.settle).not.toHaveBeenCalled();
  infer.mockResolvedValue({ choices: [] });
  await expect(
    interpretProductMessage(environment(), 'owner', draft, 'Use 50% markup'),
  ).rejects.toThrow();
});
it.each([
  'duplicate',
  'exhausted',
])('never spends on %s reservation', async status => {
  ledger.reserve.mockResolvedValue({ status, id: 'reservation' });
  await expect(
    interpretProductMessage(environment(), 'owner', draft, 'Use 50% markup'),
  ).rejects.toThrow();
  expect(infer).not.toHaveBeenCalled();
});
it('honors disabled inference, admission failure and pricing mismatch', async () => {
  const env = environment();
  env.AGENT_ENABLED = 'false';
  await expect(
    interpretProductMessage(env, 'owner', draft, 'Use 50% markup'),
  ).rejects.toThrow();
  env.AGENT_ENABLED = 'true';
  env.AGENT_PRICE_VERSION = 'unverified';
  await expect(
    interpretProductMessage(env, 'owner', draft, 'Use 50% markup'),
  ).rejects.toThrow();
  ledger.admit.mockResolvedValue(false);
  await expect(
    interpretProductMessage(environment(), 'owner', draft, 'Use 50% markup'),
  ).rejects.toThrow();
  expect(infer).not.toHaveBeenCalled();
});
it('asks only missing administrator facts and never asks for service prices', () => {
  expect(productQuestions(draft).map(question => question.id)).toEqual([
    'description',
    'filamentType',
    'color',
    'markupPercentage',
    'inPersonPrice',
    'categoryNames',
    'printFile',
    'photos',
  ]);
  const complete = {
    ...draft,
    state: {
      ...draft.state,
      answers: {
        name: 'Part',
        description: 'Supplied facts',
        filamentType: 'PLA',
        color: 'Blue',
        markupPercentage: '50',
        inPersonPrice: '1.50',
        categoryIds: [1],
      },
    },
  };
  expect(productQuestions(complete).map(question => question.id)).toEqual([
    'printFile',
    'photos',
  ]);
  expect(
    productQuestions({
      ...draft,
      context: { status: 'unavailable', productId: 1 },
    }),
  ).toEqual([{ id: 'target', prompt: expect.any(String) }]);
});

it('validates provider options and never treats unavailable or other-provider pairs as authoritative', async () => {
  const { readProductOptions } = await import(
    '../src/modules/productInterpretation'
  );
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({
      success: true,
      data: [
        {
          provider: 'Slant 3D',
          profile: 'PLA',
          color: 'Blue',
          available: true,
        },
        {
          provider: 'Slant 3D',
          profile: 'PLA',
          color: 'Red',
          available: false,
        },
        { provider: 'Other', profile: 'PETG', color: 'White', available: true },
      ],
    }),
  );
  expect(await readProductOptions(environment())).toEqual([
    { material: 'PLA', color: 'Blue' },
  ]);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 503 }));
  await expect(readProductOptions(environment())).rejects.toThrow(
    'Production options unavailable',
  );
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ success: true, data: [{ profile: 'PLA' }] }),
  );
  await expect(readProductOptions(environment())).rejects.toThrow();
});
