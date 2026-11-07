import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInventory } from './src/inventory.js';

test('reserve reduces stock', () => {
  const inv = createInventory({ apple: 10 });
  assert.deepEqual(inv.reserve('apple', 4), { sku: 'apple', qty: 4 });
  assert.equal(inv.available('apple'), 6);
});

test('bad quantities', () => {
  const inv = createInventory({ apple: 10 });
  for (const q of [0, -2, 1.5, '3', NaN]) {
    assert.throws(() => inv.reserve('apple', q), TypeError);
  }
  assert.equal(inv.available('apple'), 10);
});

test('not enough stock', () => {
  const inv = createInventory({ apple: 3 });
  assert.throws(() => inv.reserve('apple', 4), /insufficient stock/);
  assert.throws(() => inv.reserve('pear', 1), /insufficient stock/);
  assert.deepEqual(inv.snapshot(), { apple: 3 });
});
