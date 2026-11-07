export function createCatalog(db) {
  const cache = new Map();

  return {
    db,
    getProduct(id) {
      if (!cache.has(id)) cache.set(id, db.find(id));
      const product = cache.get(id);
      return product ? { ...product } : null;
    },
    updateProduct(id, patch) {
      const updated = db.update(id, patch);
      cache.delete(id);
      return updated;
    },
    clearCache() {
      cache.clear();
    },
  };
}
