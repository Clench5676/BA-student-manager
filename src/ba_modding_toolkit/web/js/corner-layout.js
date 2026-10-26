// UICharacterDetail/Inventory_ListControl/NUITop_Scenes/Top/Right/Lobby:
// right anchor 1480, local x -98.8, centred 62-unit Home sprite => 98.8 - 62/2.
// Use this authored side inset for scene corners on both axes; retain the toolbar's own row alignment.
export const CORNER_UNITS = 98.8 - 62 / 2;
export const CORNER_MARGIN = CORNER_UNITS * 1920 / 2960;

// All inputs except the source widget box are viewport CSS pixels. Output is in stage pixels,
// including the area outside a letterboxed stage, so the inset is always measured from the window.
export function cornerBox(box, { corner, immersive = true, width, height, stage,
  barBottom = stage.top + 64 * stage.width / 1920, native = null, rowBottom = 0 }) {
  const scale = stage.width / 1920, margin = CORNER_MARGIN * scale;
  const right = corner.endsWith('right'), bottom = corner.startsWith('bottom');
  const sharesNative = native?.active && native.bounds &&
    (right ? native.platform === 'win32' : native.platform === 'darwin');
  const top = Math.max(immersive ? 0 : barBottom, sharesNative ? Math.max(rowBottom, native.bounds.bottom) : 0);
  return [(right ? width - margin - box[2] * scale : margin) / scale - stage.left / scale,
    (bottom ? height - margin - box[3] * scale : top + margin) / scale - stage.top / scale, box[2], box[3]];
}

const controls = new Set(), registered = new WeakMap();
function place(element, entry) {
  const stage = globalThis.document?.getElementById?.('stage')?.getBoundingClientRect?.();
  if (!stage?.width || !Number.isFinite(globalThis.innerWidth)) return;
  const bar = globalThis.document.querySelector?.('.topbar')?.getBoundingClientRect?.();
  const next = cornerBox(entry.box, { ...entry.options, stage, width: innerWidth, height: innerHeight,
    barBottom: bar?.bottom, native: globalThis.bamtWindowChrome, rowBottom: globalThis.bamtHeaderGeometry?.rowHeight });
  // CSS translate composes with the prefab's slide animation on transform.
  element.style.translate = `${next[0] - entry.box[0]}px ${next[1] - entry.box[1]}px`;
}
export function bindCorner(element, box, options) {
  if (!element || !box) return;
  let entry = registered.get(element);
  if (!entry) { entry = { ref: new WeakRef(element) }; registered.set(element, entry); controls.add(entry); }
  Object.assign(entry, { box, options }); place(element, entry);
}
export function reflowCorners() {
  for (const entry of controls) {
    const element = entry.ref.deref();
    if (!element) { controls.delete(entry); continue; }
    if (element.isConnected !== false) place(element, entry);
  }
}
