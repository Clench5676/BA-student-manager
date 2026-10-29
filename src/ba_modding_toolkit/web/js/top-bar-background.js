// UICharacterCollection/SeletControl/Top/BG_W/Bg, Common_Top_Menu_Bg.
// Keep the existing 310/20 source cuts and exact 172/11 stage-pixel caps.
import { slicedImage } from './ngui.js';
import { spriteUrl } from './api.js';
import { withTimeout } from './async.js';
export const BAR_CUTS = Object.freeze([0, 20, 0, 310]);
export const BAR_BORDER_SCALES = Object.freeze([0, 11 / 20, 0, 172 / 310]);
export const barDensity = (dpi = 1, scale = 1) => Math.max(2, dpi * scale);
export const barImage = (width, height, scale = 1, dpi = globalThis.devicePixelRatio || 1) =>
  slicedImage(spriteUrl('Common', 'Common_Top_Menu_Bg'), BAR_CUTS, width, height, BAR_BORDER_SCALES, barDensity(dpi, scale));

// Each bar retains its published image while a replacement raster encodes and
// decodes. Resize bursts replace the pending request; only one draw runs at once
// and each draw starts in an animation frame.
export function createTopBarPainter({ raster = barImage, frame = (fn) => requestAnimationFrame(fn),
  decode = async (url) => {
    const image = new Image(); image.src = url;
    await withTimeout(image.decode(), 15000, 'Top bar image decoding');
    return image;
  } } = {}) {
  const states = new WeakMap();
  function schedule(bar, state) {
    if (state.scheduled || state.running) return;
    state.scheduled = true;
    frame(() => { state.scheduled = false; draw(bar, state); });
  }
  async function draw(bar, state) {
    state.running = true;
    const revision = state.revision, { scale, dpi } = state.request;
    let error;
    try {
      const rect = bar.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && scale > 0) {
        const url = await raster(rect.width / scale, rect.height / scale, scale, dpi);
        const image = await decode(url);
        if (revision === state.revision) {
          bar.style.backgroundImage = `url("${url}")`;
          state.image = image;
        }
      }
    } catch (failure) { error = failure; }
    state.running = false;
    if (revision !== state.revision) { schedule(bar, state); return; }
    for (const waiter of state.waiters.splice(0)) {
      if (error) waiter.reject(error); else waiter.resolve();
    }
  }
  return (bar, scale) => {
    let state = states.get(bar);
    if (!state) { state = { revision: 0, waiters: [] }; states.set(bar, state); }
    ++state.revision;
    state.request = { scale, dpi: globalThis.devicePixelRatio || 1 };
    const ready = new Promise((resolve, reject) => state.waiters.push({ resolve, reject }));
    schedule(bar, state);
    return ready;
  };
}

export const paintTopBar = createTopBarPainter();
