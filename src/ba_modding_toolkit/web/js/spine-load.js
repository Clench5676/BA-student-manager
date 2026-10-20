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
export function loadPlayer(create, config, { signal, timeout = 15000 } = {}) {
  let player, settled = false, disposed = false, timer, resolve, reject;
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
  const fail = (error) => {
    finish(error instanceof Error ? error : new Error(String(error)));
    // Let the runtime return from a synchronous success/error hook before freeing its GPU objects.
    queueMicrotask(dispose);
  };
  if (signal?.aborted) { dispose(); return { ready, dispose, player: null }; }
  try {
    const hooks = Object.fromEntries(["frame", "update", "draw", "updateWorldTransform"].filter((key) => config[key])
      .map((key) => [key, (...args) => { if (!disposed && !signal?.aborted) return config[key](...args); }]));
    player = create({
      ...config, ...hooks,
      success: (p) => {
        if (disposed || signal?.aborted) return;
        // Start synchronously: the runtime uses track 0 as soon as this callback returns.
        try { Promise.resolve(config.success?.(p, () => !disposed && !signal?.aborted)).then(() => finish(), fail); } catch (err) { fail(err); }
      },
      error: (_p, message) => { if (!disposed) fail(message); },
    });
    signal?.addEventListener("abort", dispose, { once: true });
    if (disposed) player?.dispose(); // a synchronous constructor callback failed
    if (!settled) timer = setTimeout(() => fail(new Error("Spine load timed out")), timeout);
  } catch (err) { fail(err); }
  return { player, ready, dispose };
}
