# Mocked admin mutation recovery evidence

API companion for [Lulu issue #33](https://github.com/benhalverson/luluspeedworks/issues/33) and [storefront PR #70](https://github.com/benhalverson/luluspeedworks/pull/70).

`test/routes/productMutations.spec.ts` exercises the real mounted Hono mutation routes and production Square client against mocked authentication, preparation/readiness, Drizzle records and HTTP responses. Every request constructs a fresh Hono app and Drizzle adapter; continuation tests clone the retained fixture records and discard the previous adapter. No prior request continuation is needed for sequential recovery. The intentional overlap case separately holds two synthetic provider responses to test the late-rejection guard.

| Scenario | Create, update and delete observations |
| --- | --- |
| First Square HTTP 400 rejection | Persisted `failed`, `retryable: false`, fixed `square_request_rejected`; no raw provider details or credentials; local product/mapping unchanged; later operation reads and reconciliation do not republish |
| Rejection after an unknown response | Remains `pending` and retryable with the original operation identity and exact saved payload across repeated reconciliation; local catalog unchanged |
| Original rejection after overlapping replay | `replayed` and error guards prevent the original invocation from marking the operation failed; both requests retain one operation and the same payload |
| Unknown response followed by confirmation | Prior catalog remains until verified Square response; one local product insertion/update/deletion follows; later successful terminal reads/replays cause no provider or catalog mutations |
| Square confirmed, local batch unavailable | Repeated fresh invocations retain `repair_required` and the prior catalog/mapping; recovery resumes the frozen local projection without another provider request |
| Existing product or mapping changed before completion | Update/delete stay in retryable repair through repeated attempts; guarded writes preserve the newer product revision or mapping generation |

Existing tests retain coverage of successful provider-before-local ordering for all actions, current preparation/authorization, mismatched provider confirmation, and unavailable primary images. The new scenarios do not duplicate those success-ordering cases or change the API contract.

The fixture evaluates the bounded Drizzle equality, `IN`, null, `AND` and `EXISTS` predicates used by these cases. Unmatched guarded updates return no row and do not modify retained records; unsupported predicates fail closed. Reads return copies, and completion projections use the retained operation fields. Injected batch failure happens before any statement, so these tests do not simulate or prove rollback, foreign keys, uniqueness, database transaction isolation, actual Worker restart durability, or real Square outcomes. No SQL, database, provider, payment, migration or deployment is executed by this suite. The existing repository-wide persistence suites are separate and unchanged.

Run `pnpm exec vitest run test/routes/productMutations.spec.ts` for the focused contract evidence, then the repository's required `pnpm check`, `pnpm test:ci`, and `pnpm test:project-notes` commands. Browser/rendering evidence belongs to the storefront PR; these API mocks do not establish production serving or live provider acceptance.
