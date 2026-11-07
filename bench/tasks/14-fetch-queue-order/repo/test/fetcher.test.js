import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAll } from '../src/fetcher.js';
import { delay } from './helpers.js';

test('order, concurrency and progress', async () => {
  const delays = { a: 30, b: 5, c: 15, d: 1, e: 8 };
  let inFlight = 0;
  let maxInFlight = 0;
  let finished = 0;
  const progress = [];
  const fetchFn = async (url) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(delays[url]);
    inFlight--;
    finished++;
    return url.toUpperCase();
  };
  const out = await fetchAll(Object.keys(delays), fetchFn, {
    concurrency: 2,
    onProgress: (done, total) => progress.push([done, finished, total]),
  });
  assert.deepEqual(out, ['A', 'B', 'C', 'D', 'E']);
  assert.ok(maxInFlight <= 2, `max in flight was ${maxInFlight}`);
  assert.equal(progress.length, 5);
  for (const [done, fin, total] of progress) {
    assert.equal(done, fin);
    assert.equal(total, 5);
  }
});
