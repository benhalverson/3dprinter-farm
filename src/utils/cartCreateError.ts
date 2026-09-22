import { DrizzleQueryError } from 'drizzle-orm';

/** Only explicitly selected fields may reach cart creation logs. */
export function serializeCartCreateError(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth >= 5) return { message: 'Cause chain truncated' };
  if (!(error instanceof Error)) {
    return {
      name: 'NonErrorThrow',
      message: typeof error === 'string' ? error : 'Non-Error value thrown',
    };
  }

  // Drizzle embeds bound values in both its message and stack header.
  // Keep the frames and the underlying D1 cause, never query/params fields.
  const message =
    error instanceof DrizzleQueryError
      ? 'Failed database query (SQL and parameters omitted)'
      : error.message;
  const stack = error.stack?.replace(error.message, message);
  return {
    name: error.name,
    message,
    stack,
    ...('cause' in error && error.cause !== undefined
      ? { cause: serializeCartCreateError(error.cause, depth + 1) }
      : {}),
  };
}
