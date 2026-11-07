function parseLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const [header, ...rows] = lines.map(parseLine);
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}
