import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, resetStore } from '../src/store.js';
import { displayName, initials } from '../src/format.js';
import { handleGetUser } from '../src/api.js';

beforeEach(() => resetStore());

test('store uses name', () => {
  const u = createUser({ name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.deepEqual(u, { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.throws(() => createUser({ email: 'x@example.com' }), /name is required/);
});

test('format uses name', () => {
  assert.equal(displayName({ name: ' Ada Lovelace ', email: 'a@x' }), 'Ada Lovelace');
  assert.equal(initials({ name: 'Ada Lovelace' }), 'AL');
  assert.equal(displayName({ name: '', email: 'a@x' }), 'a@x');
});

test('api returns name', () => {
  createUser({ name: 'Grace Hopper', email: 'grace@example.com' });
  const res = handleGetUser(1);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 1, name: 'Grace Hopper', email: 'grace@example.com', label: 'Grace Hopper' });
});
