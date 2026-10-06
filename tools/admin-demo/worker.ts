import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import * as schema from '../../src/db/schema';
import type { WorkerEnv } from '../../src/factory';
import { encryptPhoto, newPhotoKey } from '../../src/modules/productPhotoBytes';
import photos from '../../src/routes/catalogPhotos';
import products from '../../src/routes/product';
import drafts from '../../src/routes/productDrafts';
import squareCatalog from '../../src/routes/squareCatalog';
import { PRICE } from '../../src/shopping/pricing';
import type { Bindings } from '../../src/types';
import { createAuth } from './auth-fixture';

const app = new Hono<WorkerEnv>();
app.use(
  '*',
  cors({
    origin: origin =>
      /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
        ? origin
        : '',
    credentials: true,
  }),
);
app.get('/health', c => c.json({ status: 'ok', fixture: true }));
app.post('/__fixture/login', async c => {
  if (c.req.header('x-demo-fixture-token') !== 'lulu-local-demo')
    return c.json({ error: 'Fixture token required' }, 401);
  const { role = 'admin' } = await c.req.json<{ role?: 'admin' | 'member' }>();
  if (role !== 'admin' && role !== 'member')
    return c.json({ error: 'Unknown fixture role' }, 400);
  setCookie(c, 'demo-session', role, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
  });
  return c.json({ role, fixture: true });
});
app.get('/api/auth/get-session', async c =>
  c.json(await createAuth().api.getSession({ headers: c.req.raw.headers })),
);
app.post('/__fixture/lose-upsert-ack', async c => {
  if (c.req.header('x-demo-fixture-token') !== 'lulu-local-demo')
    return c.json({ error: 'Fixture token required' }, 401);
  return fetch('https://demo-fixture-control.invalid/lose-upsert-ack', {
    method: 'POST',
  });
});
app.get('/provider/files/:file', c =>
  c.text('solid fixture\nendsolid fixture\n'),
);
app.all('/__fixture/provider-upload/*', async c => {
  const target = new URL(c.req.url);
  target.hostname = 'demo-provider-upload.invalid';
  target.protocol = 'https:';
  target.port = '';
  return fetch(new Request(target, c.req.raw));
});
app.post('/__fixture/bootstrap', async c => {
  if (c.req.header('x-demo-fixture-token') !== 'lulu-local-demo')
    return c.json({ error: 'Fixture token required' }, 401);
  const db = drizzle(c.env.DB, { schema });
  const exists = await db
    .select()
    .from(schema.productsTable)
    .where(eq(schema.productsTable.id, 1))
    .get();
  if (exists) return c.json({ seeded: true });
  await db.insert(schema.users).values(
    ['admin', 'member'].map(role => ({
      id: `demo-${role}`,
      name: `Demo ${role}`,
      email: `${role}@example.test`,
      role,
    })),
  );
  await db
    .insert(schema.categoryTable)
    .values({ categoryId: 1, categoryName: 'Mounts', normalizedKey: 'mounts' });
  const assetId = '99999999-9999-4999-8999-999999999999';
  const key = newPhotoKey();
  const bytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAC0lEQVR4nGNgQAYAAA4AAamRc7EAAAAASUVORK5CYII=',
    ),
    character => character.charCodeAt(0),
  );
  await c.env.PHOTO_BUCKET.put(
    'demo-photo',
    await encryptPhoto(bytes, key, assetId),
  );
  await db.insert(schema.productAssets).values({
    id: assetId,
    ownerId: 'demo-admin',
    draftId: 'seed',
    kind: 'photo',
    objectKey: 'demo-photo',
    encryptionKey: key,
    contentType: 'image/png',
    references: ['catalog:1', 'catalog:2'],
    status: 'active',
    revision: 1,
  });
  await db.insert(schema.productsTable).values([
    {
      id: 1,
      name: 'Mapped bracket',
      description: 'Ready local demo product',
      image: `/catalog/assets/${assetId}/image`,
      imageGallery: JSON.stringify([`/catalog/assets/${assetId}/image`]),
      stl: `${new URL(c.req.url).origin}/provider/files/22222222-2222-4222-8222-222222222222.stl`,
      publicFileServiceId: '22222222-2222-4222-8222-222222222222',
      price: 3,
      markupPercentage: 50,
      inPersonPrice: 1200,
      filamentType: 'PLA',
      color: 'Black',
      skuNumber: 'DEMO-001',
      squareRevision: 1,
    },
    {
      id: 2,
      name: 'Legacy bracket',
      description: 'Unmapped product with unknown markup',
      image: `/catalog/assets/${assetId}/image`,
      imageGallery: '[]',
      stl: `${new URL(c.req.url).origin}/provider/files/22222222-2222-4222-8222-222222222222.stl`,
      publicFileServiceId: '22222222-2222-4222-8222-222222222222',
      price: 9,
      markupPercentage: null,
      inPersonPrice: 750,
      filamentType: 'PLA',
      color: 'Black',
      skuNumber: 'DEMO-LEGACY',
      squareRevision: 0,
    },
  ]);
  await db.insert(schema.productsToCategories).values(
    [1, 2].map(productId => ({
      productId,
      categoryId: 1,
      createdAt: new Date().toISOString(),
    })),
  );
  await db.insert(schema.squareCatalogMappings).values({
    id: 'demo-mapping',
    productId: 1,
    catalogId: 1,
    environment: 'sandbox',
    merchantId: 'merchant-demo',
    locationId: 'location-demo',
    itemId: 'square-demo-item',
    variationId: 'square-demo-variation',
    generation: 1,
    published: 1,
  });
  return c.json({ seeded: true, mappedProductId: 1, legacyProductId: 2 });
});
app
  .route('/admin/product-drafts', drafts)
  .route('/', products)
  .route('/', photos)
  .route('/', squareCatalog);
/** Supplies bounded deterministic interpretation dependencies only to this fixture worker. */
export default {
  fetch(request: Request, env: Bindings, context: ExecutionContext) {
    const ledger = {
      async admit() {
        return true;
      },
      async reserve() {
        return { status: 'reserved', id: 'demo-reservation' };
      },
      async settle() {
        return 0;
      },
    };
    const fixtureEnv = {
      ...env,
      AGENT_ENABLED: 'true',
      AGENT_PRICE_VERSION: PRICE.version,
      SHOPPING_LEDGER: {
        idFromName() {
          return 'demo-ledger';
        },
        get() {
          return ledger;
        },
      },
      AI: {
        async run(
          _model: string,
          payload: { messages: { content: string }[] },
        ) {
          const context = JSON.parse(payload.messages[1].content) as {
            target: { kind: string };
          };
          const message = payload.messages.at(-1)?.content ?? '';
          let corrections: Record<string, unknown> = {};
          let scope = 'ambiguous';
          let intent = context.target.kind === 'new' ? 'create' : 'update';
          try {
            corrections = JSON.parse(message) as Record<string, unknown>;
            scope = 'same';
          } catch {
            if (message === 'Delete this product') {
              scope = 'same';
              intent = 'delete';
            }
          }
          return {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({ scope, intent, corrections }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          };
        },
      },
    } as unknown as Bindings;
    return app.fetch(request, fixtureEnv, context);
  },
};
