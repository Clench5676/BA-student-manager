import { previewLifecycle, previewTimer } from "./preview-lifecycle.js";

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
export function loadPlayer(create, config, { signal, timeout = 15000, onError, onResume, onRecover, manual = false } = {}) {
  let player, settled = false, disposed = false, failed = false, assetsReady = false, cancelTimer, frameTimer, resolve, reject;
  const ready = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  const finish = (error = null) => {
    if (settled) return;
    settled = true;
    cancelTimer?.();
    clearTimeout(frameTimer);
    if (error) reject(error); else resolve(disposed ? null : player);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    lifecycle.dispose();
    try { player?.dispose(); } catch (err) { console.error(err); } finally { finish(); }
  };
  const lifecycle = previewLifecycle({
    suspend: () => player?.stopRendering?.(),
    resume: () => {
      if (disposed || failed || manual) return;
      player?.time?.update?.();
      if (player?.time) player.time.delta = 0;
      const render = onResume?.() !== false;
      if (render && player?.stopRequestAnimationFrame) {
        // Let the old queued frame observe stopRendering before starting a single fresh loop.
        (globalThis.requestAnimationFrame || queueMicrotask)(() => {
          if (!disposed && !failed && lifecycle.active() && player.stopRequestAnimationFrame) player.startRendering?.();
        });
      }
    },
    recover: () => {
      if (disposed || failed || signal?.aborted) return;
      if (onRecover) onRecover();
      else fail(new Error("Spine context recovery unavailable"), "context recovery");
    },
  });
  const fail = (error, step = "load") => {
    if (failed || disposed || signal?.aborted) return;
    if (!manual && (lifecycle.recovering() || (!lifecycle.active() && ["render", "frame", "draw", "update", "updateWorldTransform"].includes(step)))) {
      lifecycle.invalidate();
      return;
    }
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
        if (disposed || failed || signal?.aborted || (!manual && settled && !lifecycle.active())) return;
        try { return config[key](...args); } catch (err) { fail(err, key); }
      }]));
    player = create({
      ...config, ...hooks,
      success: (p) => {
        if (disposed || failed || signal?.aborted) return;
        assetsReady = true;
        // Start synchronously: the runtime uses track 0 as soon as this callback returns.
        try { Promise.resolve(config.success?.(p, () => !disposed && !failed && !signal?.aborted))
          .then(() => finish(), (err) => fail(err, "setup")); } catch (err) { fail(err, "setup"); }
      },
      error: (_p, message) => fail(message, settled ? "render" : "load"),
    });
    lifecycle.watch(player?.canvas);
    if (manual || !lifecycle.active()) player?.stopRendering?.();
    signal?.addEventListener("abort", dispose, { once: true });
    if (disposed) player?.dispose(); // a synchronous constructor callback failed
    if (!settled) {
      const expired = () => fail(new Error("Spine load timed out"), "load timeout");
      if (manual) {
        const timer = setTimeout(expired, timeout);
        cancelTimer = () => clearTimeout(timer);
      } else cancelTimer = previewTimer(expired, timeout);
      // The runtime discovers downloaded assets in drawFrame, even before its
      // success hook. Bootstrap paused players too, without starting a second
      // animation loop or resuming continuous playback in a background window.
      const render = () => {
        if (settled || disposed || failed || signal?.aborted || (manual && assetsReady)) return;
        if ((manual || !lifecycle.active()) && !lifecycle.recovering()) {
          try {
            if (manual) player.drawFrame(false);
            else player.drawFrame?.(false);
          } catch (err) { fail(err, "render"); }
        }
        if (!settled && !disposed && !failed && !signal?.aborted && !(manual && assetsReady)) frameTimer = setTimeout(render, 32);
      };
      queueMicrotask(render);
    }
  } catch (err) { fail(err, "construct"); }
  return { player, ready, dispose, active: lifecycle.active };
}
