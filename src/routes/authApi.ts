import factory from '../factory';
import { authMiddleware, requireCatalogMutationRole } from '../utils/authMiddleware';
import { type AuthBindings, createAuth } from '../../lib/auth';
import type { Bindings } from '../types';
import { rateLimit } from '../utils/rateLimit';

export type AuthApiEnv = {
  Bindings: AuthBindings & Pick<Bindings, 'DB' | 'RATE_LIMIT_KV'>;
};

export default factory.createApp()
  .use('/organization/*', authMiddleware, requireCatalogMutationRole)
  .post(
    '/request-password-reset',
    rateLimit({
      windowSeconds: 900,
      maxRequests: 5,
      keyPrefix: 'password-reset-request',
    }),
  )
  .post(
    '/reset-password',
    rateLimit({
      windowSeconds: 900,
      maxRequests: 10,
      keyPrefix: 'password-reset-submit',
    }),
  )
  .on(['GET', 'POST'], '/*', c =>
    createAuth(c.env.DB, c.env).handler(c.req.raw),
  );
