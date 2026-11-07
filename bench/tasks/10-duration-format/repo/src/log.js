import { formatDuration } from './duration.js';

export function jobLine(name, startedAt, finishedAt) {
  return `${name} finished in ${formatDuration(finishedAt - startedAt)}`;
}
