import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toppingFormValues, toppingStatusLabel, validateToppingForm } from './topping-form.ts';
import { ROUTE_PERMISSIONS } from '../access.ts';

/**
 * Admin Topping management (new): the storefront has offered toppings since P0-1, but
 * the Admin Panel had no page, menu entry or API client to manage them. These pin the
 * form rules, the Product.* permission reuse and the page/menu wiring.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

test('form defaults: empty name/price, a new topping starts active (database default)', () => {
  assert.deepEqual(toppingFormValues(), { name: '', price: '', isActive: true });
  assert.deepEqual(toppingFormValues({ name: 'Bihun', price: 5_000, isActive: false }), { name: 'Bihun', price: '5000', isActive: false });
  assert.deepEqual(toppingFormValues({ name: 'Kuah Extra', price: 0, isActive: true }), { name: 'Kuah Extra', price: '0', isActive: true });
});

test('valid input becomes the API payload: trimmed name, integer price, active flag', () => {
  assert.deepEqual(validateToppingForm({ name: '  Telur Puyuh ', price: ' 5000 ', isActive: true }), {
    ok: true,
    payload: { name: 'Telur Puyuh', price: 5_000, isActive: true },
  });
  assert.deepEqual(validateToppingForm({ name: 'Kuah Extra', price: '0', isActive: false }), {
    ok: true,
    payload: { name: 'Kuah Extra', price: 0, isActive: false },
  });
});

test('invalid input is refused with a message per field, matching the API rules', () => {
  const errors = (name: string, price: string) => {
    const r = validateToppingForm({ name, price, isActive: true });
    assert.equal(r.ok, false);
    return r.ok ? {} : r.errors;
  };
  assert.ok(errors('   ', '1000').name);
  assert.ok(errors('x'.repeat(101), '1000').name);
  assert.equal(errors('x'.repeat(100), '').name, undefined, '100 characters is allowed');
  for (const bad of ['', '-1', '1500.5', '1.000', 'abc', '5e3', '99999999999999999999']) {
    assert.ok(errors('Bihun', bad).price, `price "${bad}" must be refused`);
  }
});

test('status label', () => {
  assert.deepEqual(toppingStatusLabel({ isActive: true }), { label: 'Active', tone: 'active' });
  assert.deepEqual(toppingStatusLabel({ isActive: false }), { label: 'Inactive', tone: 'inactive' });
});

test('permissions reuse Product.* - the same names the API decorators require', () => {
  assert.deepEqual(ROUTE_PERMISSIONS.toppings, ['Product.read']);
  assert.deepEqual(ROUTE_PERMISSIONS.toppingCreate, ['Product.create']);
  assert.deepEqual(ROUTE_PERMISSIONS.toppingUpdate, ['Product.update']);
  assert.deepEqual(ROUTE_PERMISSIONS.toppingDelete, ['Product.delete']);
  const api = read('../backend/src/modules/admin/presentation/admin-catalog.controller.ts');
  for (const [perm, verb, path] of [
    ['Product.create', 'Post', "'toppings'"],
    ['Product.read', 'Get', "'toppings'"],
    ['Product.read', 'Get', "'toppings/:id'"],
    ['Product.update', 'Patch', "'toppings/:id'"],
    ['Product.delete', 'Delete', "'toppings/:id'"],
  ]) {
    assert.ok(api.includes(`@Permissions('${perm}') @${verb}(${path})`), `${verb} ${path} requires ${perm}`);
  }
});

test('the Toppings menu item is registered under the read permission, with its icon', () => {
  assert.match(read('lib/navigation.ts'), /\{ href: '\/toppings', label: 'Toppings', icon: 'toppings', permissions: ROUTE_PERMISSIONS\.toppings \}/);
  assert.match(read('components/layout/sidebar.tsx'), /toppings: Soup,/);
});

test('pages are guarded: list = read, new = create, edit = update; mutations only for holders', () => {
  const list = read('app/toppings/page.tsx');
  assert.match(list, /<AdminShell requiredPermissions=\{ROUTE_PERMISSIONS\.toppings\}>/);
  assert.match(list, /<PermissionGate permissions=\{ROUTE_PERMISSIONS\.toppingCreate\}> <Link href="\/toppings\/new">/);
  // Edit + activate/deactivate sit behind the update permission; others see "View only".
  assert.match(list, /<PermissionGate permissions=\{ROUTE_PERMISSIONS\.toppingUpdate\} fallback=\{<span className="text-xs text-gray-400">View only<\/span>\} >/);
  assert.match(list, /updateAdminTopping\(id, \{ isActive \}\)/);
  // The list shows name, price and status for every topping the API returns.
  assert.match(list, /formatRupiahExact\(topping\.price\)/);
  assert.match(list, /toppingStatusLabel\(topping\)/);

  assert.match(read('app/toppings/new/page.tsx'), /<AdminShell requiredPermissions=\{ROUTE_PERMISSIONS\.toppingCreate\}>/);

  const edit = read('app/toppings/[id]/page.tsx');
  assert.match(edit, /<AdminShell requiredPermissions=\{ROUTE_PERMISSIONS\.toppingUpdate\}>/);
  assert.match(edit, /const canDelete = hasAllPermissions\(useAdminPermissions\(\), ROUTE_PERMISSIONS\.toppingDelete\);/);
  assert.match(edit, /onDelete=\{ canDelete \? async/);
});

test('the admin API client talks to the admin catalogue endpoints only', () => {
  const client = read('lib/admin.ts');
  assert.match(client, /api<AdminTopping\[\]>\('\/admin\/catalog\/toppings'\)/);
  assert.match(client, /api<AdminTopping>\('\/admin\/catalog\/toppings', \{ method: 'POST'/);
  assert.match(client, /api<AdminTopping>\(`\/admin\/catalog\/toppings\/\$\{id\}`, \{ method: 'PATCH'/);
  assert.match(client, /api<void>\(`\/admin\/catalog\/toppings\/\$\{id\}`, \{ method: 'DELETE'/);
  const paths = client.match(/[^\s'`(]*catalog\/toppings/g) ?? [];
  assert.equal(paths.length, 5);
  assert.ok(paths.every((p) => p === '/admin/catalog/toppings'), 'never the public storefront list');
});
