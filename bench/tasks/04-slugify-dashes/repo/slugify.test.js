import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './src/slugify.js';

test('basic', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('accents and edges', () => {
  assert.equal(slugify('  Crème brûlée  '), 'creme-brulee');
  assert.equal(slugify('...Why?'), 'why');
});
