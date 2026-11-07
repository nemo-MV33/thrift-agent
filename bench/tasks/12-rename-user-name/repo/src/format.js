export function displayName(user) {
  return user.fullname?.trim() || user.email;
}

export function initials(user) {
  return displayName(user)
    .split(/\s+/)
    .map((part) => part[0].toUpperCase())
    .join('');
}
