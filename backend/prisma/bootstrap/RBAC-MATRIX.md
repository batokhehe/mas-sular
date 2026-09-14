# RBAC permission matrix

Source of truth: [`permission-catalogue.ts`](permission-catalogue.ts) (this table is generated from it).
Enforced by `PermissionGuard` (exact `Subject.action` names, no aliases) against the permissions
`AdminJwtStrategy` reads from the database on every request. `test/unit/rbac-catalogue.spec.ts` fails CI if a
controller requires a permission that is not in the catalogue, or if the matrix drifts.

## Roles

| Role | Who | Principle |
|---|---|---|
| **SUPER_ADMIN** | Owner / platform administrator | Holds everything implicitly. The ONLY role that may create or edit roles, change the bank accounts customers pay into, create/delete/activate outlets (the shipping origin), or read system internals. |
| **ADMIN** | Store administrator | Runs the shop day to day and owns the catalogue. No role administration, no payment-account changes, no system internals. |
| **MANAGER** | Shift / outlet manager | Orders, payment verification, fulfilment and stock. Catalogue is read-only. |
| **STAFF** | Fulfilment staff | Sees orders and moves them along. Cannot verify/reject payments, see the customer list, or edit the catalogue. |
| **CUSTOMER** | Storefront shopper | No admin permission at all. Storefront endpoints are protected by the customer session plus per-resource ownership checks. |

System roles are **immutable through the API** (name and permissions). They change only here, and reach a
database through `prisma/sync-rbac.ts` (dry-run by default) or the bootstrap. SUPER_ADMIN may create
**custom** roles from catalogue permissions; a custom role may not use a reserved name
(`SUPER_ADMIN`, `Super Admin`, `super-admin`, `ADMIN`, ...), and nobody may edit a role they hold.

Customer accounts (`PATCH /admin/users/:id`) can only ever hold the CUSTOMER role.

> Proposed least-privilege defaults. Review with the business before creating ADMIN/MANAGER/STAFF users.
> `Order.update` (STAFF) covers status changes, notes and invoice links; tighten further if STAFF must not
> cancel orders.

## Matrix

| Permission | SUPER_ADMIN | ADMIN | MANAGER | STAFF | CUSTOMER |
|---|:-:|:-:|:-:|:-:|:-:|
| `Dashboard.read` | ✅ | ✅ | ✅ | — | — |
| `Product.read` | ✅ | ✅ | ✅ | ✅ | — |
| `Product.create` | ✅ | ✅ | — | — | — |
| `Product.update` | ✅ | ✅ | — | — | — |
| `Product.delete` | ✅ | ✅ | — | — | — |
| `Category.read` | ✅ | ✅ | ✅ | ✅ | — |
| `Category.create` | ✅ | ✅ | — | — | — |
| `Category.update` | ✅ | ✅ | — | — | — |
| `Category.delete` | ✅ | ✅ | — | — | — |
| `Promo.read` | ✅ | ✅ | ✅ | — | — |
| `Promo.create` | ✅ | ✅ | — | — | — |
| `Promo.update` | ✅ | ✅ | — | — | — |
| `Promo.delete` | ✅ | ✅ | — | — | — |
| `Banner.read` | ✅ | ✅ | ✅ | — | — |
| `Banner.create` | ✅ | ✅ | — | — | — |
| `Banner.update` | ✅ | ✅ | — | — | — |
| `Banner.delete` | ✅ | ✅ | — | — | — |
| `Media.upload` | ✅ | ✅ | — | — | — |
| `Order.read` | ✅ | ✅ | ✅ | ✅ | — |
| `Order.update` | ✅ | ✅ | ✅ | ✅ | — |
| `Payment.read` | ✅ | ✅ | ✅ | ✅ | — |
| `Payment.verify` | ✅ | ✅ | ✅ | — | — |
| `Payment.reject` | ✅ | ✅ | ✅ | — | — |
| `Shipment.read` | ✅ | ✅ | ✅ | ✅ | — |
| `Shipment.create` | ✅ | ✅ | ✅ | — | — |
| `Shipment.update` | ✅ | ✅ | ✅ | — | — |
| `Shipment.delete` | ✅ | ✅ | — | — | — |
| `User.read` | ✅ | ✅ | ✅ | — | — |
| `User.update` | ✅ | ✅ | — | — | — |
| `Role.read` | ✅ | — | — | — | — |
| `Role.create` | ✅ | — | — | — | — |
| `Role.update` | ✅ | — | — | — | — |
| `DeliveryCoverage.read` | ✅ | ✅ | ✅ | — | — |
| `DeliveryCoverage.create` | ✅ | ✅ | — | — | — |
| `DeliveryCoverage.update` | ✅ | ✅ | — | — | — |
| `DeliveryCoverage.delete` | ✅ | ✅ | — | — | — |
| `SystemLog.read` | ✅ | — | — | — | — |
| `Queue.read` | ✅ | ✅ | — | — | — |
| `Queue.retry` | ✅ | — | — | — | — |
| `Incident.read` | ✅ | ✅ | ✅ | — | — |
| `Incident.manage` | ✅ | — | — | — | — |
| `Notification.read` | ✅ | ✅ | ✅ | ✅ | — |
| `Notification.send` | ✅ | ✅ | ✅ | — | — |
| `Notification.resend` | ✅ | ✅ | — | — | — |
| `Notification.manage` | ✅ | — | — | — | — |
| `Audit.read` | ✅ | ✅ | — | — | — |
| `Audit.export` | ✅ | — | — | — | — |
| `AuditLog.read` | ✅ | — | — | — | — |
| `PaymentAccount.read` | ✅ | ✅ | — | — | — |
| `PaymentAccount.create` | ✅ | — | — | — | — |
| `PaymentAccount.update` | ✅ | — | — | — | — |
| `PaymentAccount.delete` | ✅ | — | — | — | — |
| `PaymentAccount.activate` | ✅ | — | — | — | — |
| `Outlet.read` | ✅ | ✅ | ✅ | ✅ | — |
| `Outlet.create` | ✅ | — | — | — | — |
| `Outlet.update` | ✅ | ✅ | — | — | — |
| `Outlet.delete` | ✅ | — | — | — | — |
| `Outlet.activate` | ✅ | — | — | — | — |
| `InventoryReservation.read` | ✅ | ✅ | ✅ | ✅ | — |
| `ProductInventory.read` | ✅ | ✅ | ✅ | ✅ | — |
| `ProductInventory.update` | ✅ | ✅ | ✅ | — | — |
| `StockTransfer.read` | ✅ | ✅ | ✅ | ✅ | — |
| `StockTransfer.create` | ✅ | ✅ | ✅ | — | — |
| `StockTransfer.update` | ✅ | ✅ | ✅ | — | — |

Totals: SUPER_ADMIN 64 (implicit), ADMIN 48, MANAGER 25, STAFF 11, CUSTOMER 0

## Applying it to a database

```bash
# plan only (no writes)
docker compose --env-file ./production.env -f docker-compose.production.yml run --rm \
  backend-migrate node node_modules/tsx/dist/cli.mjs prisma/sync-rbac.ts
# after a verified backup:
docker compose --env-file ./production.env -f docker-compose.production.yml run --rm \
  backend-migrate node node_modules/tsx/dist/cli.mjs prisma/sync-rbac.ts --apply
```

The sync creates missing roles/permissions, adds missing grants, and removes grants on the code-owned
system roles that the matrix does not contain. It never deletes a permission row, a custom role, an admin or
a user. Retired legacy permission rows (`orders.view`, `categories.*`, ...) are only reported; they are hidden
from the admin UI's permission list and cannot be granted.
