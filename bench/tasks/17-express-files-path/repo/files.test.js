import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './src/app.js';

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('returns the nested path', async () => {
  const r = await fetch(`${base}/files/docs/2026/report.pdf`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { path: 'docs/2026/report.pdf' });
});

test('single segment works', async () => {
  const r = await fetch(`${base}/files/a.txt`);
  assert.deepEqual(await r.json(), { path: 'a.txt' });
});

