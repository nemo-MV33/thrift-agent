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
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new TypeError('qty must be a positive integer');
      }
      const have = stock.get(sku) ?? 0;
      if (have < qty) throw new Error(`insufficient stock for ${sku}`);
      stock.set(sku, have - qty);
      return { sku, qty };
    },
    snapshot() {
      return Object.fromEntries(stock);
    },
  };
}
