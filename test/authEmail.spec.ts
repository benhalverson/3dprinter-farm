import { betterAuth } from 'better-auth';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAuth, type AuthBindings } from '../lib/auth';
import { mockEnv } from './mocks/env';

vi.unmock('../lib/auth');
vi.mock('better-auth', () => ({ betterAuth: vi.fn(() => ({})) }));

const url = 'https://api.benhalverson.dev/api/auth/reset-password/test-token?callbackURL=https%3A%2F%2Fluluspeedworks.com%2Freset-password';
const reset = {
  user: {
    id: 'test-user',
    email: 'customer@example.com',
    name: 'Customer',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  url,
  token: 'test-token',
};

function configure(email?: AuthBindings['AUTH_EMAIL']) {
  const env = mockEnv();
  createAuth(env.DB, { ...env, AUTH_EMAIL: email });
  const options = vi.mocked(betterAuth).mock.calls.at(-1)?.[0];
  const send = options?.emailAndPassword?.sendResetPassword;
  if (!send) throw new Error('Expected password reset callback');
  return { send, options };
}

afterEach(() => vi.restoreAllMocks());

describe('password reset email delivery', () => {
  test('sends only plain text with the Lulu sender and preserves reset settings', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'test-message' });
    const auth = configure({ send });

    await auth.send(reset);

    expect(send).toHaveBeenCalledExactlyOnceWith({
      from: 'Lulu Speedworks <noreply@luluspeedworks.com>',
      to: reset.user.email,
      subject: 'Reset your Lulu Speedworks password',
      text: `Reset your password: ${url}\n\nThis link expires in one hour. If you did not request a password reset, ignore this email.`,
    });
    expect(auth.options?.emailAndPassword).toMatchObject({
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
    });
    expect(auth.options?.advanced?.backgroundTasks).toBeUndefined();
    expect(auth.options?.advanced?.disableOriginCheck).toBe(false);
    expect(auth.options?.trustedOrigins).toContain('https://luluspeedworks.com');
  });

  test('waits until the provider finishes delivery', async () => {
    let finish = () => {};
    const pending = new Promise<EmailSendResult>(resolve => {
      finish = () => resolve({ messageId: 'test-message' });
    });
    const send = vi.fn(() => pending);
    const auth = configure({ send });
    const completed = vi.fn();
    const delivery = Promise.resolve(auth.send(reset)).then(completed);

    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    finish();
    await delivery;
    expect(completed).toHaveBeenCalledOnce();
  });

  test('rejects delivery failures without exposing provider data', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error(`Provider failed: ${url}`));
    const auth = configure({ send });

    await expect(auth.send(reset)).rejects.toThrow('Password reset email delivery failed');
    expect(log).toHaveBeenCalledExactlyOnceWith('auth.password_reset.email_delivery_failed');
  });

  test('rejects a missing binding and keeps Better Auth logging sanitized', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auth = configure();

    await expect(auth.send(reset)).rejects.toThrow('Password reset email delivery failed');
    auth.options?.logger?.log?.('error', 'Provider failure', { url });
    expect(log.mock.calls).toEqual([
      ['auth.password_reset.email_delivery_failed'],
      ['auth.error'],
    ]);
  });
});
