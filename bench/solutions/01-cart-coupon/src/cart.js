import { roundMoney } from './money.js';

export function subtotal(items) {
  return roundMoney(items.reduce((sum, item) => sum + item.price * item.qty, 0));
}

export function applyCoupon(amount, coupon) {
  if (!coupon) return amount;
  if (coupon.type === 'percent') {
    return roundMoney(amount * (1 - coupon.value / 100));
  }
  if (coupon.type === 'fixed') {
    return roundMoney(Math.max(0, amount - coupon.value));
  }
  return amount;
}

export function total(items, coupon) {
  return applyCoupon(subtotal(items), coupon);
}
