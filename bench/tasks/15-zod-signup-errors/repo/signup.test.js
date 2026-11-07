import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignup } from './src/signup.js';

const good = { email: 'a@b.co', password: 'longenough', age: 20, address: { zip: '12345' } };

test('valid input passes', () => {
  assert.deepEqual(validateSignup(good), { ok: true, value: good });
});

test('bad input lists every problem', () => {
  const r = validateSignup({ ...good, email: 'nope', age: 9, address: { zip: 'x' } });
  assert.equal(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['address.zip', 'age', 'email']);
  for (const e of r.errors) assert.equal(typeof e.message, 'string');
});
