import { z } from 'zod';

// https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/ (2026-09-21).
// Integer nanodollars per token; never discount cached input at admission.
export const PRICE = {
  version: 'glm-5.3-flash-2026-09-21',
  model: '@cf/zai-org/glm-5.3-flash',
  context: 1_310_720,
  output: 2048,
  inputRate: 150,
  outputRate: 500,
} as const;
export const MONTHLY_CAP = 20_000_000_000;
export const RESERVATION =
  PRICE.context * PRICE.inputRate + PRICE.output * PRICE.outputRate;
export const usageSchema = z.object({
  prompt_tokens: z.number().int().min(0).max(PRICE.context),
  completion_tokens: z.number().int().min(0).max(PRICE.output),
});
export type Usage = z.infer<typeof usageSchema>;
export function usageCost(usage: Usage) {
  const valid = usageSchema.parse(usage);
  return (
    valid.prompt_tokens * PRICE.inputRate +
    valid.completion_tokens * PRICE.outputRate
  );
}
