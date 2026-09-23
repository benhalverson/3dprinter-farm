import { and, eq, like, ne, or } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import {
  ordersTable,
  productAssetReferenceAttempts,
  productAssets,
  productDrafts,
  productsTable,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import { deleteSlant3DFile } from '../lib/slant3d-v2-files';
import type { Bindings } from '../types';

type Database = WorkerEnv['Variables']['db'];
export type Asset = typeof productAssets.$inferSelect;
export class AttachmentError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
export function assetKey(id: string) {
  return `product-drafts/${id}`;
}
export function readAsset(db: Database, id: string) {
  return db.select().from(productAssets).where(eq(productAssets.id, id)).get();
}
export async function changeAsset(
  db: Database,
  asset: Asset,
  changes: Partial<Asset>,
) {
  const [updated] = await db
    .update(productAssets)
    .set({ ...changes, revision: asset.revision + 1 })
    .where(
      and(
        eq(productAssets.id, asset.id),
        eq(productAssets.revision, asset.revision),
        eq(productAssets.status, asset.status),
      ),
    )
    .returning();
  if (!updated)
    throw new AttachmentError(409, 'Asset changed; retry after reloading');
  return updated;
}
export async function reserveAssetReference(
  db: Database,
  assetId: string,
  reference: string,
) {
  const asset = await readAsset(db, assetId);
  if (!asset || asset.status !== 'active')
    throw new AttachmentError(
      409,
      'Asset is unavailable or cleanup has claimed it',
    );
  return changeAsset(db, asset, {
    references: [...new Set([...asset.references, reference])],
  });
}
// Extract only identity-bearing fields. Descriptions and unrelated text are never
// interpreted as references.
export function attachmentIdentities(input: unknown): string[] {
  if (Array.isArray(input)) return input.flatMap(attachmentIdentities);
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  return [
    'assetId',
    'objectKey',
    'publicFileServiceId',
    'stl',
    'fileURL',
    'fileUrl',
    'image',
    'productImage',
    'imageGallery',
  ].flatMap(key => {
    const value = record[key];
    const strings = Array.isArray(value) ? value : [value];
    return strings
      .filter((item): item is string => typeof item === 'string')
      .flatMap(value => {
        const identity = value.trim();
        const match = identity.match(
          /(?:^|\/)attachments\/([^/?#]+)\/image(?:[?#]|$)/,
        );
        return match ? [identity, match[1]] : [identity];
      });
  });
}
export async function findAssets(db: Database, identities: string[]) {
  const found = new Map<string, Asset>();
  for (const identity of new Set(identities)) {
    const rows = await db
      .select()
      .from(productAssets)
      .where(
        or(
          eq(productAssets.id, identity),
          eq(productAssets.objectKey, identity),
          eq(productAssets.providerId, identity),
          eq(productAssets.fileUrl, identity),
        ),
      )
      .all();
    for (const asset of rows) found.set(asset.id, asset);
  }
  return [...found.values()];
}
export async function validateCatalogImages(
  db: Database,
  input: {
    image: string;
    imageGallery?: string[];
  },
) {
  for (const [field, values] of [
    ['image', [input.image]],
    ['imageGallery', input.imageGallery ?? []],
  ] as const) {
    for (const value of values) {
      const identities = attachmentIdentities({ image: value });
      if (
        /(?:^|\/)product-drafts\//.test(value.trim()) ||
        (await findAssets(db, identities)).some(asset => asset.kind === 'photo')
      )
        throw new AttachmentError(
          400,
          `${field}: private draft photos cannot be used as catalog images`,
        );
    }
  }
}

type ReferenceAttempt = typeof productAssetReferenceAttempts.$inferSelect;
async function readAttempt(db: Database, id: string) {
  return db
    .select()
    .from(productAssetReferenceAttempts)
    .where(eq(productAssetReferenceAttempts.id, id))
    .get();
}
async function releaseAttempt(db: Database, attempt: ReferenceAttempt) {
  if (attempt.state !== 'release_pending') return;
  let complete = true;
  for (const id of attempt.assetIds) {
    let released = false;
    for (let retry = 0; retry < 3; retry++) {
      try {
        const asset = await readAsset(db, id);
        if (!asset) break;
        if (asset.references.includes(attempt.id)) {
          await changeAsset(db, asset, {
            references: asset.references.filter(item => item !== attempt.id),
          });
        }
        released = true;
        break;
      } catch (error) {
        if (!(error instanceof AttachmentError) || error.status !== 409) break;
      }
    }
    if (!released) complete = false;
  }
  if (complete)
    await db
      .update(productAssetReferenceAttempts)
      .set({ state: 'released', updatedAt: Date.now() })
      .where(
        and(
          eq(productAssetReferenceAttempts.id, attempt.id),
          eq(productAssetReferenceAttempts.state, 'release_pending'),
        ),
      )
      .returning();
}
async function finishReferenceAttempt(db: Database, id: string) {
  try {
    const [attempt] = await db
      .update(productAssetReferenceAttempts)
      .set({ state: 'release_pending', updatedAt: Date.now() })
      .where(
        and(
          eq(productAssetReferenceAttempts.id, id),
          eq(productAssetReferenceAttempts.state, 'unresolved'),
        ),
      )
      .returning();
    const current = attempt ?? (await readAttempt(db, id));
    if (current) await releaseAttempt(db, current);
  } catch {
    // Bookkeeping cannot undo an established downstream result. Durable intent
    // and reservations remain discoverable; uncertainty never permits deletion.
  }
}
export async function reserveAssetAttempt(
  db: Database,
  assets: Asset[],
  kind: 'catalog' | 'order',
) {
  const reference = `${kind}-attempt:${crypto.randomUUID()}`;
  if (assets.length) {
    const now = Date.now();
    await db
      .insert(productAssetReferenceAttempts)
      .values({
        id: reference,
        assetIds: assets.map(asset => asset.id),
        state: 'unresolved',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    try {
      for (const asset of assets)
        await reserveAssetReference(db, asset.id, reference);
    } catch (error) {
      await finishReferenceAttempt(db, reference);
      throw error;
    }
  }
  return async () => {
    if (assets.length) await finishReferenceAttempt(db, reference);
  };
}
export async function reservePendingOrderAssets(db: Database, input: unknown) {
  return reserveAssetAttempt(
    db,
    await findAssets(db, attachmentIdentities(input)),
    'order',
  );
}
// Mounted after authentication and payload validation on V2 mutations only.
export const reserveCatalogAssets = createMiddleware<WorkerEnv>(
  async (c, next) => {
    let release: () => Promise<void>;
    try {
      const input = await c.req.json<{
        id: number;
        image: string;
        imageGallery?: string[];
        publicFileServiceId?: string;
      }>();
      await validateCatalogImages(c.var.db, input);
      let printIdentity = input.publicFileServiceId;
      let stl: string | undefined;
      if (c.req.method === 'PUT') {
        const product = await c.var.db
          .select()
          .from(productsTable)
          .where(eq(productsTable.id, input.id))
          .get();
        if (!product) return c.json({ error: 'Product not found' }, 404);
        printIdentity = product.publicFileServiceId ?? undefined;
        stl = product.stl;
      }
      release = await reserveAssetAttempt(
        c.var.db,
        await findAssets(
          c.var.db,
          attachmentIdentities({
            image: input.image,
            imageGallery: input.imageGallery,
            publicFileServiceId: printIdentity,
            stl,
          }),
        ),
        'catalog',
      );
    } catch (error) {
      if (error instanceof AttachmentError)
        return c.json({ error: error.message }, error.status);
      return c.json({ error: 'Could not reserve attachment references' }, 500);
    }
    await next();
    if (c.res.status < 500) await release();
  },
);
export async function retryAssetReleases(db: Database, assets: Asset[]) {
  const attempted = new Set<string>();
  for (const asset of assets) {
    const attempts = await db
      .select()
      .from(productAssetReferenceAttempts)
      .where(
        and(
          eq(productAssetReferenceAttempts.state, 'release_pending'),
          like(productAssetReferenceAttempts.assetIds, `%"${asset.id}"%`),
        ),
      )
      .all();
    for (const attempt of attempts) {
      if (attempted.has(attempt.id)) continue;
      attempted.add(attempt.id);
      try {
        await releaseAttempt(db, attempt);
      } catch {
        // Continue other attempts; a failed record update remains pending.
      }
    }
  }
}
export async function assetCleanupPending(db: Database, asset: Asset) {
  if (
    asset.references.some(
      ref =>
        ref.startsWith('transfer:') ||
        ref.startsWith('catalog-attempt:') ||
        ref.startsWith('order-attempt:') ||
        ref.startsWith('unresolved:'),
    )
  )
    return true;
  return Boolean(
    await db
      .select({ id: productAssetReferenceAttempts.id })
      .from(productAssetReferenceAttempts)
      .where(
        and(
          ne(productAssetReferenceAttempts.state, 'released'),
          like(productAssetReferenceAttempts.assetIds, `%"${asset.id}"%`),
        ),
      )
      .get(),
  );
}
export async function ensureAsset(db: Database, asset: Asset) {
  await db.insert(productAssets).values(asset).onConflictDoNothing();
  const existing = await readAsset(db, asset.id);
  if (
    !existing ||
    existing.draftId !== asset.draftId ||
    existing.ownerId !== asset.ownerId ||
    existing.objectKey !== asset.objectKey ||
    !existing.references.includes(asset.references[1])
  ) {
    throw new AttachmentError(409, 'Asset identity collision');
  }
  return existing;
}
async function hasLegacyReference(db: Database, asset: Asset) {
  const identities = [
    asset.id,
    asset.objectKey,
    asset.providerId,
    asset.fileUrl,
  ].filter((value): value is string => Boolean(value));
  // Existence queries select only an id and stop at the first match; JSON legacy
  // fields remain conservatively checked without a row cap or whole-table load.
  for (const identity of identities) {
    const pattern = `%${identity}%`;
    if (
      await db
        .select({ id: productsTable.id })
        .from(productsTable)
        .where(
          or(
            eq(productsTable.image, identity),
            eq(productsTable.stl, identity),
            eq(productsTable.publicFileServiceId, identity),
            like(productsTable.stl, pattern),
            like(productsTable.image, pattern),
            like(productsTable.imageGallery, pattern),
          ),
        )
        .get()
    )
      return true;
    if (
      await db
        .select({ id: ordersTable.id })
        .from(ordersTable)
        .where(
          or(
            eq(ordersTable.fileURL, identity),
            like(ordersTable.fileURL, pattern),
            like(ordersTable.itemSnapshot, pattern),
          ),
        )
        .get()
    )
      return true;
    if (
      await db
        .select({ id: productDrafts.id })
        .from(productDrafts)
        .where(
          and(
            eq(productDrafts.status, 'active'),
            ne(productDrafts.id, asset.draftId),
            or(
              like(productDrafts.state, pattern),
              like(productDrafts.attachments, pattern),
            ),
          ),
        )
        .get()
    )
      return true;
  }
  return false;
}
export async function cleanupAsset(
  db: Database,
  env: Bindings,
  assetId: string,
) {
  let asset = await readAsset(db, assetId);
  if (!asset)
    return {
      status: 'pending' as const,
      reason: 'Asset recovery record is not available',
    };
  if (asset.status === 'deleted')
    return { status: 'deleted' as const, reason: null };
  if (await assetCleanupPending(db, asset))
    return {
      status: 'pending' as const,
      reason: 'Unfinished transfer or reference release; retry cleanup',
    };
  if (asset.references.length || (await hasLegacyReference(db, asset))) {
    return {
      status: 'protected' as const,
      reason:
        'Retained draft, catalog, order, or unresolved operation references this asset',
    };
  }
  const storageId = asset.kind === 'print' ? asset.providerId : asset.objectKey;
  if (!storageId)
    return {
      status: 'pending' as const,
      reason: 'File storage identity is not available; retry cleanup',
    };
  // Reservations CAS the same row and require active: once claimed, reference
  // creation fails. Retrying an interrupted delete keeps the claim closed.
  if (asset.status === 'active')
    asset = await changeAsset(db, asset, { status: 'deleting' });
  try {
    if (asset.kind === 'print') await deleteSlant3DFile(env, storageId);
    else await env.PHOTO_BUCKET.delete(storageId);
    await changeAsset(db, asset, { status: 'deleted' });
    return { status: 'deleted' as const, reason: null };
  } catch {
    return {
      status: 'pending' as const,
      reason: `${asset.kind === 'print' ? 'Slant3D file' : 'Photo'} cleanup failed; retry cleanup`,
    };
  }
}
