/** Deterministic, entirely local provider boundary for the admin demonstration. */
export const DEMO_FILAMENT_ID = '11111111-1111-4111-8111-111111111111';
export const DEMO_FILE_ID = '22222222-2222-4222-8222-222222222222';
export const DEMO_SQUARE_ITEM_ID = 'square-demo-item';
export const DEMO_SQUARE_VARIATION_ID = 'square-demo-variation';
export const DEMO_MERCHANT_ID = 'merchant-demo';
export const DEMO_LOCATION_ID = 'location-demo';
type JsonObject = Record<string, unknown>;
const localOrigin = 'http://localhost:8790';
const timestamp = '2026-10-06T12:00:00.000Z';
export const providerState = {
  origin: localOrigin,
  loseNextUpsertResponse: false,
  requests: [] as { method: string; url: string }[],
  files: new Map<string, JsonObject>(),
  items: new Map<string, JsonObject>(),
  replays: new Map<string, JsonObject>(),
  uploads: new Set<string>(),
  nextFile: 1,
  nextItem: 1,
  nextImage: 1,
};
function file(id: string, name = 'demo.stl', origin = localOrigin): JsonObject {
  return {
    publicFileServiceId: id,
    name,
    ownerId: 'demo-admin',
    platformId: 'demo-platform',
    type: 'STL',
    fileURL: `${origin}/provider/files/${id}.stl`,
    STLMetrics: {
      dimensionX: 20,
      dimensionY: 20,
      dimensionZ: 20,
      volume: 8,
      weight: 10,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
/** Resets provider state between demonstrations without making external requests. */
export function resetProviders(state = providerState): void {
  state.requests.length = 0;
  state.loseNextUpsertResponse = false;
  state.files.clear();
  state.items.clear();
  state.replays.clear();
  state.uploads.clear();
  state.nextFile = state.nextItem = state.nextImage = 1;
  state.files.set(DEMO_FILE_ID, file(DEMO_FILE_ID, 'demo.stl', state.origin));
  state.items.set(DEMO_SQUARE_ITEM_ID, {
    type: 'ITEM',
    id: DEMO_SQUARE_ITEM_ID,
    version: 1,
    present_at_all_locations: false,
    present_at_location_ids: [DEMO_LOCATION_ID],
    item_data: {
      name: 'Demo print',
      description: 'Local demo print',
      is_archived: false,
      variations: [
        {
          type: 'ITEM_VARIATION',
          id: DEMO_SQUARE_VARIATION_ID,
          version: 1,
          present_at_all_locations: false,
          present_at_location_ids: [DEMO_LOCATION_ID],
          item_variation_data: {
            item_id: DEMO_SQUARE_ITEM_ID,
            name: 'In-Person · PLA · Black',
            sku: 'DEMO-001',
            pricing_type: 'FIXED_PRICING',
            price_money: { amount: 1200, currency: 'USD' },
            track_inventory: false,
            location_overrides: [
              { location_id: DEMO_LOCATION_ID, track_inventory: false },
            ],
          },
        },
      ],
    },
  });
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const missing = () =>
  json({ success: false, errors: [{ code: 'NOT_FOUND' }] }, 404);
/** Handles only explicitly supported provider calls; unknown egress always fails locally. */
export async function providerFetch(
  request: Request,
  state = providerState,
): Promise<Response> {
  state.requests.push({ method: request.method, url: request.url });
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    url.hostname === 'demo-fixture-control.invalid' &&
    path === '/lose-upsert-ack' &&
    request.method === 'POST'
  ) {
    state.loseNextUpsertResponse = true;
    return json({ armed: true });
  }
  if (
    (url.hostname === 'localhost' &&
      path.startsWith('/__fixture/provider-upload/')) ||
    url.hostname === 'demo-provider-upload.invalid'
  ) {
    if (request.method !== 'PUT') return missing();
    await request.arrayBuffer();
    state.uploads.add(path.split('/').at(-1) ?? '');
    return new Response(null, { status: 200 });
  }
  if (url.hostname === 'localhost' && path.startsWith('/provider/files/'))
    return new Response('solid demo\nendsolid demo\n', {
      headers: { 'Content-Type': 'model/stl' },
    });
  const slant =
    (url.hostname === 'localhost' || url.hostname === 'slant3dapi.com') &&
    path.startsWith('/v2/api/');
  if (slant) {
    const route = path.slice('/v2/api/'.length);
    if (route === 'filaments' && request.method === 'GET')
      return json({
        success: true,
        data: [
          {
            publicId: DEMO_FILAMENT_ID,
            profile: 'PLA',
            color: 'Black',
            hexValue: '#000000',
            provider: 'Slant 3D',
            available: true,
          },
        ],
      });
    if (route === 'files/direct-upload' && request.method === 'POST') {
      const body = (await request.json()) as JsonObject;
      const id = `33333333-3333-4333-8333-${String(state.nextFile++).padStart(12, '0')}`;
      const placeholder = {
        ...file(id, String(body.name), state.origin),
        ownerId: body.ownerId,
        platformId: body.platformId,
      };
      state.files.set(id, placeholder);
      return json({
        success: true,
        data: {
          key: id,
          presignedUrl: `${state.origin}/__fixture/provider-upload/${id}`,
          filePlaceholder: placeholder,
        },
      });
    }
    if (route === 'files/confirm-upload' && request.method === 'POST') {
      const body = (await request.json()) as {
        filePlaceholder: { publicFileServiceId: string };
      };
      const id = body.filePlaceholder.publicFileServiceId;
      return state.uploads.has(id)
        ? json({ success: true, data: state.files.get(id) })
        : missing();
    }
    if (route === 'files/batch' && request.method === 'POST') {
      const body = (await request.json()) as { publicFileServiceIds: string[] };
      return json({
        success: true,
        data: body.publicFileServiceIds
          .map(id => state.files.get(id))
          .filter(Boolean),
      });
    }
    const match = /^files\/([^/]+)(\/estimate)?$/.exec(route);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (!state.files.has(id)) return missing();
      if (match[2] && request.method === 'POST') {
        const body = (await request.json()) as {
          options: { filamentId: string; quantity: number };
        };
        return json({
          success: true,
          data: {
            publicFileServiceId: id,
            ...body.options,
            estimatedCost: 4.5,
            total: 4.5 * body.options.quantity,
          },
        });
      }
      if (request.method === 'GET')
        return json({ success: true, data: state.files.get(id) });
      if (request.method === 'DELETE') {
        state.files.delete(id);
        return json({ success: true });
      }
    }
    return missing();
  }
  if (
    !['connect.squareupsandbox.com', 'connect.squareup.com'].includes(
      url.hostname,
    )
  )
    return missing();
  if (path === `/v2/locations/${DEMO_LOCATION_ID}` && request.method === 'GET')
    return json({
      location: {
        id: DEMO_LOCATION_ID,
        merchant_id: DEMO_MERCHANT_ID,
        currency: 'USD',
        status: 'ACTIVE',
      },
    });
  if (path.startsWith('/v2/catalog/object/') && request.method === 'GET') {
    const item = state.items.get(
      decodeURIComponent(path.slice('/v2/catalog/object/'.length)),
    );
    return item ? json({ catalog_object: item }) : missing();
  }
  if (path === '/v2/catalog/images' && request.method === 'POST') {
    const form = await request.formData();
    const metadata = JSON.parse(String(form.get('request'))) as {
      idempotency_key: string;
      object_id?: string;
      is_primary?: boolean;
    };
    const replay = state.replays.get(metadata.idempotency_key);
    if (replay) return json(replay);
    const image = {
      type: 'IMAGE',
      id: `square-demo-image-${state.nextImage++}`,
      version: 1,
      image_data: { url: `${state.origin}/provider/image.png` },
    };
    const linked = state.items.get(metadata.object_id ?? '');
    if (linked) {
      const data = linked.item_data as JsonObject;
      const previous = Array.isArray(data.image_ids) ? data.image_ids : [];
      data.image_ids = metadata.is_primary
        ? [image.id, ...previous.filter(id => id !== image.id)]
        : [...previous, image.id];
    }
    const result = { image };
    state.replays.set(metadata.idempotency_key, result);
    return json(result);
  }
  if (path === '/v2/catalog/object' && request.method === 'POST') {
    const body = (await request.json()) as {
      idempotency_key: string;
      object: JsonObject;
    };
    const replay = state.replays.get(body.idempotency_key);
    if (replay) return json(replay);
    const item = structuredClone(body.object);
    const oldId = String(item.id);
    const id = oldId.startsWith('#')
      ? `square-demo-item-${state.nextItem++}`
      : oldId;
    const retained = state.items.get(id);
    if (retained && item.version !== retained.version)
      return json({ errors: [{ code: 'VERSION_MISMATCH' }] }, 409);
    item.id = id;
    item.version = Number(retained?.version ?? 0) + 1;
    const data = item.item_data as { variations: JsonObject[] };
    for (const variation of data.variations) {
      if (String(variation.id).startsWith('#'))
        variation.id = `${id}-variation`;
      variation.version = item.version;
      (variation.item_variation_data as JsonObject).item_id = id;
    }
    state.items.set(id, item);
    const result = { catalog_object: item };
    state.replays.set(body.idempotency_key, result);
    if (state.loseNextUpsertResponse) {
      state.loseNextUpsertResponse = false;
      throw new Error(
        'Local fixture lost the Square upsert acknowledgement after commit',
      );
    }
    return json(result);
  }
  return missing();
}
resetProviders();

/** Creates an isolated boundary for one Miniflare runtime or demonstration. */
export function createProviderBoundary() {
  const state: typeof providerState = {
    origin: localOrigin,
    loseNextUpsertResponse: false,
    requests: [],
    files: new Map(),
    items: new Map(),
    replays: new Map(),
    uploads: new Set(),
    nextFile: 1,
    nextItem: 1,
    nextImage: 1,
  };
  resetProviders(state);
  return {
    state,
    /** Binds every browser-visible provider URL to the running local API. */
    setOrigin(origin: string) {
      const canonical = new URL(origin);
      if (
        canonical.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(canonical.hostname)
      )
        throw new Error('Provider fixture origin must be local HTTP');
      const previous = state.origin;
      state.origin = canonical.origin;
      for (const stored of state.files.values()) {
        if (typeof stored.fileURL === 'string')
          stored.fileURL = stored.fileURL.replace(previous, state.origin);
      }
      for (const replay of state.replays.values()) {
        const image = replay.image as
          | { image_data?: { url?: string } }
          | undefined;
        if (image?.image_data?.url)
          image.image_data.url = image.image_data.url.replace(
            previous,
            state.origin,
          );
      }
    },
    /** Loses one successful upsert acknowledgement after retaining its committed replay. */
    loseNextUpsertResponse() {
      state.loseNextUpsertResponse = true;
    },
    providerFetch: (request: Request) => providerFetch(request, state),
    reset: () => resetProviders(state),
  };
}
