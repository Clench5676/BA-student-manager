import { applyAtlasAlpha } from "./spine-alpha.js";

// One view load at a time. A newer request cancels the old one and waits for its cleanup before starting.
export function latestLoad() {
  let tail = Promise.resolve(), active = null;
  const cancel = () => { active?.abort(); active = null; };
  return {
    cancel,
    run(work) {
      cancel();
      const next = active = new AbortController();
      const result = tail.then(async () => {
        if (next.signal.aborted) return null;
        let stop;
        const cancelled = new Promise((resolve) => { stop = () => resolve(null); next.signal.addEventListener("abort", stop, { once: true }); });
        try { return await Promise.race([work(next.signal), cancelled]); }
        finally { next.signal.removeEventListener("abort", stop); }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}

// The runtime does not await success hooks. Settle on hook errors, cancellation, disposal and missing callbacks too.
// Each player owns its atlas and textures; a cancelled player's hooks never touch the next view's state.
export function loadPlayer(create, config, { signal, timeout = 15000, onError } = {}) {
  let player, settled = false, disposed = false, failed = false, timer, resolve, reject;
  const ready = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  const finish = (error = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error); else resolve(disposed ? null : player);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    try { player?.dispose(); } catch (err) { console.error(err); } finally { finish(); }
  };
  const fail = (error, step = "load") => {
    if (failed || disposed || signal?.aborted) return;
    failed = true;
    const cause = error instanceof Error ? error : new Error(String(error));
    cause.url ||= config.skeleton;
    cause.step ||= step;
    const wasReady = settled;
    finish(cause);
    // Render errors after success must not disappear into an already settled promise.
    // Let the runtime return from a synchronous success/error hook before freeing its GPU objects.
    queueMicrotask(() => {
      try { if (wasReady && !signal?.aborted) onError?.(cause); }
      finally { dispose(); }
    });
  };
  if (signal?.aborted) { dispose(); return { ready, dispose, player: null }; }
  try {
    const hooks = Object.fromEntries(["frame", "update", "draw", "updateWorldTransform"].filter((key) => config[key])
      .map((key) => [key, (...args) => {
        if (disposed || failed || signal?.aborted) return;
        try { return config[key](...args); } catch (err) { fail(err, key); }
      }]));
    player = create({
      ...config, ...hooks,
      success: (p) => {
        if (disposed || failed || signal?.aborted) return;
        // Start synchronously: the runtime uses track 0 as soon as this callback returns.
        try { applyAtlasAlpha(p); Promise.resolve(config.success?.(p, () => !disposed && !failed && !signal?.aborted))
          .then(() => finish(), (err) => fail(err, "setup")); } catch (err) { fail(err, "setup"); }
      },
      error: (_p, message) => fail(message, settled ? "render" : "load"),
    });
    signal?.addEventListener("abort", dispose, { once: true });
    if (disposed) player?.dispose(); // a synchronous constructor callback failed
    if (!settled) timer = setTimeout(() => fail(new Error("Spine load timed out"), "load timeout"), timeout);
  } catch (err) { fail(err, "construct"); }
  return { player, ready, dispose };
}
