// A modal owns capture priority until its scope closes, even between lazy card requests.
const popups = new Set(), listeners = new Set();
const changed = () => { for (const listener of [...listeners]) listener(); };
export const popupCapturesOpen = () => popups.size > 0;
export const popupCapture = (signal) => popups.has(signal);
export function holdPopupCaptures(signal) {
  if (signal.aborted) return;
  popups.add(signal);
  signal.addEventListener("abort", () => { popups.delete(signal); changed(); }, { once: true });
  changed();
}
export function onCapturePriorityChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const popupItem = (item) => [...item.clients].some((client) => popupCapture(client.signal));
export const captureEligible = (item) => !popupCapturesOpen() || popupItem(item);
