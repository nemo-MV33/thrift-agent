export async function runAll(tasks, { concurrency = 2 } = {}) {
  const results = [];
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      results.push(await task());
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}
