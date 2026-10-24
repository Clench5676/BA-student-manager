// Card gestures own their pointer stream; the surrounding UIScrollView remains independently scrollable.
export const TOUCH_REORDER_HOLD = 260;
const TOUCH_SLOP = 9, DRAG_SLOP = 4, EDGE_WIDTH = 64, EDGE_SPEED = 640;
export function dragFeedback(visual, marker, pitch, count) {
  let ghost = null, originalOpacity = "", offset = null, lift = 0;
  const targetMarker = () => typeof marker === "function" ? marker() : marker;
  const cleanup = () => {
    const owned = !!offset;
    ghost?.remove(); ghost = null;
    if (offset) visual.style.opacity = originalOpacity;
    offset = null;
    if (owned && targetMarker()) targetMarker().hidden = true;
  };
  return {
    start(event) {
      cleanup();
      const rect = visual.getBoundingClientRect(), width = visual.offsetWidth || rect.width;
      offset = [event.clientX - rect.left, event.clientY - rect.top];
      lift = event.pointerType === "touch" ? 24 : 0;
      originalOpacity = visual.style.opacity; visual.style.opacity = ".5";
      // Clone the decoded DOM thumbnail, retaining its current frame and clipping without recapturing Spine.
      ghost = visual.cloneNode(true); ghost.removeAttribute("id"); ghost.setAttribute("aria-hidden", "true"); ghost.inert = true;
      Object.assign(ghost.style, { position: "fixed", inset: "auto", width: `${width}px`, height: `${visual.offsetHeight || rect.height}px`,
        margin: "0", opacity: "1", pointerEvents: "none", zIndex: "10000", transformOrigin: "top left", transform: `scale(${rect.width / width})` });
      visual.ownerDocument.body.appendChild(ghost);
    },
    update(event, target) {
      if (!ghost) return;
      ghost.style.left = `${event.clientX - offset[0]}px`; ghost.style.top = `${event.clientY - offset[1] - lift}px`;
      const current = targetMarker();
      if (current) {
        const width = current.offsetWidth || 10, end = Number.isFinite(count) ? count * pitch - width : Infinity;
        current.hidden = false; current.style.transform = `translateX(${Math.max(0, Math.min(end, target * pitch - width / 2))}px)`;
      }
    },
    cleanup,
  };
}
export function bindReorder(hit, { id, index, count, scroll, pitch, move, enabled = () => true, signal, feedback = null }) {
  if (signal?.aborted) return () => {};
  let drag = null, holdTimer = null, edgeFrame = null, edgeTime = null, suppressClick = false;
  const surface = hit.ownerDocument || hit, window = surface.defaultView || globalThis;
  const requestFrame = window.requestAnimationFrame?.bind(window) || ((fn) => setTimeout(() => fn(performance.now()), 16));
  const cancelFrame = window.cancelAnimationFrame?.bind(window) || clearTimeout;
  const capture = scroll.setPointerCapture ? scroll : hit;
  hit.tabIndex = 0; hit.draggable = false;
  Object.assign(hit.style, { touchAction: "none", cursor: "grab", userSelect: "none", webkitUserSelect: "none", webkitTouchCallout: "none" });
  hit.setAttribute?.("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
  const geometry = () => {
    const rect = scroll.getBoundingClientRect();
    return { rect, scale: rect.width / scroll.clientWidth || 1, max: Math.max(0, count * pitch - scroll.clientWidth) };
  };
  const setScroll = (left, max) => { scroll.scrollLeft = Math.max(0, Math.min(max, left)); };
  const clearHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  const clearEdge = () => { if (edgeFrame != null) cancelFrame(edgeFrame); edgeFrame = null; edgeTime = null; };
  const point = (event) => ({ clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType || drag?.type || "mouse" });
  const paint = () => {
    if (!drag || drag.phase !== "drag") return;
    const { rect, scale } = geometry(), x = (drag.latest.clientX - rect.left) / scale;
    drag.gap = Math.max(0, Math.min(count, Math.round((x + scroll.scrollLeft) / pitch)));
    feedback?.update(drag.latest, drag.gap);
  };
  const edgeVelocity = () => {
    if (!drag || drag.phase !== "drag") return 0;
    const { rect, scale, max } = geometry(), {clientX:x,clientY:y} = drag.latest;
    if (!max || y < rect.top - 80 || y > rect.top + rect.height + 80) return 0;
    const zone = Math.min(EDGE_WIDTH, rect.width / 4), right = rect.left + rect.width;
    if (x < rect.left + zone && scroll.scrollLeft > 0) return -EDGE_SPEED * Math.min(1, (rect.left + zone - x) / zone) / scale;
    if (x > right - zone && scroll.scrollLeft < max) return EDGE_SPEED * Math.min(1, (x - right + zone) / zone) / scale;
    return 0;
  };
  const scheduleEdge = () => {
    if (edgeFrame != null || !edgeVelocity()) return;
    edgeFrame = requestFrame((now) => {
      edgeFrame = null;
      if (!drag || drag.phase !== "drag") return;
      if (!enabled() || signal?.aborted) { finish({}, true); return; }
      const velocity = edgeVelocity(), dt = edgeTime == null ? 16 : Math.max(0, Math.min(64, now - edgeTime)); edgeTime = now;
      if (!velocity) { clearEdge(); return; }
      setScroll(scroll.scrollLeft + velocity * dt / 1000, geometry().max);
      paint(); scheduleEdge();
    });
  };
  const activate = () => {
    if (!drag || drag.phase !== "pending" || !enabled()) return;
    clearHold(); drag.phase = "drag"; hit.dataset.reordering = "true"; hit.style.cursor = "grabbing";
    feedback?.start(drag.initial); paint(); scheduleEdge();
  };
  const update = (event) => {
    if (!drag || (event.pointerId != null && event.pointerId !== drag.pointer)) return;
    if (!enabled()) { finish(event, true); return; }
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    drag.latest = point(event);
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (drag.phase === "pending") {
      if (drag.type !== "touch" && Math.hypot(dx, dy) > DRAG_SLOP) activate();
      else if (drag.type === "touch" && Math.hypot(dx, dy) > TOUCH_SLOP) {
        clearHold(); drag.phase = "pan";
      }
    }
    if (drag.phase === "pan") {
      const {scale,max} = geometry(); setScroll(drag.startScroll - dx / scale, max);
    } else if (drag.phase === "drag") { paint(); if (edgeVelocity()) scheduleEdge(); else clearEdge(); }
    event.preventDefault?.(); event.stopPropagation?.();
  };
  function finish(event, cancel = false) {
    if (!drag || (event.pointerId != null && event.pointerId !== drag.pointer)) return;
    // Coalesced native drags may deliver only the final pointerup position.
    if (!cancel) update(event);
    if (!drag) return;
    const previous = drag; drag = null; clearHold(); clearEdge();
    delete hit.dataset.reordering; delete hit.dataset.pointerOwned; hit.style.cursor = "grab";
    suppressClick = previous.phase !== "pending";
    feedback?.cleanup();
    try { capture.releasePointerCapture?.(previous.pointer); } catch { /* Capture may already have been released. */ }
    const target = previous.gap - (previous.gap > index ? 1 : 0);
    if (!cancel && previous.phase === "drag" && enabled() && target !== index && target >= 0 && target < count) move(id, target);
  }
  const down = (event) => {
    if (event.button !== 0 || event.isPrimary === false || !enabled() || signal?.aborted || drag) return;
    const type = event.pointerType || "mouse";
    drag = { pointer:event.pointerId, type, startX:event.clientX, startY:event.clientY, startScroll:scroll.scrollLeft,
      gap:index, phase:"pending", initial:point(event), latest:point(event) };
    hit.dataset.pointerOwned = "true"; suppressClick = false;
    try { capture.setPointerCapture?.(event.pointerId); } catch { /* The document listeners still retain the pointer. */ }
    // Without claiming this event, horizontalScroll starts panning the same mouse drag beneath the reorder.
    event.preventDefault(); event.stopPropagation?.(); hit.focus({preventScroll:true});
    if (type === "touch") holdTimer = setTimeout(activate, TOUCH_REORDER_HOLD);
  };
  const anotherPointer = (event) => {
    if (drag && event.pointerId !== drag.pointer && (event.pointerType === "touch" || drag.type === "touch")) finish({}, true);
  };
  const up = (event) => finish(event), cancel = (event) => finish(event, true);
  const scrolled = () => { if (drag?.phase === "drag") { paint(); scheduleEdge(); } };
  const blur = () => finish({}, true), visibility = () => { if (surface.hidden) blur(); };
  const click = (event) => { if (suppressClick && event.detail !== 0) { suppressClick=false; event.preventDefault(); event.stopImmediatePropagation?.(); } };
  const contextMenu = (event) => { if (drag) { event.preventDefault(); event.stopPropagation?.(); } };
  const key = (event) => {
    if (event.key === "Escape" && drag) { event.preventDefault(); event.stopPropagation?.(); finish({}, true); return; }
    if (!enabled() || !event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); const next=index+(event.key === "ArrowLeft" ? -1 : 1);
    if (next >= 0 && next < count) move(id,next);
  };
  const listeners = [
    [hit,"pointerdown",down],[hit,"keydown",key],[hit,"click",click,true],[hit,"contextmenu",contextMenu],
    [capture,"lostpointercapture",cancel],[surface,"pointerdown",anotherPointer,true],
    [surface,"pointermove",update,{capture:true,passive:false}],[surface,"pointerup",up,true],[surface,"pointercancel",cancel,true],
    [scroll,"scroll",scrolled],[window,"blur",blur],[surface,"visibilitychange",visibility],
  ];
  for (const [target,type,listener,options] of listeners) target.addEventListener?.(type,listener,options);
  const dispose = () => {
    if (drag) finish({},true); else { clearHold(); clearEdge(); feedback?.cleanup(); }
    for (const [target,type,listener,options] of listeners) target.removeEventListener?.(type,listener,options);
    signal?.removeEventListener("abort",dispose);
  };
  signal?.addEventListener("abort",dispose,{once:true});
  return dispose;
}
