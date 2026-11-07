import { addDays } from './dates.js';

export function lineTotal(line) {
  return Math.round(line.qty * line.unitPrice * 100) / 100;
}

export function createInvoice({ id, issued, lines, netDays = 30 }) {
  if (!Number.isInteger(netDays) || netDays < 0 || netDays > 120) {
    throw new RangeError('netDays must be a whole number from 0 to 120');
  }
  const total = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  return {
    id,
    issued,
    dueDate: addDays(issued, netDays),
    lines,
    total: Math.round(total * 100) / 100,
  };
}
