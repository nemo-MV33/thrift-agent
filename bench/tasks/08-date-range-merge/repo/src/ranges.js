export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && overlaps(last, r)) {
      last.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
