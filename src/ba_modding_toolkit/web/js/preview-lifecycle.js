// A background window has no reliable frame clock. Resume with fresh clocks; lost contexts need new GPU owners.
export function previewLifecycle({ suspend = () => {}, resume = () => {}, recover = () => {} } = {},
  { document: doc = globalThis.document, window: win = globalThis.window, now = () => performance.now() } = {}) {
  let focused = doc?.hasFocus?.() ?? true, away = !!doc?.hidden || !focused, disposed = false, rebuilding = false;
  const lost = new Set(), cleanups = [];
  const listen = (target, type, fn, capture = false) => {
    target?.addEventListener?.(type, fn, capture);
    cleanups.push(() => target?.removeEventListener?.(type, fn, capture));
  };
  const active = () => !disposed && !away && !lost.size && !rebuilding;
  const rebuild = () => queueMicrotask(() => {
    if (disposed || away || lost.size || !rebuilding) return;
    rebuilding = false;
    recover();
  });
  const changed = () => {
    const hidden = !!doc?.hidden || !focused;
    if (hidden === away) return;
    away = hidden;
    if (away) suspend();
    else if (rebuilding) rebuild();
    else if (!lost.size) resume(now());
  };
  listen(doc, "visibilitychange", () => { focused = doc?.hasFocus?.() ?? focused; changed(); });
  listen(win, "blur", () => { focused = false; changed(); });
  listen(win, "focus", () => { focused = true; changed(); });
  return {
    active,
    recovering: () => !!lost.size || rebuilding,
    watch(canvas) {
      listen(canvas, "webglcontextlost", (event) => {
        event.preventDefault();
        lost.add(canvas); rebuilding = true;
        suspend();
      }, true);
      listen(canvas, "webglcontextrestored", () => { lost.delete(canvas); rebuild(); }, true);
    },
    invalidate() { rebuilding = true; suspend(); rebuild(); },
    dispose() { disposed = true; cleanups.splice(0).forEach((fn) => fn()); },
  };
}

// Deadlines count foreground time, including waits for requestAnimationFrame during initial loading.
export function previewTimer(callback, ms, env = {}) {
  const now = env.now || (() => performance.now());
  let timer, started, remaining = ms, done = false;
  const pause = () => {
    clearTimeout(timer);
    if (started != null) remaining -= Math.max(0, now() - started);
    started = null;
  };
  const start = () => {
    if (done) return;
    started = now();
    timer = setTimeout(() => { cancel(); callback(); }, Math.max(0, remaining));
  };
  const lifecycle = previewLifecycle({ suspend: pause, resume: start }, env);
  const cancel = () => { done = true; clearTimeout(timer); lifecycle.dispose(); };
  if (lifecycle.active()) start();
  return cancel;
}
