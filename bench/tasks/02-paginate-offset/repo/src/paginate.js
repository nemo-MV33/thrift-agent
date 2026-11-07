export function totalPages(count, perPage) {
  return Math.max(1, Math.ceil(count / perPage));
}

export function paginate(items, page = 1, perPage = 10) {
  const start = page * perPage;
  return {
    page,
    perPage,
    totalPages: totalPages(items.length, perPage),
    items: items.slice(start, start + perPage),
  };
}
