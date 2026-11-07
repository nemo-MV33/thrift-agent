import { getUser } from './store.js';
import { displayName } from './format.js';

export function serialize(user) {
  return { id: user.id, fullname: user.fullname, email: user.email, label: displayName(user) };
}

export function handleGetUser(id) {
  const user = getUser(id);
  if (!user) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: serialize(user) };
}
