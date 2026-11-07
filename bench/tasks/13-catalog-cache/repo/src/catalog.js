export function createCatalog(db) {
  return {
    db,
    getProduct(id) {
      return db.find(id);
    },
  };
}
