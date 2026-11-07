export function clientKey(req) {
  return req.headers['x-api-key'] ?? req.ip ?? 'anonymous';
}
