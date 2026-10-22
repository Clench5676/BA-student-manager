import { previewTimer } from "./preview-lifecycle.js";

// Hidden or unfocused WebKit windows may stop their frame clock. Resource setup
// can still finish there; continuous playback remains governed by its lifecycle.
export function nextFrame({ signal } = {}) {
  return new Promise((resolve) => {
    let frame, timer, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      globalThis.cancelAnimationFrame?.(frame);
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const check = () => {
      if (globalThis.document?.hidden || globalThis.document?.hasFocus?.() === false
          || !globalThis.requestAnimationFrame) finish();
      else timer = setTimeout(check, 100);
    };
    if (signal?.aborted) { finish(); return; }
    signal?.addEventListener("abort", finish, { once: true });
    frame = globalThis.requestAnimationFrame?.(finish);
    if (!done) timer = setTimeout(check, 100);
  });
}

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
