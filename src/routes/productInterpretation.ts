import { zValidator } from '@hono/zod-validator';
import { categoryTable } from '../db/schema';
import factory from '../factory';
import {
  CategoryConflictError,
  saveConfirmedDraftCategory,
} from '../modules/productCategories';
import { resolveDraftCategories } from '../modules/productCategoryResolution';
import {
  productDraftIdSchema,
  productDraftStateSchema,
} from '../modules/productDraftContracts';
import {
  productDraftResponse,
  readProductDraft,
  saveProductDraft,
} from '../modules/productDrafts';
import {
  interpretProductMessage,
  prepareProductDraftSchema,
  productQuestions,
  readProductOptions,
} from '../modules/productInterpretation';

/** Build one preparation response using the existing owner/revision-checked draft persistence API. */
const router = factory.createApp().post(
  '/:id/prepare',
  zValidator('param', productDraftIdSchema),
  zValidator('json', prepareProductDraftSchema),
  /** Validate one current preparation request and retain it through existing CAS saves. */
  async c => {
    const ownerId = c.var.userId!;
    const id = c.req.valid('param').id;
    const input = c.req.valid('json');
    if (input.message && input.confirmCategoryName)
      return c.json(
        {
          error: 'Confirm categories separately from conversation instructions',
        },
        400,
      );
    const row = await readProductDraft(c.var.db, ownerId, id);
    if (!row) return c.json({ error: 'Draft not found' }, 404);
    if (row.revision !== input.expectedRevision)
      return c.json({ error: 'Revision conflict' }, 409);
    const draft = await productDraftResponse(c.var.db, row);
    if (draft.context.status === 'unavailable')
      return c.json({ error: 'Product unavailable' }, 409);
    const state = productDraftStateSchema.parse({
      ...draft.state,
      answers: { ...draft.state.answers, ...input.answers },
    });
    let interpretation = state.interpretation ?? {
      intent:
        draft.target.kind === 'new' ? ('create' as const) : ('update' as const),
      status: 'prepared' as const,
      confirmedCategoryNames: [],
      proposedCategoryNames: [],
      productionOptions: [],
      explanation: 'Draft answers saved. No catalog changes were made.',
    };
    if (input.message) {
      // Reserve history room before spending. Failure preserves the message and controls.
      if (state.history.length > 498)
        return c.json({ error: 'Conversation history is full' }, 400);
      state.history.push({ role: 'user', content: input.message });
      try {
        const proposal = await interpretProductMessage(
          c.env,
          ownerId,
          { ...draft, state },
          input.message,
        );
        if (proposal.scope === 'same') {
          state.answers = { ...state.answers, ...proposal.corrections };
          interpretation = {
            ...interpretation,
            intent: proposal.intent,
            status: 'prepared',
            explanation:
              'The supplied changes are in this draft. Review the preparation below.',
          };
        } else {
          interpretation = {
            ...interpretation,
            status: 'clarification',
            explanation:
              'Please clarify the change for this product only. Start a separate conversation for another product; bulk requests are not supported.',
          };
        }
      } catch {
        interpretation = {
          ...interpretation,
          status: 'unavailable',
          explanation:
            'Interpretation unavailable. Your message, answers and files are retained. Use the draft controls or explicitly send a new instruction.',
        };
      }
      state.history.push({
        role: 'assistant',
        content: interpretation.explanation,
      });
    }
    try {
      interpretation.productionOptions = await readProductOptions(c.env);
    } catch {
      interpretation.productionOptions = [];
    }
    const categories = await c.var.db.select().from(categoryTable).all();
    const confirmation = input.confirmCategoryName;
    if (confirmation) {
      if (
        input.message ||
        !draft.state.interpretation?.proposedCategoryNames.includes(
          confirmation,
        ) ||
        !draft.state.answers.categoryNames?.includes(confirmation) ||
        !state.answers.categoryNames?.includes(confirmation)
      )
        return c.json(
          {
            error: 'Category confirmation does not match the current proposal',
          },
          409,
        );
    }
    state.interpretation = interpretation;
    const categoryQuestions = resolveDraftCategories(state, categories);
    if (confirmation)
      interpretation.confirmedCategoryNames = [
        ...new Set([...interpretation.confirmedCategoryNames, confirmation]),
      ];
    state.pendingQuestions = [
      ...productQuestions({ ...draft, state }),
      ...categoryQuestions,
    ];
    if (interpretation.status === 'clarification')
      state.pendingQuestions.unshift({
        id: 'clarification',
        prompt: interpretation.explanation,
      });
    const saveInput = {
      expectedRevision: input.expectedRevision,
      state: productDraftStateSchema.parse(state),
    };
    let saved: Awaited<ReturnType<typeof readProductDraft>>;
    try {
      saved = confirmation
        ? await saveConfirmedDraftCategory(
            c.var.db,
            ownerId,
            id,
            saveInput,
            confirmation,
          )
        : await saveProductDraft(c.var.db, ownerId, id, saveInput);
    } catch (error) {
      if (error instanceof CategoryConflictError)
        return c.json(
          {
            error:
              'Category is ambiguous. Reload and choose its exact identity.',
          },
          409,
        );
      return c.json(
        {
          error:
            'Save outcome unavailable. Reload this draft to recover before retrying.',
        },
        503,
      );
    }
    if (!saved)
      return c.json(
        { error: 'Revision conflict; reload before retrying' },
        409,
      );
    return c.json(await productDraftResponse(c.var.db, saved));
  },
);

export default router;
