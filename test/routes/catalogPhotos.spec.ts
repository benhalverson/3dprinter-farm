import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, expect, test, vi } from 'vitest';
import catalogPhotos from '../../src/routes/catalogPhotos';
import { encryptPhoto } from '../../src/modules/productPhotoBytes';
import { mockEnv } from '../mocks/env';

const path = '/catalog/assets/photo/image';
const asset = {
  id: 'photo',
  kind: 'photo',
  status: 'active',
  objectKey: 'encrypted/photo',
  contentType: 'image/png',
  encryptionKey: 'ab'.repeat(32),
};
let currentAsset: typeof asset | undefined;
let products: { image: string | null; imageGallery: string | null }[];
const bucket = vi.fn();
const bindings = { ...mockEnv(), PHOTO_BUCKET: { get: bucket } };
beforeEach(() => {
  currentAsset = { ...asset };
  products = [];
  bucket.mockReset();
  vi.mocked(drizzle).mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => currentAsset,
          all: async () => products,
        }),
      }),
    }),
  } as unknown as ReturnType<typeof drizzle>);
});

test('draft-only and partial gallery matches cannot expose storage', async () => {
  products = [
    { image: null, imageGallery: JSON.stringify([`${path}-private`]) },
  ];
  expect((await catalogPhotos.request(path, {}, bindings)).status).toBe(404);
  expect(bucket).not.toHaveBeenCalled();
});

test.each([
  'primary',
  'gallery',
])('decrypts currently referenced %s image without owner authentication', async placement => {
  products = [
    {
      image: placement === 'primary' ? path : null,
      imageGallery: placement === 'gallery' ? JSON.stringify([path]) : null,
    },
  ];
  const plain = new Uint8Array([1, 2, 3]);
  const encrypted = await encryptPhoto(plain, asset.encryptionKey, asset.id);
  bucket.mockResolvedValue({ arrayBuffer: async () => encrypted.buffer });
  const response = await catalogPhotos.request(path, {}, bindings);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(plain);
  expect(bucket).toHaveBeenCalledWith(asset.objectKey);
});

test('removed catalog reference and inactive asset cannot expose bytes', async () => {
  products = [{ image: path, imageGallery: null }];
  currentAsset = undefined;
  expect((await catalogPhotos.request(path, {}, bindings)).status).toBe(404);
  expect(bucket).not.toHaveBeenCalled();
});

test('failed decrypt returns a sanitized error', async () => {
  products = [{ image: path, imageGallery: null }];
  bucket.mockResolvedValue({
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  });
  const response = await catalogPhotos.request(path, {}, bindings);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Photo unavailable' });
});

test.each([
  'deleting',
  'deleted',
])('does not expose a %s asset', async status => {
  products = [{ image: path, imageGallery: null }];
  currentAsset = { ...asset, status };
  expect((await catalogPhotos.request(path, {}, bindings)).status).toBe(404);
  expect(bucket).not.toHaveBeenCalled();
});
