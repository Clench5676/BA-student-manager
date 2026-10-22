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
