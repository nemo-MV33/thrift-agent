import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvoice } from './src/invoices.js';

const base = { id: 'INV-1', issued: '2024-01-20', lines: [{ qty: 2, unitPrice: 9.99 }] };

test('default is net 30', () => {
  const inv = createInvoice(base);
  assert.equal(inv.dueDate, '2024-02-19');
  assert.equal(inv.total, 19.98);
});

test('custom net days', () => {
  assert.equal(createInvoice({ ...base, netDays: 15 }).dueDate, '2024-02-04');
  assert.equal(createInvoice({ ...base, netDays: 0 }).dueDate, '2024-01-20');
  assert.equal(createInvoice({ ...base, netDays: 120 }).dueDate, '2024-05-19');
});

test('invalid net days', () => {
  for (const bad of [-1, 121, 1.5, '30', NaN, null]) {
    assert.throws(() => createInvoice({ ...base, netDays: bad }), RangeError);
  }
});
