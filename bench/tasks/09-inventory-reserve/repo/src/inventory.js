export function createInventory(initial = {}) {
  const stock = new Map(Object.entries(initial));

  return {
    available(sku) {
      return stock.get(sku) ?? 0;
    },
    restock(sku, qty) {
      stock.set(sku, (stock.get(sku) ?? 0) + qty);
    },
    reserve(sku, qty) {
      stock.set(sku, (stock.get(sku) ?? 0) - qty);
      return { sku, qty };
    },
    snapshot() {
      return Object.fromEntries(stock);
    },
  };
}
