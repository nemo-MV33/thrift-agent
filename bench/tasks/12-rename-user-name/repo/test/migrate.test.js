import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateUser } from '../src/migrate.js';

test('upgrades old records', () => {
  const old = { id: 7, fullname: 'Alan Turing', email: 'alan@example.com' };
  assert.deepEqual(migrateUser(old), { id: 7, name: 'Alan Turing', email: 'alan@example.com' });
  assert.equal(old.fullname, 'Alan Turing', 'input is not mutated');
});

test('leaves new records alone', () => {
  const rec = { id: 8, name: 'Barbara Liskov', email: 'b@example.com' };
  assert.deepEqual(migrateUser(rec), rec);
});
