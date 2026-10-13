# Legacy HTTP route disposition

The mounted application on `main` has retired the four Slant V1 routes and the older upload-record API. Retired routes return 404 and do not redirect or refresh stored URLs. No historical migrations or stored customer/product/upload records are deleted by route retirement.

The caller evidence below is the source inventory recorded in issue #240: API `68d4bc9`, original store `10d5ee2`, Lulu `a0be390`, and rc-admin `defddd1`. It is historical static evidence, not a fresh client audit or proof of zero production traffic. The route decisions below reflect the current API source.

| Method/path | Provider or storage | Recorded client evidence | Current decision |
| --- | --- | --- | --- |
| `POST /slice` | Slant V1 slicer | No caller in the three reviewed clients | Retired, 404 |
| `GET /colors` | Slant V1 filament list | No caller | Retired, 404; active clients use `/v2/colors` |
| `POST /estimate` | Slant V1 estimate | No caller | Retired, 404 |
| `POST /add-product` | Legacy create using Slant V1 | No caller | Retired, 404 |
| `POST /v2/upload` | Slant V2 plus `uploaded_files` record | No caller | Retired, 404 |
| `GET /v2/uploads`, `GET /v2/uploads/:id` | Stored upload records with expiring URLs | No caller | Retired, 404; no stale download URL returned |
| `GET /list` | R2 inventory | No caller identified | Retained, authenticated and scoped to the current user's prefix |
| `POST /v2/estimate` | Slant V2 estimate | No caller identified | Retained; lack of a frontend caller alone is insufficient to remove an operator API |
| `POST /profile` | Profile persistence | Stores used `/profile/:id` | Retained authenticated convenience contract |
| `POST /upload`, `PUT /update-product`, `POST /v2/add-product` | R2/catalog and active Slant V2 helpers | rc-admin source callers | Retained; changing that interface requires an explicit consumer migration |
| `POST /v2/presigned-upload`, `POST /v2/confirm` | Slant V2 file allocation/confirmation | rc-admin source callers | Retained; shared V2 helpers also support draft attachments |

## Preserved contracts and operator checks

Catalog list/detail/search, categories, `/v2/colors`, profile, cart/auth, quotes and checkout remain mounted. Admin draft, attachment, cleanup, publication and recovery routes remain supported. Photo upload and image access can use URLs returned by the API, so literal client path searches are not a complete usage inventory.

`POST /webhook/square` and `POST /webhook/slant3d` are provider callbacks, not storefront calls. Keep their configured subscription URLs and signature verification intact. An unversioned application path does not imply a Slant V1 call. The active application no longer requires the V1 `SLANT_API` binding or V1 `BASE_URL`; V2 credentials and shared helpers remain necessary.

Before deployment, the operator must review available access logs, scripts and callback configuration for the retired method/path pairs and retained candidates. No such production evidence was accessed during this source audit. Unexpected callers need a reviewed migration or explicit retirement decision; do not silently restore V1 behavior or remove the remaining operator surface. No deployment is authorized by this document.

## Regression evidence

`test/routes/printerUploadV2.spec.ts` sends authenticated and anonymous requests through the mounted app for every retired route, including paginated upload listing and another user's upload identity. It asserts 404, no response containing an expired stored URL, no D1 access, and no provider calls. D1 and provider boundaries are mocked; no database or external provider runs in these tests. Existing catalog, cart, profile, attachment, payment and webhook suites cover retained contracts.
