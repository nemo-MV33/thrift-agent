export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWeekend(isoDate) {
  const day = new Date(isoDate + 'T00:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}
