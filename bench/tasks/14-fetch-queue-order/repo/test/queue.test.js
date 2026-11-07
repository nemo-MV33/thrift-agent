import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../src/queue.js';
import { delay } from './helpers.js';

test('results keep task order', async () => {
  const tasks = [30, 5, 15, 1].map((ms, i) => async () => { await delay(ms); return i; });
  assert.deepEqual(await runAll(tasks, { concurrency: 2 }), [0, 1, 2, 3]);
});
