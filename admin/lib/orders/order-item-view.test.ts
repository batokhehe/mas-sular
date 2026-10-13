import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderItemPricing } from './order-item-view.ts';

/**
 * Admin Order Detail — topping prices on the item line (staging E2E finding).
 *
 * Before: the line showed "Qty 1 × Rp 45.000" and a right-hand total of
 * unitPrice × quantity = Rp 45.000, with the toppings as bare names - while the
 * order subtotal (and what the customer paid) was Rp 53.000. The stored
 * OrderItemTopping.price snapshots were in the API response but never shown.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

// The supervised staging order BMS-20260914-QSVGENC3, as GET /admin/orders/:id returns its item.
const E2E_ITEM = {
  unitPrice: 45_000,
  quantity: 1,
  toppings: [
    { orderItemId: 'oi-1', toppingId: 'bihun', name: 'Bihun', price: 5_000 },
    { orderItemId: 'oi-1', toppingId: 'kerupuk', name: 'Kerupuk', price: 3_000 },
  ],
};

test('1+2. topping names AND their stored prices are exposed for display', () => {
  const view = orderItemPricing(E2E_ITEM);
  assert.deepEqual(view.toppings, [
    { key: 'bihun', name: 'Bihun', price: 5_000 },
    { key: 'kerupuk', name: 'Kerupuk', price: 3_000 },
  ]);
});

test('3. line total = (unit + toppings) × qty - matches the order subtotal the customer paid', () => {
  const view = orderItemPricing(E2E_ITEM);
  assert.equal(view.unitPrice, 45_000, 'the base price line is unchanged');
  assert.equal(view.toppingsPerUnit, 8_000);
  assert.equal(view.unitTotal, 53_000);
  assert.equal(view.lineTotal, 53_000); // Order.subtotal of BMS-20260914-QSVGENC3
  assert.equal(orderItemPricing({ ...E2E_ITEM, quantity: 3 }).lineTotal, 159_000, 'toppings are per unit');
});

test('4. historical prices come from the order snapshot only - a later catalog price change cannot move them', () => {
  // The same stored item priced "before" and "after" the catalog changed Bihun to Rp 7.000:
  // nothing but the item itself is an input, so the result is identical.
  const before = orderItemPricing(E2E_ITEM);
  const catalogNow = { bihun: 7_000 }; // deliberately unused by the pricing function
  void catalogNow;
  assert.deepEqual(orderItemPricing(structuredClone(E2E_ITEM)), before);
  assert.equal(orderItemPricing.length, 1, 'no second (catalog) argument exists');
  // The page never asks the catalog for topping prices, and the backend detail reads the order's rows.
  const page = read('app/orders/[id]/page.tsx');
  assert.doesNotMatch(page, /catalog\/toppings|fetchToppings|listToppings/);
  const backend = read('../backend/src/modules/admin/admin.service.ts');
  assert.match(backend, /items: \{ include: \{ toppings: true, product: \{ select: \{ id: true, sku: true, imageUrl: true \} \} \} \}/);
  assert.match(read('../backend/prisma/schema.prisma'), /model OrderItemTopping \{ orderItemId String toppingId String name String price Int/);
});

test('5. an item without toppings prices exactly as before (unitPrice × qty, no topping block)', () => {
  for (const toppings of [[], undefined, null]) {
    const view = orderItemPricing({ unitPrice: 8_000, quantity: 3, toppings });
    assert.deepEqual(view, { unitPrice: 8_000, toppings: [], toppingsPerUnit: 0, unitTotal: 8_000, lineTotal: 24_000 });
  }
});

test('6. multiple toppings (including a free one) keep order and each price', () => {
  const view = orderItemPricing({
    unitPrice: 42_000,
    quantity: 2,
    toppings: [
      { toppingId: 'telur', name: 'Telur Puyuh', price: 5_000 },
      { toppingId: 'sambal', name: 'Extra Sambal', price: 2_000 },
      { toppingId: 'kuah', name: 'Kuah Extra', price: 0 },
    ],
  });
  assert.deepEqual(view.toppings.map((t) => [t.name, t.price]), [['Telur Puyuh', 5_000], ['Extra Sambal', 2_000], ['Kuah Extra', 0]]);
  assert.equal(view.unitTotal, 49_000);
  assert.equal(view.lineTotal, 98_000);
});

test('the page renders base price, each "+ topping price", the per-item total and the priced line total', () => {
  const page = read('app/orders/[id]/page.tsx');
  assert.match(page, /const pricing = orderItemPricing\(item\);/);
  assert.match(page, /Qty \{item\.quantity\} × \{rp\(item\.unitPrice\)\}/, 'base price line kept');
  assert.match(page, /\{pricing\.toppings\.length > 0 \? \(/, 'topping block only when there are toppings');
  assert.match(page, /<span>\+ \{t\.name\}<\/span> <span>\{rp\(t\.price\)\}<\/span>/);
  assert.match(page, /Per item termasuk topping<\/span> <span>\{rp\(pricing\.unitTotal\)\}<\/span>/);
  assert.match(page, /\{rp\(pricing\.lineTotal\)\}/);
  assert.doesNotMatch(page, /rp\(item\.unitPrice \* item\.quantity\)/, 'the base-only line total is gone');
  assert.doesNotMatch(page, /Toppings: \{item\.toppings\.map/, 'no more names-only line');
  // The admin type now matches the API rows (OrderItemTopping has toppingId, not id).
  assert.match(read('lib/admin.ts'), /toppings: Array<\{ toppingId: string; name: string; price: number \}>;/);
});
