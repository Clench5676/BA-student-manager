// One extra 3D context at a time. Stills share the detail renderer but never its live camera or lifecycle.
// Source, model files and library metadata identify in-memory results; failed attempts are retryable.
import { withTimeout } from "./async.js";
import { modelUrl, partsOf } from "./switch-sources.js";
import { previewError } from "./preview-error.js";
import { captureRetries } from "./capture-retries.js";
import { onCapturePriorityChange, popupCapturesOpen, popupItem, captureEligible } from "./capture-priority.js";

export const modelStillVersion = (family, variant, generation = 0) => JSON.stringify([
  family.version, variant.model, partsOf(variant, "model"),
  family.variants.flatMap((v) => v.modList || []).filter((m) => m.kind === "model")
    .map(({ alias, label, fresh, ...source }) => source), generation,
]);
export const modelStillKey = (key, source, version) => JSON.stringify([key, source, version, "square-640-v2"]);

export function createModelStills({ renderer = () => import("./model.js"), report = previewError, timeout = 8000 } = {}) {
  const cache = new Map(), queue = [];
  const retries = captureRetries(() => queueMicrotask(pump));
  let running = false, active = null, unwatch = null;
  function focusQueue() {
    if (active && popupCapturesOpen() && !popupItem(active)) {
      active.preempted = true;
      active.controller.abort();
    }
    retries.busy();
    queueMicrotask(pump);
  }
  function complete(item, url, error = null) {
    if (item.done) { if (url) URL.revokeObjectURL(url); return; }
    retries.delete(item);
    if (error) report(error, item.urlSource, "thumbnail:model");
    if (!url && error && item.clients.size && retries.defer(item, error)) {
      const at = queue.indexOf(item);
      if (at >= 0) queue.splice(at, 1);
      return;
    }
    item.done = true; item.url = url; item.error = error;
    if (!url && cache.get(item.key) === item) cache.delete(item.key);
    const at = queue.indexOf(item);
    if (at >= 0) queue.splice(at, 1);
    for (const finish of [...item.clients]) finish(url);
  }
  async function pump() {
    if (running) return;
    running = true;
    try {
      while (true) {
        queue.sort((a, b) => Number(popupItem(b)) - Number(popupItem(a)));
        if (!queue.some(captureEligible)) {
          const retry = retries.take(captureEligible);
          if (retry) queue.unshift(retry);
          else { retries.idle(captureEligible); break; }
        }
        retries.busy();
        const item = queue[0], controller = new AbortController(), { signal } = controller;
        active = item; item.preempted = false;
        item.controller = controller;
        let view;
        const capture = (async () => {
          const module = await renderer();
          signal.throwIfAborted();
          view = module.createStillView();
          await view.load(item.urlSource, { signal });
          signal.throwIfAborted();
          const url = await view.renderStill(signal);
          if (signal.aborted) { if (url) URL.revokeObjectURL(url); return null; }
          if (!url) throw new Error("3D still: no encoded image");
          return url;
        })();
        try {
          const url = await withTimeout(capture, timeout, `3D still ${item.urlSource}`, { signal });
          if (item.preempted) { if (url) URL.revokeObjectURL(url); }
          else complete(item, url);
        } catch (error) {
          if (!item.preempted) complete(item, null, signal.aborted && signal.reason?.name === "AbortError" ? null : error);
        } finally {
          controller.abort();
          view?.dispose();
          item.controller = null; active = null;
        }
      }
    } finally {
      running = false;
      if (![...cache.values()].some((item) => !item.done)) { unwatch?.(); unwatch = null; }
    }
  }
  function thumbnail(variant, source, { version = null, signal } = {}) {
    if (signal?.aborted) return Object.assign(Promise.resolve(null), { thumbnail: true, signal });
    if (!unwatch) unwatch = onCapturePriorityChange(focusQueue);
    const key = modelStillKey(variant, source, version);
    let item = cache.get(key);
    if (!item) {
      item = { key, urlSource: modelUrl(variant, source), clients: new Set(), done: false };
      cache.set(key, item); queue.push(item); queueMicrotask(pump);
    }
    const picture = new Promise((resolve) => {
      const finish = (url) => { signal?.removeEventListener("abort", cancel); item.clients.delete(finish); resolve(url); };
      const cancel = () => {
        finish(null);
        if (!item.done && !item.clients.size) { complete(item, null); item.controller?.abort(); queueMicrotask(pump); }
      };
      finish.signal = signal;
      if (item.done) { resolve(item.url); return; }
      item.clients.add(finish);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    queueMicrotask(pump);
    return Object.assign(picture, { thumbnail: true, signal, failure: () => item.error, bump: () => {
      const at = queue.indexOf(item);
      // An active capture owns the first slot; priority changes only waiting work.
      const first = queue[0]?.controller ? 1 : 0;
      if (at > first) queue.splice(first, 0, ...queue.splice(at, 1));
    } });
  }
  return thumbnail;
}
export const modelThumbnail = createModelStills();
