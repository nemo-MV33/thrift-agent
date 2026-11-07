export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function rangeLength(r) {
  return daysBetween(r.start, r.end) + 1;
}
