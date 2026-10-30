import { wheelStep } from "./lobby-touch.js";

// Horizontal UIScrollView input for the popup's existing NGUI list paper.
// Native overflow keeps keyboard focus and touch scrolling inside the same clipped viewport.
export function horizontalScroll(area, width, contentWidth) {
  const limit = Math.max(0, contentWidth - width);
  const moveTo = (left) => { area.scrollLeft = Math.max(0, Math.min(limit, left)); };
  const scale = () => (area.getBoundingClientRect().width / width) || 1;
  area.style.touchAction = "pan-x";
  area.addEventListener("wheel", (event) => {
    if (event.ctrlKey || !limit) return;
    const delta = Math.abs(event.deltaX || 0) >= Math.abs(event.deltaY || 0) ? event.deltaX : event.deltaY;
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? width : 1 / scale();
    moveTo((area.scrollLeft || 0) + delta * unit);
    event.preventDefault();
  }, { passive: false });
  let drag = null, dragged = false;
  area.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragged = false;
    if (event.pointerType === "touch" || !limit) return;
    drag = { id: event.pointerId, x: event.clientX, left: area.scrollLeft || 0 };
  });
  area.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = (event.clientX - drag.x) / scale();
    if (!dragged && Math.abs(dx) <= 6) return;
    dragged = true;
    area.setPointerCapture?.(event.pointerId);
    moveTo(drag.left - dx);
    event.preventDefault();
  });
  const end = () => { drag = null; };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) area.addEventListener(type, end);
  area.addEventListener("pointerleave", () => { if (!dragged) end(); });
  area.addEventListener("click", (event) => {
    if (!dragged || event.detail === 0) return; // Keyboard activation still selects the focused card.
    dragged = false;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  area.addEventListener("dragstart", (event) => event.preventDefault());
}

// Wheel notches need explicit easing in the virtual roster and WebView2's native overflow lists.
// Touchpad pixels, touch gestures and macOS keep their existing scrolling and momentum.
const DURATION = 180;
const moving = new Set();
const clamp = (value, max) => Math.max(0, Math.min(Math.max(0, max), value));

// A bounded, frame-rate-independent ease-out. Restarting from the current position preserves accumulated notches.
export function easeScroll(from, to, elapsed, duration = DURATION) {
  const t = duration <= 0 ? 1 : Math.max(0, Math.min(1, elapsed / duration));
  return from + (to - from) * (1 - (1 - t) ** 3);
}

export function windowsWheel(event, platform) {
  return /^Win/i.test(platform) && !event.ctrlKey && !event.shiftKey && !event.defaultPrevented
    && event.cancelable !== false && !!event.deltaY && !(event.deltaX || 0) && wheelStep(event) === "notch";
}

// read/write use the list's logical pixels; scale converts viewport wheel pixels after the stage transform.
export function wheelScroller({ read, write, max, page, scale = () => 1, alive = () => true }, env = globalThis) {
  let frame = null, from = 0, target = 0, began = 0, last = 0, direction = 0;
  const stop = () => {
    if (frame !== null) env.cancelAnimationFrame(frame);
    frame = null;
    moving.delete(stop);
  };
  const reduced = () => env.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const draw = (at) => {
    frame = null;
    if (!alive() || reduced() || Math.abs(read() - last) > 1) { stop(); return; }
    target = clamp(target, max());
    write(clamp(easeScroll(from, target, at - began), max()));
    last = read();
    if (at - began < DURATION) frame = env.requestAnimationFrame(draw);
    else stop();
  };
  const wheel = (event) => {
    const platform = env.navigator?.userAgentData?.platform || env.navigator?.platform || "";
    if (!windowsWheel(event, platform) || reduced()) { stop(); return false; }
    const current = clamp(read(), max());
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? page() : 1 / (scale() || 1);
    const delta = event.deltaY * unit;
    const continuing = frame !== null && Math.abs(read() - last) <= 1 && direction === Math.sign(delta);
    const next = clamp((continuing ? target : current) + delta, max());
    if (next === current) { stop(); return false; }
    stop();
    from = current; target = next; last = read(); direction = Math.sign(delta); began = env.performance.now();
    event.preventDefault();
    moving.add(stop);
    frame = env.requestAnimationFrame(draw);
    return true;
  };
  return { wheel, stop };
}

// Delegation covers every current and future native vertical list, including nested dialogs and plain fallback UI.
// Existing horizontal lists and scene cameras consume their events before this bubble listener.
export function installVerticalWheel(root = document, env = globalThis) {
  const controllers = new WeakMap();
  const wheel = (event) => {
    if (event.defaultPrevented) return;
    for (let area = event.target; area && area !== root; area = area.parentElement) {
      if (!(area.scrollHeight > area.clientHeight)) continue;
      const style = env.getComputedStyle(area);
      if (!["auto", "scroll"].includes(style.overflowY)) continue;
      let controller = controllers.get(area);
      if (!controller) {
        controller = wheelScroller({ read: () => area.scrollTop || 0, write: top => { area.scrollTop = top; },
          max: () => area.scrollHeight - area.clientHeight, page: () => area.clientHeight,
          scale: () => area.getBoundingClientRect().height / area.clientHeight,
          alive: () => area.isConnected && !!area.getClientRects().length }, env);
        controllers.set(area, controller);
      }
      if (controller.wheel(event)) return;
      // Native trackpad/reduced-motion input stays with the browser's nearest scrollable ancestor.
      if (!windowsWheel(event, env.navigator?.userAgentData?.platform || env.navigator?.platform || "")
        || env.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      if (["contain", "none"].includes(style.overscrollBehaviorY)) return;
    }
  };
  const stop = () => { for (const cancel of moving) cancel(); };
  root.addEventListener("wheel", wheel, { passive: false });
  root.addEventListener("pointerdown", stop, true);
  root.addEventListener("keydown", stop, true);
  root.addEventListener("visibilitychange", stop);
  env.addEventListener?.("blur", stop);
  const motion = env.matchMedia?.("(prefers-reduced-motion: reduce)");
  motion?.addEventListener?.("change", stop);
  return () => {
    stop();
    root.removeEventListener("wheel", wheel);
    root.removeEventListener("pointerdown", stop, true);
    root.removeEventListener("keydown", stop, true);
    root.removeEventListener("visibilitychange", stop);
    env.removeEventListener?.("blur", stop);
    motion?.removeEventListener?.("change", stop);
  };
}
