// A temporary scene camera shared by every portrait and the office background; layout data stays unchanged.
import { wheelKind, wheelStep } from "./lobby-touch.js";

const HOME = Object.freeze({ scale: 1, x: 0, y: 0 });
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export function constrainScene(view) {
  const scale = clamp(Number(view.scale) || 1, 1, 3);
  const axis = (n, length) => clamp(Number(n) || 0, length * (1 - scale), 0);
  return { scale, x: axis(view.x, 1920), y: axis(view.y, 1080) };
}
export function sceneRect(rect, view = HOME) {
  return { x: rect.x * view.scale + view.x, y: rect.y * view.scale + view.y,
    width: rect.width * view.scale, height: rect.height * view.scale };
}
export function sceneViewport(view = HOME) {
  return { x: -view.x / view.scale, y: 1080 - (1080 - view.y) / view.scale,
    width: 1920 / view.scale, height: 1080 / view.scale };
}
export function createSceneCamera({ host, enabled = () => true, blocked = () => false, onChange = () => {}, env = globalThis }) {
  let view = { ...HOME }, target = view, frame = null, last = null, disposed = false, gesture = 1, pinchUntil = -Infinity;
  let scroll = { kind: null, at: -Infinity }, drag = null;
  const now = () => env.performance.now();
  const request = (fn) => env.requestAnimationFrame(fn), cancel = (id) => env.cancelAnimationFrame(id);
  const active = () => !disposed && enabled() && !blocked();
  const allowed = (event) => active() && !event.defaultPrevented && !event.target?.closest?.(".hall-chrome, .hall-fullscreen-exit");
  const paint = (immediate = false) => onChange({ ...view }, immediate);
  const tick = (at) => {
    frame = null;
    if (!active()) { target = { ...view }; last = null; return; }
    const dt = last == null ? 1 / 60 : Math.min(.1, Math.max(0, (at - last) / 1000)); last = at;
    const fraction = 1 - Math.exp(-dt / .08);
    view = constrainScene(Object.fromEntries(Object.keys(HOME).map((key) => [key, view[key] + (target[key] - view[key]) * fraction])));
    if (Math.abs(view.scale - target.scale) < .00001 && Math.hypot(view.x - target.x, view.y - target.y) < .02) view = { ...target };
    paint();
    if (view.scale !== target.scale || view.x !== target.x || view.y !== target.y) frame = request(tick);
    else last = null;
  };
  const change = (next) => { target = constrainScene(next); if (frame == null) frame = request(tick); };
  const point = (event) => {
    const box = host.getBoundingClientRect(), factor = box.width ? 1920 / box.width : 1;
    return [(event.clientX - box.left) * factor, (event.clientY - box.top) * factor, factor];
  };
  const zoom = (factor, x, y) => {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const scale = clamp(target.scale * factor, 1, 3), ratio = scale / target.scale;
    change({ scale, x: x - (x - target.x) * ratio, y: y - (y - target.y) * ratio });
  };
  const pan = (dx, dy) => change({ ...target, x: target.x + dx, y: target.y + dy });
  const wheel = (event) => {
    if (!allowed(event)) return;
    event.preventDefault();
    const [x,y,k] = point(event), at = now(), unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    const step = wheelStep(event), notch = () => Math.exp(-Math.sign(event.deltaY) * Math.max(Math.abs(event.deltaY * unit),40) * .0015);
    if (event.ctrlKey) {
      scroll = { kind: null, at: -Infinity };
      if (at >= pinchUntil) zoom(step === "smooth" ? Math.exp(-event.deltaY * unit * .01) : notch(),x,y);
      return;
    }
    const fresh = !(at - scroll.at < 120 && scroll.kind), kind = wheelKind(event,at,scroll);
    if (fresh) scroll = { kind, at, from: kind === "mouse" && !event.deltaMode ? { ...target } : null };
    else {
      if (scroll.kind === "mouse" && kind === "trackpad" && scroll.from) target = { ...scroll.from };
      if (step === "notch" || kind === "trackpad") scroll.from = null;
      scroll.kind = kind; scroll.at = at;
    }
    if (kind === "mouse" && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) zoom(notch(),x,y);
    else pan(-event.deltaX * unit * k,kind === "mouse" ? 0 : -event.deltaY * unit * k);
  };
  const gestureStart = (event) => { if (!allowed(event)) return; event.preventDefault(); gesture = 1; pinchUntil = now() + 300; };
  const gestureChange = (event) => {
    if (!allowed(event)) return;
    event.preventDefault(); pinchUntil = now() + 300;
    const [x,y] = point(event); zoom(event.scale / gesture,x,y); gesture = event.scale;
  };
  const gestureEnd = (event) => { if (allowed(event)) { event.preventDefault(); pinchUntil = now() + 300; } };
  const down = (event) => {
    if (!allowed(event) || ![1,2].includes(event.button)) return;
    event.preventDefault(); const [x,y] = point(event); drag = { id:event.pointerId,x,y };
    host.setPointerCapture?.(event.pointerId);
  };
  const move = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!active() || event.buttons === 0) { up(); return; }
    event.preventDefault(); const [x,y] = point(event); pan(x-drag.x,y-drag.y); drag.x=x;drag.y=y;
  };
  function up(event) { if (!drag || event && event.pointerId !== drag.id) return;
    const id=drag.id;drag=null;try { host.releasePointerCapture?.(id); } catch { /* Capture can already be lost. */ }
  }
  const menu = (event) => { if (allowed(event)) event.preventDefault(); };
  const listeners = [["wheel",wheel,{passive:false}],["gesturestart",gestureStart,{passive:false}],
    ["gesturechange",gestureChange,{passive:false}],["gestureend",gestureEnd,{passive:false}],
    ["pointerdown",down],["pointermove",move],["pointerup",up],["pointercancel",up],["lostpointercapture",up],["contextmenu",menu]];
  for (const args of listeners) host.addEventListener(...args);
  return { view: () => ({ ...view }), target: () => ({ ...target }),
    sync({ reset = false } = {}) {
      if (disposed) return;
      if (!enabled() || reset) {
        if (frame != null) cancel(frame);frame=null;last=null;up();
        scroll={kind:null,at:-Infinity};gesture=1;
        target = { ...view }; if (reset) view=target={...HOME};
        onChange({ ...HOME }, true);
      } else paint(true);
    },
    dispose() { if (disposed) return;disposed=true;if(frame!=null)cancel(frame);up();
      for (const args of listeners) host.removeEventListener(...args);onChange({...HOME}); },
  };
}
