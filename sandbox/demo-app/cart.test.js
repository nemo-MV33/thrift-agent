import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from './cart.js';

test('multiplies price by quantity', () => {
  assert.equal(total([{ price: 5, qty: 2 }, { price: 1, qty: 3 }]), 13);
});

test('applies discount as percent', () => {
  assert.equal(total([{ price: 100, qty: 1 }], 10), 90);
});
