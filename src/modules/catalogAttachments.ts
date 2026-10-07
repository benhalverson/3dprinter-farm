import { inArray, or, eq } from 'drizzle-orm';
import { productAssets } from '../db/schema';
import type { WorkerEnv } from '../factory';
import { digest } from '../shopping/contracts';
import {
  emptyAttachments,
  type AttachmentState,
} from './productAttachmentState';
import type { SavedAttachment } from './productAttachmentContracts';
export function catalogGallery(
  image: string | null | undefined,
  serialized: string | null | undefined,
) {
  let gallery: string[] = [];
  try {
    const parsed = JSON.parse(serialized || '[]');
    if (Array.isArray(parsed))
      gallery = parsed.filter(
        (value): value is string => typeof value === 'string' && !!value,
      );
  } catch {}
  return [...new Set([...gallery, ...(image ? [image] : [])])];
}
/** Snapshot existing catalog identities; client controls may edit the draft but cannot invent these links. */
export async function catalogAttachments(
  db: WorkerEnv['Variables']['db'],
  product: {
    id: number;
    image: string | null;
    imageGallery?: string[];
    name: string;
  },
): Promise<AttachmentState> {
  const state = emptyAttachments();
  state.catalogHydrated = true;
  const urls = [
    ...new Set([
      ...(product.imageGallery ?? []),
      ...(product.image ? [product.image] : []),
    ]),
  ];
  if (!urls.length) return state;
  const ids = urls.flatMap(
    url =>
      url.match(/\/catalog\/assets\/([^/?#]+)\/image(?:[?#]|$)/)?.[1] ?? [],
  );
  const assets = await db
    .select()
    .from(productAssets)
    .where(
      or(
        ...urls.map(url => eq(productAssets.objectKey, url)),
        ...(ids.length ? [inArray(productAssets.id, ids)] : []),
      ),
    )
    .all();
  for (const [index, url] of urls.entries()) {
    const asset = assets.find(
      asset =>
        asset.kind === 'photo' &&
        (asset.objectKey === url ||
          url.includes(`/catalog/assets/${asset.id}/image`)),
    );
    const hash = await digest(`${product.id}:${url}`);
    const id =
      asset?.id ??
      `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const photo: SavedAttachment = {
      id,
      assetId: id,
      kind: 'photo',
      name: `${product.name} photo ${index + 1}`,
      size: 0,
      contentType: asset?.contentType ?? 'image/unknown',
      status: 'saved',
      imageUrl: url,
      publicFileServiceId: null,
      catalogSource: { productId: product.id, url, managed: !!asset },
    };
    state.photos.push(photo);
    state.photoOrder.push(id);
    if (url === product.image) state.primaryPhotoId = id;
  }
  state.primaryExplicit = !!state.primaryPhotoId;
  return state;
}
