function parseLine(line) {
  return line.split(',');
}

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const [header, ...rows] = lines.map(parseLine);
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}
