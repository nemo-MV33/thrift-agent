export function sortBy(items, key, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => (a[key] > b[key] ? sign : a[key] < b[key] ? -sign : 0));
}
