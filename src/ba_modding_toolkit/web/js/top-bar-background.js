// UICharacterCollection/SeletControl/Top/BG_W/Bg, Common_Top_Menu_Bg.
// Keep the existing 310/20 source cuts and exact 172/11 stage-pixel caps.
import { slicedImage } from './ngui.js';
import { spriteUrl } from './api.js';
export const BAR_CUTS = Object.freeze([0, 20, 0, 310]);
export const BAR_BORDER_SCALES = Object.freeze([0, 11 / 20, 0, 172 / 310]);
export const barDensity = (dpi = 1, scale = 1) => Math.max(2, dpi * scale);
export const barImage = (width, height, scale = 1, dpi = globalThis.devicePixelRatio || 1) =>
  slicedImage(spriteUrl('Common', 'Common_Top_Menu_Bg'), BAR_CUTS, width, height, BAR_BORDER_SCALES, barDensity(dpi, scale));

const revisions = new WeakMap();
export async function paintTopBar(bar, scale) {
  const revision = (revisions.get(bar) || 0) + 1; revisions.set(bar, revision);
  const rect = bar.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const url = await barImage(rect.width / scale, rect.height / scale, scale);
  if (revisions.get(bar) === revision) bar.style.backgroundImage = `url("${url}")`;
}
