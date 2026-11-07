export function createDb(rows = []) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const db = {
    reads: 0,
    find(id) {
      db.reads++;
      const row = table.get(id);
      return row ? { ...row } : null;
    },
    update(id, patch) {
      const row = table.get(id);
      if (!row) throw new Error(`no product ${id}`);
      Object.assign(row, patch);
      return { ...row };
    },
  };
  return db;
}
