import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from './src/emitter.js';

test('once fires one time', () => {
  const e = new Emitter();
  const calls = [];
  e.once('x', (v) => calls.push(v));
  e.emit('x', 1);
  e.emit('x', 2);
  assert.deepEqual(calls, [1]);
  assert.equal(e.listenerCount('x'), 0);
});

test('once does not skip the next listener', () => {
  const e = new Emitter();
  const calls = [];
  e.once('x', () => calls.push('a'));
  e.on('x', () => calls.push('b'));
  e.emit('x');
  assert.deepEqual(calls, ['a', 'b']);
});

test('off removes a once listener by original function', () => {
  const e = new Emitter();
  let n = 0;
  const fn = () => n++;
  e.once('x', fn);
  e.off('x', fn);
  e.emit('x');
  assert.equal(n, 0);
});
