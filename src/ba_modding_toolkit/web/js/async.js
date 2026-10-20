// Bound waits on asset loaders whose callbacks may never arrive. Observe late rejections too.
export function withTimeout(promise, ms, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
