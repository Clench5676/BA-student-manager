// The top bar's content centred on the bar's fill (BL-043). The layout numbers are in top-bar-layout.js. Text is centred by
// the ink of its script's reference glyph, drawn pictures (the switch, the "?" badge, Settings, Home, the divider) by the ink
// of the bitmaps NGUI drew, so every element's visual centre lies on the same line whatever its box, pivot or padding is.
import * as NGUI from "./ngui.js";
import { inkBounds } from "./student-hall-icons.js";
import { barCentre, barPadding, extent, inkRect, moveBy, titlePx } from "./top-bar-layout.js";
import { S } from "./util.js";

let centre = barCentre(), fillRead = null, revision = 0, watching = false;

// the fill's rows from the game's own sprite, read once; without it the shipped numbers hold
function readFill() {
  return fillRead ||= NGUI.spritePixels({ sprite: "Common_Top_Menu_Bg", atlas: "Common" }).then((pixels) => {
    const ink = inkBounds(pixels, true);
    if (ink.bottom > ink.top) centre = barCentre({ top: ink.top, bottom: ink.bottom, height: ink.height });
  }).catch(() => {});
}

const rowsCache = new Map();
// the rows of a bitmap that draw something (alpha of at least half), as {top, bottom, height}
function rowsOf(url) {
  if (!rowsCache.has(url)) {
    rowsCache.set(url, (async () => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const ink = inkBounds(context.getImageData(0, 0, canvas.width, canvas.height));
      return { top: ink.top, bottom: ink.bottom, height: ink.height };
    })().catch(() => null));
    while (rowsCache.size > 60) rowsCache.delete(rowsCache.keys().next().value);
  }
  return rowsCache.get(url);
}

// the vertical extent (px from the bar's top, in stage px) of what the bitmaps under root draw
async function drawnInk(root, bar, filter = () => true) {
  const stage = document.getElementById("stage").getBoundingClientRect(), k = stage.width / 1920 || 1, origin = bar.getBoundingClientRect().top;
  const rects = await Promise.all([...root.querySelectorAll("*")].filter(filter).map(async (el) => {
    const url = /url\("?(.*?)"?\)$/.exec(el.style.backgroundImage || "")?.[1], box = el.getBoundingClientRect();
    if (!url || !box.height) return null;
    const rows = await rowsOf(url);
    return rows && inkRect({ top: (box.top - origin) / k, bottom: (box.bottom - origin) / k }, rows);
  }));
  return extent(rects);
}

// The title is the prefab's Label_Title size in the app's drawing size for its script, on every page.
export function sizeTitle(title) {
  if (title) title.style.fontSize = `${titlePx(NGUI.fontSizeFor, title.textContent, S).toFixed(2)}px`;
}

const applied = new WeakMap(); // how far each element is moved now
const moveTo = (el, dy) => {
  applied.set(el, dy);
  el.style.translate = dy ? `0 ${dy.toFixed(2)}px` : "";
};

export async function alignTopBar() {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  const mine = ++revision;
  bar.style.setProperty("--bar-padding", `${barPadding(centre)}px`);
  sizeTitle(bar.querySelector(".title"));
  // Text: its box is centred on the bar's centre by flex, the ink of the script's reference glyph moves onto it.
  for (const el of bar.querySelectorAll(".title, .ms-label")) {
    if (el.textContent && el.getClientRects().length) moveTo(el, NGUI.inkShift(el.textContent, parseFloat(getComputedStyle(el).fontSize), { reference: true }));
  }
  // Pictures: the ink of the bitmaps drawn, measured where they are now, plus what they have been moved already.
  const parts = [[".ms-toggle", (el) => !!el.closest(".ms-skin")], [".ms-help"], [".top-option"], [".top-home"], [".top-line"]];
  for (const [selector, filter] of parts) {
    const el = bar.querySelector(selector);
    if (!el || el.hidden || !el.getClientRects().length) continue;
    const ink = await drawnInk(el, bar, filter);
    if (mine !== revision) return;
    if (ink) moveTo(el, (applied.get(el) || 0) + moveBy(centre, ink));
  }
}

// Keeps the alignment up to date: any change under the bar (a title, a language, a skin drawn again, Home shown or hidden),
// the fonts arriving and the sprite being read. The measuring writes only styles, which are not observed.
export function watchTopBar() {
  const bar = document.querySelector(".topbar");
  if (!bar || watching) return;
  watching = true;
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; alignTopBar().catch((err) => console.warn("top bar alignment", err)); }, 0);
  };
  new MutationObserver(schedule).observe(bar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  document.fonts?.ready.then(schedule);
  document.fonts?.addEventListener?.("loadingdone", schedule);
  readFill().then(schedule);
  schedule();
}
