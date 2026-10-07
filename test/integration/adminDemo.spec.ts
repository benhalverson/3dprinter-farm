import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createMockDemoRuntime } from './adminDemoHarness';
import type { ProductDraft } from '../../src/modules/productDraftContracts.ts';
import type { ProductPreparation } from '../../src/modules/productPreparationContracts.ts';

/** Exercise protected routes with local SQLite and mocked API, auth and object-storage boundaries. */
test('local admin demo performs photo+print create, update, and delete through production routes', async () => {
  const runtime = await createMockDemoRuntime();
  const fetch = runtime.request;
  try {
    const base = runtime.url.origin;
    const login = await fetch(new URL('/__fixture/login', runtime.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-demo-fixture-token': 'lulu-local-demo',
      },
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(login.status, 200);
    const admin = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.equal(admin, 'demo-session=admin');
    async function call<T>(
      path: string,
      method = 'GET',
      body?: unknown,
      cookie = admin,
    ): Promise<T> {
      const response = await fetch(new URL(path, base), {
        method,
        headers: {
          cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.ok(
        response.ok,
        `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
      );
      return value as T;
    }
    const photo = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAC0lEQVR4nGNgQAYAAA4AAamRc7EAAAAASUVORK5CYII=',
      'base64',
    );
    const unauthorized = await fetch(`${base}/admin/product-drafts`);
    assert.equal(unauthorized.status, 401);
    const forbidden = await fetch(`${base}/admin/product-drafts`, {
      headers: { cookie: 'demo-session=member' },
    });
    assert.equal(forbidden.status, 403);
    const cors = await fetch(`${base}/categories`, {
      headers: { origin: 'http://localhost:3000' },
    });
    assert.equal(
      cors.headers.get('access-control-allow-origin'),
      'http://localhost:3000',
    );
    assert.equal(cors.headers.get('access-control-allow-credentials'), 'true');
    await call('/admin/catalog/2/square');
    const legacy = await call<ProductDraft>('/admin/product-drafts', 'POST', {
      target: { kind: 'existing', productId: 2 },
      state: {
        answers: { markupPercentage: '50' },
        history: [],
        pendingQuestions: [],
      },
    });
    const legacyPath = `/admin/product-drafts/${legacy.id}`;
    const legacyPreparation = await call<{ preparation: ProductPreparation }>(
      `${legacyPath}/pricing/prepare`,
      'POST',
      { expectedRevision: legacy.revision, action: 'update' },
    );
    assert.equal(legacyPreparation.preparation.status, 'ready');
    const legacySubmit = await fetch(new URL(`${legacyPath}/submit`, base), {
      method: 'POST',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: legacy.revision,
        preparationId: legacyPreparation.preparation.id,
        action: 'update',
      }),
    });
    assert.equal(legacySubmit.status, 409);
    assert.deepEqual(await legacySubmit.json(), {
      error: 'square_mapping_required',
    });
    assert.equal(runtime.providers.state.items.size, 1);
    let draft = await call<ProductDraft>('/admin/product-drafts', 'POST', {
      target: { kind: 'new' },
      state: {
        answers: {
          name: 'Local bracket',
          description: 'Created through real routes',
          categoryIds: [1],
          filamentType: 'PLA',
          color: 'Black',
          markupPercentage: '50',
          inPersonPrice: '12.00',
        },
        history: [],
        pendingQuestions: [],
      },
    });
    const path = `/admin/product-drafts/${draft.id}`;
    const initialAnswers = structuredClone(draft.state.answers);
    const ambiguous = await call<ProductDraft>(`${path}/prepare`, 'POST', {
      expectedRevision: draft.revision,
      answers: {},
      message: 'Maybe change something',
    });
    assert.equal(ambiguous.state.interpretation?.status, 'clarification');
    assert.deepEqual(ambiguous.state.answers, initialAnswers);
    assert.equal(runtime.providers.state.items.size, 1);
    draft = ambiguous;
    draft = await call<ProductDraft>(`${path}/prepare`, 'POST', {
      expectedRevision: draft.revision,
      answers: {},
      message: JSON.stringify({
        description: 'Natural correction supplied by administrator',
      }),
    });
    assert.equal(
      draft.state.answers.description,
      'Natural correction supplied by administrator',
    );
    assert.ok(draft.state.history.some(message => message.role === 'user'));
    const photoIntent = await call<{
      draft: ProductDraft;
      transfer: { id: string; upload: { method: string; url: string } };
    }>(`${path}/attachments/intents`, 'POST', {
      expectedRevision: draft.revision,
      kind: 'photo',
      name: 'bracket.png',
      size: photo.length,
    });
    const uploaded = await fetch(
      new URL(photoIntent.transfer.upload.url, base),
      {
        method: 'PUT',
        headers: { cookie: admin, 'content-type': 'application/octet-stream' },
        body: photo,
      },
    );
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    draft = ((await uploaded.json()) as { draft: ProductDraft }).draft;
    assert.equal(draft.attachments.photos.length, 1);
    const printIntent = await call<{
      draft: ProductDraft;
      transfer: { id: string; upload: { method: string; url: string } };
    }>(`${path}/attachments/intents`, 'POST', {
      expectedRevision: draft.revision,
      kind: 'print',
      name: 'bracket.stl',
      size: 32,
    });
    const printUpload = await fetch(printIntent.transfer.upload.url, {
      method: 'PUT',
      body: 'solid bracket\nendsolid bracket',
    });
    assert.ok(printUpload.ok, await printUpload.text());
    draft = (
      await call<{ draft: ProductDraft }>(
        `${path}/attachments/transfers/${printIntent.transfer.id}/confirm`,
        'POST',
        { expectedRevision: printIntent.draft.revision },
      )
    ).draft;
    const prepared = await call<{ preparation: ProductPreparation }>(
      `${path}/pricing/prepare`,
      'POST',
      { expectedRevision: draft.revision, action: 'create' },
    );
    assert.equal(prepared.preparation.status, 'ready');
    assert.equal(prepared.preparation.pricing.productionCost, 4.5);
    assert.equal(prepared.preparation.pricing.onlinePrice, 6.75);
    assert.equal(prepared.preparation.pricing.inPersonPrice, 12);
    type Result = {
      operation: { id: string; state: string; productId: number };
      product: { id: number; name: string; image: string };
      storefrontVisible: boolean;
    };
    const injected = await fetch(new URL('/__fixture/lose-upsert-ack', base), {
      method: 'POST',
      headers: { 'x-demo-fixture-token': 'lulu-local-demo' },
    });
    assert.equal(injected.status, 200);
    const uncertain = await call<Result>(`${path}/submit`, 'POST', {
      expectedRevision: draft.revision,
      preparationId: prepared.preparation.id,
      action: 'create',
    });
    assert.equal(uncertain.operation.state, 'pending');
    assert.equal(uncertain.product, null);
    const requestsAfterSubmit = runtime.providers.state.requests.length;
    const inspected = await call<Result>(`${path}/operation`);
    assert.equal(inspected.operation.state, 'pending');
    assert.equal(runtime.providers.state.requests.length, requestsAfterSubmit);
    const created = await call<Result>(`${path}/reconcile`, 'POST', {
      operationId: uncertain.operation.id,
    });
    assert.equal(created.operation.state, 'succeeded');
    assert.equal(created.operation.id, uncertain.operation.id);
    assert.equal(created.storefrontVisible, true);
    assert.equal(runtime.providers.state.items.size, 2);
    const readCreated = await call<ProductDraft>(path);
    assert.equal(readCreated.attachments.photos.length, 1);
    const publicPhoto = await fetch(new URL(created.product.image, base));
    assert.equal(publicPhoto.status, 200);
    assert.equal(publicPhoto.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await publicPhoto.arrayBuffer()), photo);
    const changed = await call<ProductDraft>('/admin/product-drafts', 'POST', {
      target: { kind: 'existing', productId: created.product.id },
      state: {
        answers: { name: 'Updated local bracket' },
        history: [],
        pendingQuestions: [],
      },
    });
    const changedPath = `/admin/product-drafts/${changed.id}`;
    const updatePreparation = await call<{ preparation: ProductPreparation }>(
      `${changedPath}/pricing/prepare`,
      'POST',
      { expectedRevision: changed.revision, action: 'update' },
    );
    assert.equal(updatePreparation.preparation.status, 'ready');
    const updated = await call<Result>(`${changedPath}/submit`, 'POST', {
      expectedRevision: changed.revision,
      preparationId: updatePreparation.preparation.id,
      action: 'update',
    });
    assert.equal(updated.operation.state, 'succeeded');
    assert.equal(updated.product.name, 'Updated local bracket');
    const readUpdated = await call<ProductDraft>(changedPath);
    assert.equal(readUpdated.context.status, 'available');
    if (readUpdated.context.status === 'available')
      assert.equal(readUpdated.context.product.name, 'Updated local bracket');
    const deletion = await call<ProductDraft>('/admin/product-drafts', 'POST', {
      target: { kind: 'existing', productId: created.product.id },
    });
    const deletePath = `/admin/product-drafts/${deletion.id}`;
    const deletePreparation = await call<{ preparation: ProductPreparation }>(
      `${deletePath}/pricing/prepare`,
      'POST',
      { expectedRevision: deletion.revision, action: 'delete' },
    );
    const deleted = await call<Result>(`${deletePath}/submit`, 'POST', {
      expectedRevision: deletion.revision,
      preparationId: deletePreparation.preparation.id,
      action: 'delete',
    });
    assert.equal(deleted.operation.state, 'succeeded');
    assert.equal(deleted.storefrontVisible, false);
    const afterDeletePhoto = await fetch(new URL(created.product.image, base));
    assert.equal(afterDeletePhoto.status, 404);
    type Cleanup = {
      revision: number;
      status: string;
      cleanup: { assetId: string; status: string; reason: string | null }[];
    };
    const discarded = await call<Cleanup>(
      `${path}?expectedRevision=${readCreated.revision}`,
      'DELETE',
    );
    assert.equal(discarded.status, 'discarded');
    // Retained edit/delete drafts still own references after the catalog deletion.
    assert.ok(discarded.cleanup.some(item => item.status === 'protected'));
    for (const retainedPath of [changedPath, deletePath]) {
      const retained = await call<ProductDraft>(retainedPath);
      const result = await call<Cleanup>(`${retainedPath}?expectedRevision=${retained.revision}`, 'DELETE');
      assert.equal(result.status, 'discarded');
    }
    const cleaned = await call<Cleanup>(`${path}/cleanup/retry`, 'POST', {
      expectedRevision: discarded.revision,
    });
    assert.equal(cleaned.cleanup.length, 2);
    assert.ok(
      cleaned.cleanup.every(item => item.status === 'deleted'),
      JSON.stringify(cleaned.cleanup),
    );
    const photoAssetId = readCreated.attachments.photos[0].assetId;
    const bucket = runtime.photoBucket;
    assert.equal(await bucket.head(`product-drafts/${photoAssetId}`), null);
    const printFileId = readCreated.attachments.printFile?.publicFileServiceId;
    assert.ok(printFileId);
    assert.equal(runtime.providers.state.files.has(printFileId), false);
    const requests = runtime.providers.state.requests;
    assert.ok(
      requests.some(request => request.url.includes('/v2/catalog/images')),
    );
    assert.ok(
      requests.some(request => request.url.includes('/files/direct-upload')),
    );
    assert.ok(requests.some(request => request.url.includes('/estimate')));
  } finally {
    await runtime.close();
  }
});
