import type { Context } from 'hono';
import type { WorkerEnv } from '../factory';
import { serializeError } from './serializeError';

export function logProductDraftError(
  c: Context<WorkerEnv>,
  operation: string,
  error: unknown,
) {
  // Wildcard middleware can fail before Hono selects named route parameters.
  const segments = c.req.path.split('/');
  const identifier = (value: string | undefined) =>
    value && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
      ? value
      : null;
  console.error({
    event: 'product_draft.request.failed',
    operation,
    method: c.req.method,
    path: c.req.path,
    rayId: c.req.header('cf-ray') ?? null,
    draftId: c.req.param('id') ?? identifier(segments[3]),
    attachmentId:
      c.req.param('attachmentId') ??
      (segments[4] === 'attachments' ? identifier(segments[5]) : null),
    transferId:
      c.req.param('transferId') ??
      (segments[5] === 'transfers' ? identifier(segments[6]) : null),
    error: serializeError(error),
  });
}
