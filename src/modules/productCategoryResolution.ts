import type { ProductDraftState } from './productDraftContracts';
import { normalizeCategoryName } from './productCategories';

/** Resolve current requested names against catalog identities without authorizing writes. */
export function resolveDraftCategories(
  state: ProductDraftState,
  categories: { categoryId: number; categoryName: string }[],
) {
  const interpretation = state.interpretation;
  const questions: { id: string; prompt: string }[] = [];
  if (!interpretation) return questions;
  const requested = state.answers.categoryNames;
  interpretation.proposedCategoryNames = [];
  interpretation.confirmedCategoryNames =
    interpretation.confirmedCategoryNames.filter(
      name =>
        requested?.includes(name) &&
        categories.filter(
          category =>
            normalizeCategoryName(category.categoryName) ===
            normalizeCategoryName(name),
        ).length === 1,
    );
  if (requested?.length) {
    const ids: number[] = [];
    for (const name of requested) {
      const matches = categories.filter(
        category =>
          normalizeCategoryName(category.categoryName) ===
          normalizeCategoryName(name),
      );
      if (matches.length === 1) ids.push(matches[0].categoryId);
      else {
        if (!matches.length) interpretation.proposedCategoryNames.push(name);
        questions.push({
          id: 'categoryNames',
          prompt: matches.length
            ? `Category “${name}” is ambiguous. Choose its exact category identity.`
            : `New category “${name}” needs explicit confirmation before creation.`,
        });
      }
    }
    state.answers.categoryIds = [...new Set(ids)];
  } else if (
    state.answers.categoryIds?.some(
      id => !categories.some(category => category.categoryId === id),
    )
  ) {
    questions.push({
      id: 'categoryNames',
      prompt:
        'A selected category is unavailable. Choose an existing category.',
    });
  }
  return questions;
}
