import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import {
  ordersTable,
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
export async function reserveCatalogAssetReferences(
  db: Database,
  input: unknown,
  reference: string,
  reserved: string[],
) {
  const serialized = JSON.stringify(input);
  if (
    !serialized.includes('/attachments/') &&
    !serialized.includes('product-drafts/')
  )
    return;
  const assets = await db.select().from(productAssets).all();
  for (const asset of assets) {
    if (
      serialized.includes(asset.objectKey) ||
      serialized.includes(asset.id) ||
      (asset.providerId && serialized.includes(asset.providerId))
    ) {
      await reserveAssetReference(db, asset.id, reference);
      reserved.push(asset.id);
    }
  }
}
async function releaseCatalogReservations(
  db: Database,
  reserved: string[],
  reference: string,
) {
  for (const id of reserved) {
    const asset = await readAsset(db, id);
    if (asset && asset.status === 'active')
      await changeAsset(db, asset, {
        references: asset.references.filter(item => item !== reference),
      });
  }
}
export async function reservePendingOrderAssets(db: Database, input: unknown) {
  const reference = `order-attempt:${crypto.randomUUID()}`;
  const reserved: string[] = [];
  const serialized = JSON.stringify(input);
  try {
    for (const asset of await db.select().from(productAssets).all()) {
      if (
        serialized.includes(asset.id) ||
        serialized.includes(asset.objectKey) ||
        Boolean(asset.providerId && serialized.includes(asset.providerId)) ||
        Boolean(asset.fileUrl && serialized.includes(asset.fileUrl))
      ) {
        await reserveAssetReference(db, asset.id, reference);
        reserved.push(asset.id);
      }
    }
  } catch (error) {
    await releaseCatalogReservations(db, reserved, reference);
    throw error;
  }
  return () => releaseCatalogReservations(db, reserved, reference);
}
export const reserveCatalogAssets = createMiddleware<WorkerEnv>(
  async (c, next) => {
    const reference = `catalog-attempt:${crypto.randomUUID()}`;
    const reserved: string[] = [];
    try {
      await reserveCatalogAssetReferences(
        c.var.db,
        await c.req.json(),
        reference,
        reserved,
      );
    } catch (error) {
      await releaseCatalogReservations(c.var.db, reserved, reference);
      if (error instanceof AttachmentError)
        return c.json({ error: error.message }, error.status);
      return c.json({ error: 'Could not reserve attachment references' }, 400);
    }
    await next();
    // Successful writes now have real catalog references; known 4xx rejection
    // made no catalog mutation. Unknown 5xx outcomes retain only this attempt.
    if (c.res.status < 500)
      await releaseCatalogReservations(c.var.db, reserved, reference);
  },
);
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
  const products = await db.select().from(productsTable).all();
  const orders = await db.select().from(ordersTable).all();
  const drafts = await db
    .select()
    .from(productDrafts)
    .where(eq(productDrafts.status, 'active'))
    .all();
  const serialized = JSON.stringify({
    products,
    orders,
    drafts: drafts.filter(draft => draft.id !== asset.draftId),
  });
  return (
    serialized.includes(asset.id) ||
    serialized.includes(asset.objectKey) ||
    Boolean(asset.providerId && serialized.includes(asset.providerId)) ||
    Boolean(asset.fileUrl && serialized.includes(asset.fileUrl))
  );
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
