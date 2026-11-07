function escapeCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows, columns) {
  const out = [columns.join(',')];
  for (const row of rows) out.push(columns.map((c) => escapeCell(row[c])).join(','));
  return out.join('\n');
}
