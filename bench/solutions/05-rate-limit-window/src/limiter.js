const WINDOW_MS = 60_000; // one minute

export function createLimiter({ limit = 5, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const entry = hits.get(key);
      if (!entry || t - entry.start >= WINDOW_MS) {
        hits.set(key, { start: t, count: 1 });
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count++;
      return true;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
