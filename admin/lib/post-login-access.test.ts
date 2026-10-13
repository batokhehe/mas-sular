import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { ALL_PERMISSION_NAMES, ROLE_PERMISSION_MATRIX } from '../../backend/prisma/bootstrap/permission-catalogue.ts';

/**
 * Where each admin role lands after signing in, driven by the REAL navigation module
 * (lib/navigation.ts -> ROUTE_PERMISSIONS + the real permission checks) and the REAL
 * production RBAC matrix. No user, no database.
 *
 * lib/navigation.ts is ordinary app code with extension-less imports (as Next.js
 * resolves them); node's test runner does not, so this file registers a minimal
 * resolve hook that tries `<specifier>.ts` for relative imports - test-local only.
 */
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (/^\\.{1,2}\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
    try { return await next(specifier + '.ts', context); } catch {}
  }
  return next(specifier, context);
}`),
  import.meta.url,
);
const { ADMIN_NAV_SECTIONS, canViewDashboard, DASHBOARD_ROUTE, firstAccessibleRoute, visibleNavSections } = await import('./navigation.ts');

const ROOT = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The permission list the login response and GET /admin/auth/me return for a role. */
const ROLE_PERMISSIONS = {
  SUPER_ADMIN: [...ALL_PERMISSION_NAMES], // AdminAuthService/AdminJwtStrategy: the whole catalogue
  ADMIN: [...ROLE_PERMISSION_MATRIX.ADMIN],
  MANAGER: [...ROLE_PERMISSION_MATRIX.MANAGER],
  STAFF: [...ROLE_PERMISSION_MATRIX.STAFF],
};

const visibleHrefs = (permissions: readonly string[]) => visibleNavSections(permissions).flatMap((s: { items: Array<{ href: string }> }) => s.items.map((i) => i.href));

// ------------------------------------------------------------ route behaviour --

test('post-login route per role: SUPER_ADMIN/ADMIN/MANAGER -> /dashboard, STAFF -> /orders', () => {
  assert.equal(firstAccessibleRoute(ROLE_PERMISSIONS.SUPER_ADMIN), '/dashboard');
  assert.equal(firstAccessibleRoute(ROLE_PERMISSIONS.ADMIN), '/dashboard');
  assert.equal(firstAccessibleRoute(ROLE_PERMISSIONS.MANAGER), '/dashboard');
  assert.equal(firstAccessibleRoute(ROLE_PERMISSIONS.STAFF), '/orders');
});

test('every role lands on a page whose own guard it passes (never on "Permission required")', () => {
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const landing = firstAccessibleRoute(permissions);
    const item = ADMIN_NAV_SECTIONS.flatMap((s: { items: Array<{ href: string; permissions: readonly string[] }> }) => s.items).find((i) => i.href === landing)!;
    assert.ok(item.permissions.every((p) => permissions.includes(p)), `${role} -> ${landing} is not authorized`);
  }
});

test('the fallback order: dashboard, then orders/payments/shipping, then sidebar order', () => {
  assert.equal(firstAccessibleRoute(['Dashboard.read', 'Order.read']), '/dashboard');
  assert.equal(firstAccessibleRoute(['Payment.read', 'Product.read']), '/payments');
  assert.equal(firstAccessibleRoute(['Shipment.read', 'Product.read']), '/shipping');
  assert.equal(firstAccessibleRoute(['Product.read']), '/products');
  assert.equal(firstAccessibleRoute(['Audit.read']), '/system/audit');
});

test('safe fallback: an admin who can open nothing gets /dashboard (AdminShell explains missing access)', () => {
  assert.equal(firstAccessibleRoute([]), DASHBOARD_ROUTE);
  assert.equal(firstAccessibleRoute(undefined), DASHBOARD_ROUTE);
  assert.equal(firstAccessibleRoute(['Unknown.read', 'orders.view']), DASHBOARD_ROUTE); // no legacy aliases
});

// ------------------------------------------------------- dashboard data fetch --

test('dashboard data is only requested with Dashboard.read (STAFF makes no executive-dashboard request)', () => {
  assert.equal(canViewDashboard(ROLE_PERMISSIONS.STAFF), false);
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] as const) assert.equal(canViewDashboard(ROLE_PERMISSIONS[role]), true);

  const page = read('app/dashboard/page.tsx');
  // The query is gated on canViewDashboard(me.permissions), not merely on a loaded profile.
  assert.match(page, /const mayView = profile\.isSuccess && canViewDashboard\(permissions\);/);
  assert.match(page, /const canFetch = mayView;/);
  assert.match(page, /enabled: canFetch,/);
  assert.doesNotMatch(page, /const canFetch = profile\.isSuccess;/);
  // ...and a user without it is sent to their first accessible page.
  assert.match(page, /firstAccessibleRoute\(permissions\)/);
  assert.match(page, /router\.replace\(fallbackRoute\)/);
});

// --------------------------------------------------------------- wiring pins --

test('login redirects to firstAccessibleRoute(data.permissions), not a fixed /dashboard', () => {
  const login = read('app/(auth)/login/page.tsx');
  assert.match(login, /const data = await loginAdmin\(email, password\);/);
  assert.match(login, /router\.replace\(firstAccessibleRoute\(data\.permissions \?\? \[\]\)\)/);
  assert.doesNotMatch(login, /router\.replace\('\/dashboard'\)/);
});

test('`/` still redirects server-side to /dashboard, which forwards STAFF onward', () => {
  assert.match(read('app/page.tsx'), /redirect\('\/dashboard'\)/);
  assert.equal(firstAccessibleRoute(ROLE_PERMISSIONS.STAFF), '/orders');
});

// ------------------------------------------------------ sidebar (unchanged) --

test('the sidebar renders the shared navigation - no private copy of the menu', () => {
  const sidebar = read('components/layout/sidebar.tsx');
  assert.match(sidebar, /visibleNavSections\(permissions\)/);
  assert.doesNotMatch(sidebar, /const sections = \[/);
  assert.doesNotMatch(sidebar, /ROUTE_PERMISSIONS\./);
});

test('navigation filtering is unchanged: STAFF sees exactly the 13 pages it may open, no Dashboard', () => {
  // '/toppings' (added with Admin Topping management) needs Product.read, which STAFF
  // already holds: a read-only list. Topping mutations need Product.create/update/delete.
  assert.deepEqual(visibleHrefs(ROLE_PERMISSIONS.STAFF), [
    '/products', '/categories', '/toppings', '/orders', '/payments', '/shipping', '/inventory-reservations',
    '/inventory/products', '/inventory/outlets', '/inventory/transfers', '/outlets',
    '/system/notifications', '/system/communications',
  ]);
});

test('navigation filtering is unchanged for ADMIN, MANAGER and SUPER_ADMIN', () => {
  // '/system/integration-logs' needs IntegrationLog.read, which NO role holds in the
  // matrix — so it is visible to SUPER_ADMIN only, exactly like the other System pages.
  const all = visibleHrefs(ROLE_PERMISSIONS.SUPER_ADMIN);
  assert.equal(all.length, 28); // every menu item (26 + Toppings + Integration Logs)
  assert.ok(visibleHrefs(ROLE_PERMISSIONS.ADMIN).includes('/dashboard'));
  assert.ok(!visibleHrefs(ROLE_PERMISSIONS.ADMIN).includes('/roles')); // Role.read is SUPER_ADMIN-only
  assert.deepEqual(visibleHrefs(ROLE_PERMISSIONS.MANAGER).slice(0, 3), ['/dashboard', '/products', '/categories']);
});

// ---------------------------------------------------------- RBAC untouched --

test('the production RBAC matrix is exactly as applied (STAFF still has no Dashboard.read)', () => {
  assert.equal(ROLE_PERMISSION_MATRIX.ADMIN.length, 48);
  assert.equal(ROLE_PERMISSION_MATRIX.MANAGER.length, 25);
  assert.equal(ROLE_PERMISSION_MATRIX.STAFF.length, 11);
  assert.equal(ROLE_PERMISSION_MATRIX.CUSTOMER.length, 0);
  assert.equal(ROLE_PERMISSION_MATRIX.STAFF.includes('Dashboard.read'), false);
});
