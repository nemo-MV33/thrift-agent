import { roundCents } from './util.js';

export function priceFor(catalog, id, qty = 1) {
  const product = catalog.getProduct(id);
  if (!product) throw new Error(`unknown product ${id}`);
  const discount = qty >= 10 ? 0.1 : 0;
  return roundCents(product.price * qty * (1 - discount));
}

export function setPrice(catalog, id, price) {
  if (!(price >= 0)) throw new RangeError('price must be non-negative');
  return catalog.db.update(id, { price });
}
