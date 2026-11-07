import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total, applyCoupon } from './src/cart.js';

const items = [{ price: 20, qty: 2 }, { price: 10, qty: 1 }];

test('no coupon', () => {
  assert.equal(total(items), 50);
});

test('percent coupon takes a share off', () => {
  assert.equal(total(items, { type: 'percent', value: 10 }), 45);
  assert.equal(applyCoupon(19.99, { type: 'percent', value: 25 }), 14.99);
});

test('fixed coupon never goes below zero', () => {
  assert.equal(total(items, { type: 'fixed', value: 80 }), 0);
});
