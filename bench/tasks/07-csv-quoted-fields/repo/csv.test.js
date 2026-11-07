import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './src/csv.js';

test('plain rows', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [{ a: '1', b: '2' }]);
});

test('quoted commas', () => {
  const rows = parseCsv('name,city\n"Smith, John",Boston\nJane,"Portland, OR"');
  assert.deepEqual(rows, [
    { name: 'Smith, John', city: 'Boston' },
    { name: 'Jane', city: 'Portland, OR' },
  ]);
});

test('escaped quotes and empty cells', () => {
  const rows = parseCsv('q,x\n"He said ""hi""",\n"",z');
  assert.deepEqual(rows, [{ q: 'He said "hi"', x: '' }, { q: '', x: 'z' }]);
});
