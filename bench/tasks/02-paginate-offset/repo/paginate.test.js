import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from './src/paginate.js';

const list = Array.from({ length: 25 }, (_, i) => i + 1);

test('first page starts at the first item', () => {
  assert.deepEqual(paginate(list, 1, 10).items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('last page holds the remainder', () => {
  const p = paginate(list, 3, 10);
  assert.deepEqual(p.items, [21, 22, 23, 24, 25]);
  assert.equal(p.totalPages, 3);
});
