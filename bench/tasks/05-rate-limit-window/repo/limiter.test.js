import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from './src/limiter.js';

test('blocks for the rest of the minute', () => {
  let t = 0;
  const limiter = createLimiter({ limit: 3, now: () => t });
  for (let i = 0; i < 3; i++) assert.equal(limiter.allow('a'), true);
  t = 1000;
  assert.equal(limiter.allow('a'), false);
  t = 59_999;
  assert.equal(limiter.allow('a'), false);
  t = 60_000;
  assert.equal(limiter.allow('a'), true);
});
