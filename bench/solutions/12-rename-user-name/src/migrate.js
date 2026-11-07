// Converts records saved before the fullname -> name rename.
export function migrateUser(record) {
  if (!('fullname' in record)) return record;
  const { fullname, ...rest } = record;
  return { ...rest, name: rest.name ?? fullname };
}
