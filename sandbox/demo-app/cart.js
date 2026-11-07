export function total(items, discount = 0) {
  const sum = items.reduce((acc, item) => acc + item.price, 0);
  return sum - discount;
}
