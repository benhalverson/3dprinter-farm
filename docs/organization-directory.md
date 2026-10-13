# Organization directory access and existing memberships

Storefront accounts do not need organization membership to browse the public catalog, own a cart, check out, or read their own orders. Signup no longer enrolls customers in `org_shared_catalog`. Catalog administration requires a current `admin` or `owner` membership in that organization; the legacy `users.role` value cannot restore a removed or demoted membership.

Every mounted `/api/auth/organization/*` request passes through the session and current catalog-role middleware before Better Auth receives it. This includes `list-members` and `get-full-organization`, with or without pagination. Ordinary customers, shared-organization `member` accounts and administrators of only an unrelated organization receive a generic denial without directory fields. Authorized shared-organization staff retain the plugin's own organization-specific permission checks. Public catalog reads remain independent of this staff boundary.

## Existing membership disposition

The access restriction protects existing customer memberships immediately; deleting them is not a prerequisite for denying directory reads. Existing rows are deliberately retained. There is no automatic migration, role-based bulk deletion or customer-account cleanup in this fix.

Before any separately authorized membership cleanup, an operator should:

1. Review only the required shared-organization membership IDs and current roles through the existing Drizzle schema/query APIs in the intended environment. Keep the inventory private; do not export customer names or email addresses into issue comments or logs.
2. Identify legitimate staff from an independently confirmed staff roster. Preserve current `admin` and `owner` memberships, and review ambiguous `member` records individually: a demoted staff account and an ordinary customer can have the same role. Never infer current privileges from `users.role`.
3. Decide whether to retain ordinary `member` rows. Retaining them is supported and grants no directory or catalog-mutation access. If removal is required, obtain a reviewed list of exact membership IDs, a restorable backup, and explicit authorization for the target environment first.
4. Use a narrow Drizzle mutation guarded by membership ID, user ID, organization ID and the reviewed current role. Recheck immediately before removal so a concurrent staff promotion is not deleted. Stop on a changed role or identity. Do not delete users, sessions, carts, orders, the shared organization, or unrelated memberships, and do not promote accounts as a cleanup side effect.
5. Verify that affected synthetic customers retain account/cart/order access and still cannot read the directory, and that approved staff retain administration. If restoring a mistakenly removed membership, restore only its reviewed prior role after checking that no later role change superseded it.

No production membership inventory or cleanup has been performed. The repository contains no evidence identifying which deployed memberships are obsolete; that classification requires the operator's roster and environment access. Published migration history must remain unchanged.

## Regression evidence

`test/database/organizationAuthorization.spec.ts` exercises the mounted real Better Auth handler with synthetic identities for customer denial, unrelated-organization denial, staff pagination and membership revocation. It is an existing local SQLite fixture and does not certify deployed D1 behavior. The route boundary lives in `src/routes/authApi.ts`; current-role lookup is in `src/utils/authMiddleware.ts` and `src/utils/organization.ts`.
