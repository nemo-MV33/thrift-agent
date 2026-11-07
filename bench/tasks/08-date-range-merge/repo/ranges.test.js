import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlaps, mergeRanges } from './src/ranges.js';

const r = (start, end) => ({ start, end });

test('shared day overlaps', () => {
  assert.equal(overlaps(r('2024-01-01', '2024-01-05'), r('2024-01-05', '2024-01-08')), true);
  assert.equal(overlaps(r('2024-01-01', '2024-01-04'), r('2024-01-05', '2024-01-08')), false);
});

test('merge keeps the longest end', () => {
  const merged = mergeRanges([r('2024-03-01', '2024-03-20'), r('2024-03-05', '2024-03-10'), r('2024-03-20', '2024-03-22')]);
  assert.deepEqual(merged, [r('2024-03-01', '2024-03-22')]);
});

test('separate ranges stay separate', () => {
  assert.deepEqual(mergeRanges([r('2024-05-10', '2024-05-12'), r('2024-05-01', '2024-05-02')]),
    [r('2024-05-01', '2024-05-02'), r('2024-05-10', '2024-05-12')]);
});
