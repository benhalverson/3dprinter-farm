import { beforeEach, describe, expect, it, vi } from 'vitest';
import printer from '../../src/routes/printer';
import { productPhotoBase64 } from '../fixtures/productPhotoBytes';
import { mockEnv } from '../mocks/env';

const env = mockEnv();
const photoPut = vi.fn();
const stlPut = vi.fn();

/** Exercise the authenticated Hono route with mocked storage only. */
function upload(file: File | string | null, authenticated = true) {
  const body = new FormData();
  if (file !== null) body.set('file', file);
  return printer.request(
    '/upload',
    {
      method: 'POST',
      headers: authenticated
        ? { cookie: 'better-auth.session_token=test' }
        : {},
      body,
    },
    env,
  );
}

/** Decode recorded, browser-generated fixture bytes for real decoder validation. */
function photoBytes(mime: keyof typeof productPhotoBase64) {
  return Uint8Array.from(atob(productPhotoBase64[mime]), byte =>
    byte.charCodeAt(0),
  );
}

beforeEach(() => {
  photoPut.mockReset().mockResolvedValue({ key: 'saved' });
  stlPut.mockReset().mockResolvedValue({ key: 'saved' });
  env.PHOTO_BUCKET = { put: photoPut } as unknown as R2Bucket;
  env.BUCKET = { put: stlPut } as unknown as R2Bucket;
  env.R2_PHOTO_BASE_URL = 'https://photos.example.com';
  env.R2_PUBLIC_BASE_URL = 'https://uploads.example.com';
});

describe('legacy public upload asset contract', () => {
  it.each([
    'image/png',
    'image/jpeg',
    'image/webp',
  ] as const)('stores actual %s bytes with matching metadata despite misleading declarations', async mime => {
    const bytes = photoBytes(mime);
    const response = await upload(
      new File([bytes], 'misleading.stl', { type: 'model/stl' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      key: string;
      url: string;
      message: string;
    };
    const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice(6);
    expect(body.key).toMatch(new RegExp(`^[a-f0-9-]{36}\\.${extension}$`));
    expect(body).toEqual({
      message: 'File uploaded',
      key: body.key,
      url: `https://photos.example.com/${body.key}`,
    });
    expect(photoPut).toHaveBeenCalledWith(body.key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: mime },
    });
    expect(stlPut).not.toHaveBeenCalled();
  });

  it('keeps duplicate photo filenames independent', async () => {
    const file = new File([photoBytes('image/jpeg')], 'product.jpg');
    const first = (await (await upload(file)).json()) as { key: string };
    const second = (await (await upload(file)).json()) as { key: string };
    expect(first.key).not.toBe(second.key);
  });

  it.each([
    null,
    'not a file',
  ])('rejects missing and non-file fields', async file => {
    expect((await upload(file)).status).toBe(400);
    expect(photoPut).not.toHaveBeenCalled();
    expect(stlPut).not.toHaveBeenCalled();
  });

  it.each([
    new File(['text'], 'anything.txt'),
    new File(['<html>error</html>'], 'photo.jpg', { type: 'image/jpeg' }),
    new File([], 'photo.png'),
    new File([photoBytes('image/png').slice(0, 12)], 'photo.png'),
    new File([new Uint8Array(5_000_001)], 'photo.webp'),
    new File(['not a photo'], 'photo.stl', { type: 'image/png' }),
  ])('rejects unsupported or invalid bytes without writing $name', async file => {
    expect([400, 415]).toContain((await upload(file)).status);
    expect(photoPut).not.toHaveBeenCalled();
    expect(stlPut).not.toHaveBeenCalled();
  });

  it('preserves the STL storage contract', async () => {
    const response = await upload(
      new File(['solid test\nendsolid test'], 'Test Model.stl', {
        type: 'model/stl',
      }),
    );
    expect(await response.json()).toEqual({
      message: 'File uploaded',
      key: 'test-model.stl',
      url: 'https://uploads.example.com/test-model.stl',
    });
    expect(stlPut).toHaveBeenCalledWith(
      'test-model.stl',
      expect.any(ReadableStream),
      { httpMetadata: { contentType: 'model/stl' } },
    );
    expect(photoPut).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'invalid',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'https://photos.example.com?x=1',
    'https://photos.example.com#x',
  ])('rejects invalid configured photo URL %s before storage', async base => {
    env.R2_PHOTO_BASE_URL = base;
    expect(
      (await upload(new File([photoBytes('image/png')], 'photo.png'))).status,
    ).toBe(503);
    expect(photoPut).not.toHaveBeenCalled();
  });

  it('does not invent an API URL for unconfigured STL storage', async () => {
    env.R2_PUBLIC_BASE_URL = '';
    expect((await upload(new File(['solid'], 'model.stl'))).status).toBe(503);
    expect(stlPut).not.toHaveBeenCalled();
  });

  it('requires authentication before any upload', async () => {
    expect(
      (await upload(new File([photoBytes('image/png')], 'photo.png'), false))
        .status,
    ).toBe(401);
    expect(photoPut).not.toHaveBeenCalled();
  });

  it('rejects malformed multipart bodies without storage', async () => {
    const response = await printer.request(
      '/upload',
      {
        method: 'POST',
        headers: {
          cookie: 'better-auth.session_token=test',
          'content-type': 'multipart/form-data',
        },
        body: 'missing boundary',
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid upload form' });
    expect(photoPut).not.toHaveBeenCalled();
    expect(stlPut).not.toHaveBeenCalled();
  });

  it('reports failed STL storage without returning an asset URL', async () => {
    stlPut.mockRejectedValue(new Error('private storage details'));
    const response = await upload(new File(['solid'], 'model.stl'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to upload file' });
    expect(photoPut).not.toHaveBeenCalled();
  });

  it.each([
    'collision',
    'unavailable',
  ])('reports storage %s without success', async failure => {
    if (failure === 'collision') photoPut.mockResolvedValue(null);
    else photoPut.mockRejectedValue(new Error('private storage details'));
    const response = await upload(
      new File([photoBytes('image/png')], 'photo.png'),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to upload file' });
    expect(stlPut).not.toHaveBeenCalled();
  });
});
