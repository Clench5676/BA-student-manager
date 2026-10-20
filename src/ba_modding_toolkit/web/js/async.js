import { previewTimer } from "./preview-lifecycle.js";

// Bound waits on asset loaders whose callbacks may never arrive. Observe late rejections too.
export function withTimeout(promise, ms, name, { signal } = {}) {
  return bounded(promise, ms, name, (fn, delay) => {
    const timer = setTimeout(fn, delay);
    return () => clearTimeout(timer);
  }, signal);
}

export function withPreviewTimeout(promise, ms, name, { signal } = {}) {
  return bounded(promise, ms, name, previewTimer, signal);
}

function bounded(promise, ms, name, timer, signal) {
  return new Promise((resolve, reject) => {
    let done = false, cancel;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      cancel?.();
      signal?.removeEventListener("abort", aborted);
      fn(value);
    };
    const aborted = () => finish(reject, signal.reason || new DOMException("Aborted", "AbortError"));
    Promise.resolve(promise).then((value) => finish(resolve, value), (err) => finish(reject, err));
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener("abort", aborted, { once: true });
    if (Number.isFinite(ms)) cancel = timer(() => finish(reject, new Error(`${name}: timed out`)), ms);
  });
}
