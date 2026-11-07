import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, parseDuration } from './src/duration.js';

test('format', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(3_723_000), '1h 2m 3s');
  assert.equal(formatDuration(7_200_000), '2h');
  assert.equal(formatDuration(61_500), '1m 1s');
});

test('parse', () => {
  assert.equal(parseDuration('1h 2m 3s'), 3_723_000);
  assert.equal(parseDuration('45m'), 2_700_000);
  assert.equal(parseDuration('0s'), 0);
});

test('parse rejects garbage', () => {
  for (const bad of ['', 'soon', '5x', '1h two']) {
    assert.throws(() => parseDuration(bad));
  }
});
