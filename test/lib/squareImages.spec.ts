import { beforeEach, expect, test, vi } from 'vitest';
import { productPhotoBase64 } from '../fixtures/productPhotoBytes';
import { squareClient } from '../../src/lib/square';

const config = {
  SQUARE_ENVIRONMENT: 'sandbox' as const,
  SQUARE_ACCESS_TOKEN: 'test-token',
  SQUARE_MERCHANT_ID: 'merchant',
  SQUARE_LOCATION_ID: 'location',
};
const image = {
  type: 'IMAGE',
  id: 'IMAGE123',
  version: 10,
  image_data: { url: 'https://example.com/image.png' },
};
beforeEach(() => vi.mocked(fetch).mockReset());

test('uploads exact metadata and bytes without overriding multipart boundary', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ image })));
  const metadata = JSON.stringify({
    idempotency_key: 'stable',
    object_id: 'item',
    image: { type: 'IMAGE', id: '#image' },
    is_primary: true,
  });
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  expect(
    await squareClient(config).createImage(metadata, bytes, 'image/png'),
  ).toEqual(image);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('https://connect.squareupsandbox.com/v2/catalog/images');
  expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
  const form = init?.body as FormData;
  expect(form.get('request')).toBe(metadata);
  const file = form.get('file') as File;
  expect(file.type).toBe('image/png');
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(
    new Uint8Array(bytes),
  );
});

test.each([
  { ...image, id: '#image' },
  { ...image, version: undefined },
  { ...image, is_deleted: true },
  { ...image, image_data: { url: 'invalid' } },
])('rejects unconfirmed image response', async invalid => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ image: invalid })),
  );
  await expect(
    squareClient(config).createImage(
      '{}',
      new Uint8Array([1]).buffer,
      'image/png',
    ),
  ).rejects.toEqual({
    kind: 'square_failure',
    code: 'square_invalid_response',
    uncertain: true,
  });
});

test('rejects malformed WebP before provider writes and sanitizes provider errors', async () => {
  await expect(
    squareClient(config).createImage(
      '{}',
      new Uint8Array([1]).buffer,
      'image/webp',
    ),
  ).rejects.toMatchObject({
    code: 'square_request_rejected',
    uncertain: false,
  });
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValue(
    new Response('secret-provider-detail', { status: 500 }),
  );
  await expect(
    squareClient(config).createImage(
      '{}',
      new Uint8Array([1]).buffer,
      'image/png',
    ),
  ).rejects.toEqual({
    kind: 'square_failure',
    code: 'square_request_rejected',
    uncertain: true,
  });
});

test('converts real WebP to deterministic PNG without changing source bytes', async () => {
  const bytes = Uint8Array.from(atob(productPhotoBase64['image/webp']), c =>
    c.charCodeAt(0),
  );
  const original = bytes.slice();
  const uploads: Uint8Array[] = [];
  for (let i = 0; i < 2; i++) {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ image })),
    );
    await squareClient(config).createImage('{}', bytes.buffer, 'image/webp');
    const form = vi.mocked(fetch).mock.calls[i][1]?.body as FormData;
    const file = form.get('file') as File;
    expect(file.type).toBe('image/png');
    uploads.push(new Uint8Array(await file.arrayBuffer()));
  }
  expect(uploads[0].slice(0, 8)).toEqual(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(uploads[0]).toEqual(uploads[1]);
  expect(bytes).toEqual(original);
});
