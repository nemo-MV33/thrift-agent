const UNITS = [
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
];

export function formatDuration(ms) {
  let rest = Math.floor(ms / 1000) * 1000;
  const parts = [];
  for (const [label, size] of UNITS) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${label}`);
    rest -= n * size;
  }
  return parts.length ? parts.join(' ') : '0s';
}

export function parseDuration(text) {
  const tokens = String(text).trim().split(/\s+/);
  if (tokens[0] === '') throw new Error('empty duration');
  let total = 0;
  for (const tok of tokens) {
    const m = /^(\d+)([hms])$/.exec(tok);
    if (!m) throw new Error(`bad duration part: ${tok}`);
    total += Number(m[1]) * UNITS.find(([u]) => u === m[2])[1];
  }
  return total;
}
