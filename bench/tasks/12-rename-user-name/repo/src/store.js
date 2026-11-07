let nextId = 1;
const users = new Map();

export function createUser({ fullname, email }) {
  if (!fullname) throw new Error('fullname is required');
  const user = { id: nextId++, fullname, email };
  users.set(user.id, user);
  return user;
}

export function getUser(id) {
  return users.get(id) ?? null;
}

export function updateUser(id, patch) {
  const user = users.get(id);
  if (!user) return null;
  Object.assign(user, patch);
  return user;
}

export function resetStore() {
  users.clear();
  nextId = 1;
}
