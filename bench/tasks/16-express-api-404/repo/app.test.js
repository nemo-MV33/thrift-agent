import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './src/app.js';

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('known routes still work', async () => {
  const r = await fetch(`${base}/api/users/7`);
  assert.deepEqual(await r.json(), { id: '7' });
});

test('unknown api route returns json 404', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const r = await fetch(`${base}/api/nope/deeper`, { method });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'not found', path: '/api/nope/deeper' });
  }
});
