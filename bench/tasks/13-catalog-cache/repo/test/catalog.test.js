import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createCatalog } from '../src/catalog.js';
import { priceFor, setPrice } from '../src/pricing.js';

const seed = () => createDb([{ id: 'a', price: 10 }, { id: 'b', price: 2.5 }]);

test('repeated lookups read once per id', () => {
  const db = seed();
  const cat = createCatalog(db);
  cat.getProduct('a');
  cat.getProduct('a');
  priceFor(cat, 'a', 3);
  cat.getProduct('b');
  assert.equal(db.reads, 2);
});

test('setPrice is visible right away', () => {
  const db = seed();
  const cat = createCatalog(db);
  assert.equal(priceFor(cat, 'a', 1), 10);
  setPrice(cat, 'a', 12);
  assert.equal(priceFor(cat, 'a', 1), 12);
  assert.equal(priceFor(cat, 'a', 10), 108);
});

test('cached product cannot be changed by callers', () => {
  const cat = createCatalog(seed());
  cat.getProduct('b').price = 999;
  assert.equal(cat.getProduct('b').price, 2.5);
});
