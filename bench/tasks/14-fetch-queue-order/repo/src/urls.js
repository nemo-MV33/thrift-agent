export function normalizeUrl(url) {
  const u = new URL(url);
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}
