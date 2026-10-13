import type { Context } from 'hono';
import type { WorkerEnv } from '../factory';
import { AttachmentError } from '../modules/productAssets';
import {
  boundedBytes,
  detectPhoto,
  photoContentType,
} from '../modules/productPhotoBytes';


/** Require a configured public bucket URL instead of inventing an API asset route. */
function publicBase(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Store legacy public uploads with byte-verified photo MIME and unique photo keys. */
export async function uploadPublicFile(c: Context<WorkerEnv>) {
  let file: File;
  try {
    const body = await c.req.parseBody();
    if (!(body.file instanceof File)) {
      return c.json({ error: 'Select a file to upload' }, 400);
    }
    file = body.file;
  } catch {
    return c.json({ error: 'Invalid upload form' }, 400);
  }

  try {
    const signature = photoContentType(
      new Uint8Array(await file.slice(0, 12).arrayBuffer()),
    );
    const photo =
      signature !== null ||
      file.type.startsWith('image/') ||
      /\.(jpe?g|png|webp)$/i.test(file.name);
    const stl = file.type === 'model/stl' || /\.stl$/i.test(file.name);
    if (!photo && !stl) {
      return c.json({ error: 'Select a JPEG, PNG, WebP, or STL file' }, 415);
    }
    const base = publicBase(
      photo ? c.env.R2_PHOTO_BASE_URL : c.env.R2_PUBLIC_BASE_URL,
    );
    if (!base) {
      return c.json({ error: 'Public upload storage is not configured' }, 503);
    }
    if (photo) {
      const bytes = await boundedBytes(file.stream());
      const contentType = await detectPhoto(bytes);
      const extension =
        contentType === 'image/jpeg' ? 'jpg' : contentType.slice(6);
      const key = `${crypto.randomUUID()}.${extension}`;
      const stored = await c.env.PHOTO_BUCKET.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType },
      });
      if (!stored) throw new Error('Photo identity already exists');
      return c.json({ message: 'File uploaded', key, url: `${base}/${key}` });
    }
    const ownerId = c.get('userId');
    if (!ownerId) return c.json({ error: 'Unauthorized' }, 401);
    const key = `users/${encodeURIComponent(ownerId)}/${crypto.randomUUID()}.stl`;
    const stored = await c.env.BUCKET.put(key, file.stream(), {
      onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { ownerId },
      httpMetadata: { contentType: 'model/stl' },
    });
    if (!stored) return c.json({ error: 'Upload identity conflict; retry upload' }, 409);
    return c.json({
      message: 'File uploaded',
      key,
      url: `${base}/${encodeURIComponent(key)}`,
    });
  } catch (error) {
    if (error instanceof AttachmentError) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({ error: 'Failed to upload file' }, 500);
  }
}
