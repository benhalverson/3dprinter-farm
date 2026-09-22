import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAuth } from '../lib/auth';
import { mockEnv } from './mocks/env';

vi.unmock('../lib/auth');

afterEach(() => vi.restoreAllMocks());

async function configure(send: SendEmail['send'], knownUser = true) {
  const env = mockEnv();
  const auth = createAuth(env.DB, { ...env, AUTH_EMAIL: { send } });
  const context = await auth.$context;
  vi.spyOn(context.internalAdapter, 'findUserByEmail').mockResolvedValue(
    knownUser ? {
      user: {
        id: 'customer', email: 'customer@example.com', name: 'Customer',
        emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      },
      accounts: [],
    } : null,
  );
  vi.spyOn(context.internalAdapter, 'createVerificationValue').mockImplementation(
    async value => ({ ...value, id: 'verification', createdAt: new Date(), updatedAt: new Date() }),
  );
  vi.spyOn(context.internalAdapter, 'findVerificationValue').mockResolvedValue(null);
  return () => auth.handler(new Request('http://localhost:8787/api/auth/request-password-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'customer@example.com', redirectTo: 'https://luluspeedworks.com/reset-password' }),
  }));
}

describe('Better Auth reset delivery responses', () => {
  test('does not respond until sending finishes', async () => {
    let finish = () => {};
    const pending = new Promise<EmailSendResult>(resolve => {
      finish = () => resolve({ messageId: 'test-message' });
    });
    const send = vi.fn(() => pending);
    const request = await configure(send);
    const completed = vi.fn();
    const response = request().then(value => { completed(); return value; });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    finish();
    expect((await response).status).toBe(200);
  });

  test('returns an error for provider failure without exposing provider details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'sensitive-provider-reset-token';
    const request = await configure(vi.fn().mockRejectedValue(new Error(secret)));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  test('keeps the generic success response for unknown addresses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn();
    const request = await configure(send, false);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: true,
      message: 'If this email exists in our system, check your email for the reset link',
    });
    expect(send).not.toHaveBeenCalled();
  });
});
