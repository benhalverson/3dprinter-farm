import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  batchGetSlant3DFiles,
  createSlant3DDirectUpload,
  deleteSlant3DFile,
  Slant3DFileApiError,
} from '../../src/lib/slant3d-v2-files';
import { mockEnv } from '../mocks/env';

describe('Slant3D file deletion', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it('uses the authenticated DELETE endpoint and accepts its success envelope without a data field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: true, message: 'File deleted' }),
    );
    await expect(
      deleteSlant3DFile(mockEnv(), 'file/id?#'),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://slant3dapi.com/v2/api/files/file%2Fid%3F%23',
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer fake-api-key-v2' },
      },
    );
  });

  it('rejects missing credentials without a provider request', async () => {
    await expect(
      deleteSlant3DFile({ ...mockEnv(), SLANT_API_V2: '' }, 'file'),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    '{}',
    'null',
    '{"success":false}',
    '{"success":"true"}',
    'not json',
    '',
  ])('does not accept an ambiguous acknowledgement: %s', async body => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body));
    await expect(deleteSlant3DFile(mockEnv(), 'file')).rejects.toThrow();
  });

  it('does not mark an accepted but unfinished deletion complete', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: true }, { status: 202 }),
    );
    await expect(deleteSlant3DFile(mockEnv(), 'file')).rejects.toMatchObject({
      status: 502,
    });
  });

  it.each([
    401, 403, 429, 500, 503,
  ])('propagates HTTP %s without treating the file as deleted', async status => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: false }, { status }),
    );
    await expect(deleteSlant3DFile(mockEnv(), 'file')).rejects.toMatchObject({
      status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error('Connection lost'),
    'Connection lost',
  ])('retains network errors for retry', async cause => {
    vi.mocked(fetch).mockRejectedValueOnce(cause);
    await expect(deleteSlant3DFile(mockEnv(), 'file')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('confirms absence after an interrupted deletion returns 404', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ message: 'File not found' }, { status: 404 }),
      );
    await expect(deleteSlant3DFile(mockEnv(), 'file')).resolves.toBeUndefined();
    expect(
      vi.mocked(fetch).mock.calls.map(([, options]) => options?.method),
    ).toEqual(['DELETE', 'GET']);
  });

  it('does not interpret an unavailable DELETE route as a deleted file', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ success: true, data: { publicFileServiceId: 'file' } }),
      );
    await expect(deleteSlant3DFile(mockEnv(), 'file')).rejects.toMatchObject({
      status: 404,
    });
  });

  it.each([
    403, 503,
  ])('keeps cleanup pending when absence verification fails with %s', async status => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(Response.json({}, { status }));
    await expect(deleteSlant3DFile(mockEnv(), 'file')).rejects.toMatchObject({
      status,
    });
  });

  it('preserves the provider status when its error body cannot be read', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('Response interrupted'));
          },
        }),
        { status: 503 },
      ),
    );
    await expect(deleteSlant3DFile(mockEnv(), 'file')).rejects.toMatchObject({
      status: 503,
      details: {},
    });
  });

  it('handles a lightweight error response with no body methods', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);
    await expect(deleteSlant3DFile(mockEnv(), 'file')).rejects.toMatchObject({
      status: 503,
      details: {},
    });
  });

  it('requires a platform before requesting an upload', async () => {
    await expect(
      createSlant3DDirectUpload(
        { ...mockEnv(), SLANT_PLATFORM_ID: '' },
        { name: 'part.stl', ownerId: 'owner' },
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the existing batch lookup binding', async () => {
    const files = [{ publicFileServiceId: 'file' }];
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: files }));
    await expect(batchGetSlant3DFiles(mockEnv(), ['file'])).resolves.toEqual(
      files,
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://slant3dapi.com/v2/api/files/batch',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer fake-api-key-v2',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ publicFileServiceIds: ['file'] }),
      },
    );
  });

  it('does not confuse an unreadable lookup response with absence', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(new Response('not json'));
    await expect(
      deleteSlant3DFile(mockEnv(), 'file'),
    ).rejects.not.toBeInstanceOf(Slant3DFileApiError);
  });
});
