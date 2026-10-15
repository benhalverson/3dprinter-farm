# Legacy HTTP route disposition

The mounted application on `main` has retired the four Slant V1 routes and the older upload-record API. Retired routes return 404 and do not redirect or refresh stored URLs. No historical migrations or stored customer/product/upload records are deleted by route retirement.

The candidate list originates in issue #240's API snapshot `68d4bc9`. On 2026-10-13, the current API base `39db6e2` was checked against freshly fetched client `origin/main` revisions: original store `10d5ee265b1298df9f1e432fadd8111e4164da28`, Lulu `2879d4729da9884f45eba82ff3821fc699a3d984`, and rc-admin `defddd1b5cff2334cdf4246d9c0da12fcaede071`. Searches covered non-test `src` and the API's local operator scripts; matched calls were inspected for HTTP method and dynamically returned URLs. This is source evidence, not proof of zero production traffic.

The original store is `benhalverson/store`: its [color picker](https://github.com/benhalverson/store/blob/10d5ee265b1298df9f1e432fadd8111e4164da28/src/components/ColorPicker.tsx) uses `/v2/colors`, and its [profile editor](https://github.com/benhalverson/store/blob/10d5ee265b1298df9f1e432fadd8111e4164da28/src/pages/Profile.tsx) posts to `/profile/:id`. Lulu's [product client](https://github.com/benhalverson/luluspeedworks/blob/2879d4729da9884f45eba82ff3821fc699a3d984/src/storefront/product.ts), [profile client](https://github.com/benhalverson/luluspeedworks/blob/2879d4729da9884f45eba82ff3821fc699a3d984/src/storefront/profile.ts), and [attachment transfers](https://github.com/benhalverson/luluspeedworks/blob/2879d4729da9884f45eba82ff3821fc699a3d984/src/admin/attachments.ts) retain V2 colors, ID-qualified profile writes and API-returned upload URLs. rc-admin's [product service](https://github.com/benhalverson/rc-admin/blob/defddd1b5cff2334cdf4246d9c0da12fcaede071/src/app/product.service.ts) and [upload service](https://github.com/benhalverson/rc-admin/blob/defddd1b5cff2334cdf4246d9c0da12fcaede071/src/app/upload/upload.service.ts) still call the retained legacy application interfaces below, including the returned presigned upload URL.

| Method/path | Provider or storage | Client source evidence | Operator/callback status | Current decision |
| --- | --- | --- | --- | --- |
| `POST /slice` | Slant V1 slicer | No caller in the three reviewed clients | Operator traffic unverified; not a provider callback | Retired, 404 |
| `GET /colors` | Slant V1 filament list | No caller | Operator traffic unverified; not a provider callback | Retired, 404; active clients use `/v2/colors` |
| `POST /estimate` | Slant V1 estimate | No caller | Operator traffic unverified; not a provider callback | Retired, 404 |
| `POST /add-product` | Legacy create using Slant V1 | No caller | Operator traffic unverified; not a provider callback | Retired, 404 |
| `POST /v2/upload` | Slant V2 plus `uploaded_files` record | No caller | Operator traffic unverified; not a provider callback | Retired, 404 |
| `GET /v2/uploads`, `GET /v2/uploads/:id` | Stored upload records with expiring URLs | No caller | Operator traffic unverified; not a provider callback | Retired, 404; no stale download URL returned |
| `GET /list` | R2 inventory; no Slant call | No caller identified | Possible operator API; production use unverified | Retained, authenticated and scoped to the current user's prefix |
| `POST /v2/estimate` | Slant V2 estimate | No caller identified | Repository `test-presigned-upload.ts` calls it; other operator use unverified | Retained; lack of a frontend caller alone is insufficient to remove an operator API |
| `POST /profile` | Profile persistence; no Slant call | Stores used `/profile/:id` | Possible direct application client; use unverified | Retained authenticated convenience contract |
| `POST /upload`, `PUT /update-product`, `POST /v2/add-product` | R2/catalog; only V2 create calls Slant V2 | rc-admin source callers | Local `test-add-product-v2.*` scripts call V2 create; other operator use unverified | Retained; changing that interface requires an explicit consumer migration |
| `POST /v2/presigned-upload`, `POST /v2/confirm` | Slant V2 file allocation/confirmation | rc-admin source callers | Repository `test-presigned-upload.ts` calls both; other operator use unverified | Retained; shared V2 helpers also support draft attachments |
| `POST /webhook/square` | Square payment callback and Slant V2 fulfillment | Provider subscription, not a storefront caller | Configured callback URL/subscription must be checked before deployment | Retained with existing signature verification |
| `POST /webhook/slant3d` | Slant V2 order lifecycle callback | Provider subscription, not a storefront caller | Configured subscription must be checked before deployment | Retained with existing signature verification |

## Preserved contracts and operator checks

Catalog list/detail/search, categories, `/v2/colors`, profile, cart/auth, quotes and checkout remain mounted. Admin draft, attachment, cleanup, publication and recovery routes remain supported. Photo upload and image access can use URLs returned by the API, so literal client path searches are not a complete usage inventory.

`POST /webhook/square` and `POST /webhook/slant3d` are provider callbacks, not storefront calls. Keep their configured subscription URLs and signature verification intact. An unversioned application path does not imply a Slant V1 call. The active application no longer requires the V1 `SLANT_API` binding or V1 `BASE_URL`; V2 credentials and shared helpers remain necessary.

The remaining V1 request/response validators and retired upload-record response schemas had no consumers after route removal and are removed. Shared V2 file/estimate schemas remain, as do the `uploaded_files` table and published migrations. Test and local demo bindings omit the V1 credential so they cannot conceal a retained requirement for it. The historical pre-removal provider-call baseline from the issue was not rerun; current regression checks establish the mounted application's retirement behavior.

Before deployment, the operator must review available access logs, scripts and callback configuration for the retired method/path pairs and retained candidates. No such production evidence was accessed during this source audit. Unexpected callers need a reviewed migration or explicit retirement decision; do not silently restore V1 behavior or remove the remaining operator surface. No deployment is authorized by this document.

## Regression evidence

`test/routes/printerUploadV2.spec.ts` sends valid legacy JSON/multipart bodies and GET requests through the mounted app with anonymous, user and admin session fixtures. It covers every retired method/path, filtered colors, paginated upload listing and another user's upload identity. It asserts the plain 404 body, no D1 access, no R2 or KV operations, and no provider calls. Health/readiness also run without a V1 credential. D1 and provider boundaries are mocked; no database or external provider runs in these tests. Existing catalog, cart, profile, attachment, payment and webhook suites cover retained contracts.
