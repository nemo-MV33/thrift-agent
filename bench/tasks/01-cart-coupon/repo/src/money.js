export function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

export function formatMoney(value, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}
