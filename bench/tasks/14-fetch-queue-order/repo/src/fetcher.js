import { runAll } from './queue.js';

export async function fetchAll(urls, fetchFn, { concurrency = 3, onProgress } = {}) {
  let done = 0;
  const tasks = urls.map((url) => async () => {
    const res = fetchFn(url);
    done++;
    onProgress?.(done, urls.length);
    return res;
  });
  return runAll(tasks, { concurrency });
}
