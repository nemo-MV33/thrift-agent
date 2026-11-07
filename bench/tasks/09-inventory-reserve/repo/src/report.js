export function lowStock(snapshot, threshold = 5) {
  return Object.entries(snapshot)
    .filter(([, qty]) => qty < threshold)
    .map(([sku]) => sku);
}
