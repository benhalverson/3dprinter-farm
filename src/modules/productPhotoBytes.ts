import { PhotonImage } from '@cf-wasm/photon/workerd';
import { AttachmentError } from './productAssets';

export const MAX_PHOTO_BYTES = 5_000_000;
export async function boundedBytes(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) throw new AttachmentError(400, 'Select a nonempty photo');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_PHOTO_BYTES)
        throw new AttachmentError(400, 'Photo exceeds 5,000,000 bytes');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function detectPhoto(bytes: Uint8Array) {
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  const contentType = header.startsWith('\x89PNG\r\n\x1a\n')
    ? 'image/png'
    : header.startsWith('\xff\xd8\xff')
      ? 'image/jpeg'
      : header.startsWith('RIFF') && header.endsWith('WEBP')
        ? 'image/webp'
        : null;
  if (!contentType)
    throw new AttachmentError(400, 'Select a JPEG, PNG, or WebP image');
  try {
    const decoded = PhotonImage.new_from_byteslice(bytes);
    decoded.free();
  } catch {
    throw new AttachmentError(
      400,
      'Photo content cannot be decoded; select a complete image',
    );
  }
  return contentType;
}
export function newPhotoKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
async function photoKey(secret: string) {
  const bytes = Uint8Array.from(secret.match(/../g)!, byte =>
    Number.parseInt(byte, 16),
  );
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
export async function encryptPhoto(
  bytes: Uint8Array,
  secret: string,
  id: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) },
    await photoKey(secret),
    bytes,
  );
  const stored = new Uint8Array(iv.length + encrypted.byteLength);
  stored.set(iv);
  stored.set(new Uint8Array(encrypted), iv.length);
  return stored;
}
export async function decryptPhoto(
  bytes: ArrayBuffer,
  secret: string,
  id: string,
) {
  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(id),
    },
    await photoKey(secret),
    bytes.slice(12),
  );
}
