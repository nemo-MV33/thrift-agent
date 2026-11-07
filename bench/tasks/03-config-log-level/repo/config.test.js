import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './src/config.js';

test('defaults', () => {
  assert.deepEqual(loadConfig({}), { port: 3000, host: 'localhost', logLevel: 'info', debug: false });
});

test('reads LOG_LEVEL', () => {
  assert.equal(loadConfig({ LOG_LEVEL: 'debug' }).logLevel, 'debug');
});

test('rejects unknown level', () => {
  assert.throws(() => loadConfig({ LOG_LEVEL: 'loud' }));
});
