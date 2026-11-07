export function truncate(text, max = 80) {
  return text.length <= max ? text : text.slice(0, max - 3) + '...';
}
