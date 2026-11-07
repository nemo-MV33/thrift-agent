import { addDays } from './dates.js';

export function lineTotal(line) {
  return Math.round(line.qty * line.unitPrice * 100) / 100;
}

export function createInvoice({ id, issued, lines }) {
  const total = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  return {
    id,
    issued,
    dueDate: addDays(issued, 30),
    lines,
    total: Math.round(total * 100) / 100,
  };
}
