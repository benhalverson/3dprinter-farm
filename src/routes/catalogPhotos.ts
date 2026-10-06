import { and, eq, like, or } from 'drizzle-orm';
import { productAssets, productsTable } from '../db/schema';
import factory from '../factory';
import { decryptPhoto } from '../modules/productPhotoBytes';

/** Only current catalog references make an encrypted draft asset publicly readable. */
const catalogPhotos = factory
  .createApp()
  .get('/catalog/assets/:id/image', async c => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const id = c.req.param('id');
    const path = `/catalog/assets/${encodeURIComponent(id)}/image`;
    const asset = await c.var.db
      .select()
      .from(productAssets)
      .where(
        and(
          eq(productAssets.id, id),
          eq(productAssets.kind, 'photo'),
          eq(productAssets.status, 'active'),
        ),
      )
      .get();
    if (
      !asset ||
      asset.kind !== 'photo' ||
      asset.status !== 'active' ||
      !asset.contentType ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(
        asset.contentType ?? '',
      )
    )
      return c.json({ error: 'Photo not found' }, 404);
    const products = await c.var.db
      .select({
        image: productsTable.image,
        imageGallery: productsTable.imageGallery,
      })
      .from(productsTable)
      .where(
        or(
          eq(productsTable.image, path),
          // D1 limits LIKE pattern length. Match the bounded asset identity here,
          // then verify the complete URL in the parsed gallery below.
          like(productsTable.imageGallery, `%${asset.id}%`),
        ),
      )
      .all();
    const referenced = products.some(product => {
      if (product.image === path) return true;
      try {
        const gallery: unknown = JSON.parse(product.imageGallery ?? 'null');
        return Array.isArray(gallery) && gallery.includes(path);
      } catch {
        return false;
      }
    });
    if (!referenced) return c.json({ error: 'Photo not found' }, 404);
    try {
      const object = await c.env.PHOTO_BUCKET.get(asset.objectKey);
      if (!object) return c.json({ error: 'Photo not found' }, 404);
      const bytes = await decryptPhoto(
        await object.arrayBuffer(),
        asset.encryptionKey,
        asset.id,
      );
      return c.body(bytes, 200, { 'Content-Type': asset.contentType });
    } catch {
      return c.json({ error: 'Photo unavailable' }, 503);
    }
  });

export default catalogPhotos;
