// Loading screen, from the game's own prefabs:
//   - UILoading (Resources/UI/UILoading.prefab): a black backdrop (BlackBG) and one illustration (the UITexture
//     LoadingImage, which the game fills at run time). The illustration is drawn at its own size, 1 texel = 1 prefab
//     unit, never stretched. Only the game's "Tip!" cards are shown (loading.list leaves the comics out), one file per
//     language; without any, the screen stays black with the indicator.
//   - UIRepeater: "Now Loading" letters, three hopping dots and Arona turning round, in the bottom-right corner;
//     app.css animates it like the game's legacy clip "UIAni_Repeat 1". Its UIAudioPlay is never played.
// Two modes. scene(fn) covers a change of screen: a fade to black, then the illustration and the indicator while the
// work goes on. wait(promise) shows the indicator alone over the current screen, for a wait inside it. There is one
// overlay at a time; a newer call takes over the one on screen instead of flashing a new one.
import * as NGUI from "./ngui.js";
import { rpc } from "./api.js";
import { T } from "./i18n.js";
import { S, toast } from "./util.js";

const STAGE_UNITS_H = 1080 / S; // 1665 units: the stage is taller than the prefabs' 2960 x 1440 frame
const FADE_BLACK = 150;         // a scene first fades to black; work done by then fades straight back
const FADE_OUT = 300;
const MIN_ART = 800;            // a shown illustration stays at least this long
const WAIT_AFTER = 300;         // indicator mode: a shorter wait shows nothing
const WAIT_MIN = 500;           // once shown, the indicator stays at least this long
const HARD_CAP = 15000;         // after this, whatever there is is revealed

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = () => document.getElementById("stage");

let overlay = null, gen = 0, closeSeq = 0;
// illustrations of the UI language: [{name, n, w, h, url}]; the next pick is fetched and decoded ahead of time
const art = { list: [], lang: null, recent: [], next: null };
let listed = null;
const listKnown = new Promise((resolve) => { listed = resolve; });
let repeater = null, geometry = null;

// --- setup ---

// after app.info: the Tip cards of the UI language (none without a game) and the prefabs
export function init(info) {
  if (!info?.gameFound) { setImages([], null); return; }
  rpc("loading.list", { lang: info.language }).then((l) => setImages(l.images, l.lang), () => setImages([], null));
  NGUI.layout("UILoading").then((tree) => {
    const pos = NGUI.find(tree, "LoadingImage")?.pos || [0, 0];
    const back = NGUI.find(tree, "BlackBG")?.widgets.find((w) => "color" in w)?.color;
    geometry = { x: 960 + pos[0] * S, y: 540 - pos[1] * S, back: back ? back.split("/")[0] : "#000000" };
    if (overlay) overlay.el.querySelector(".loading-back").style.background = geometry.back;
  }).catch(() => {});
}

// the strings are in: the overlay's label and the plain indicator's text
export function relabel() {
  if (!overlay) return;
  label(overlay.el);
  const text = overlay.el.querySelector(".loading-plain span");
  if (text) text.textContent = nowLoading();
}

export function setImages(list, lang) {
  art.list = list || [];
  art.lang = lang;
  art.next = null;
  listed();
  prefetch();
}

// a uniform pick, never one of the last few shown (the game's weights cannot be read)
function choose() {
  const list = art.list;
  if (!list.length) return null;
  const recent = art.recent.slice(0, Math.min(8, Math.floor(list.length / 2)));
  const pool = list.filter((it) => !recent.includes(it.name));
  const from = pool.length ? pool : list;
  return from[Math.floor(Math.random() * from.length)];
}

// fetch and decode the next illustration ahead of time, so the next loading screen shows it at once
export function prefetch() {
  if (art.next || !art.list.length) return art.next;
  const it = choose();
  const img = new Image();
  img.decoding = "async";
  img.alt = "";
  img.draggable = false;
  img.src = it.url;
  art.next = { it, img, ready: img.decode().then(() => true, () => false) };
  return art.next;
}

export const active = () => !!overlay && !overlay.closing;
export const covering = () => active() && overlay.mode === "full";

// --- the overlay ---

const nowLoading = () => { const s = T("loading.now"); return s === "loading.now" ? "" : s; };
function label(el) {
  const s = T("app.loading");
  if (s !== "app.loading") el.setAttribute("aria-label", s);
}

// a new overlay; the boot one in index.html is taken when the page starts covered
function open(mode, opaque = false) {
  const boot = document.getElementById("loading-boot");
  const el = opaque && boot ? boot : document.createElement("div");
  el.removeAttribute("id");
  el.className = `loading ${mode}`;
  el.setAttribute("role", "status");
  label(el);
  el.innerHTML = '<div class="loading-back"></div><div class="loading-ind"></div>';
  if (geometry) el.querySelector(".loading-back").style.background = geometry.back;
  if (!el.isConnected) stage().appendChild(el);
  if (boot && el !== boot) boot.remove();
  const o = { el, mode, ind: el.querySelector(".loading-ind"), back: el.querySelector(".loading-back"),
    shownAt: performance.now(), artAt: 0, closing: false, done: false, sprites: false, artTried: false };
  if (opaque) el.classList.add("on");
  else { void el.offsetWidth; el.classList.add("on"); } // fade in from the first frame
  overlay = o;
  return o;
}

// resolves in the first frame the overlay is fully black (the fade may start late on a busy page, so it is watched,
// not timed); a page in the background, which draws no frames, gets a time limit instead
function whenOpaque(o) {
  return new Promise((resolve) => {
    const limit = setTimeout(resolve, FADE_BLACK + 1500);
    const check = () => {
      const op = Number(getComputedStyle(o.el).opacity) * Number(getComputedStyle(o.back).opacity);
      if (op >= 0.999 || o !== overlay || o.closing) { clearTimeout(limit); resolve(); } else requestAnimationFrame(check);
    };
    check();
  });
}

// the full overlay, for a scene: the one on screen is taken over (an indicator turns black, a closing one comes back)
function cover(opaque) {
  const o = overlay;
  if (o && (!o.closing || o.mode === "full")) {
    if (o.closing) { o.closing = false; o.el.classList.remove("out"); }
    if (o.mode !== "full") {
      o.mode = "full";
      o.el.classList.replace("indicator", "full");
    }
    o.done = false;
    return o;
  }
  return open("full", opaque);
}

function close(o) {
  o.closing = true;
  const id = ++closeSeq;
  o.closeId = id;
  o.el.classList.add("out");
  return sleep(FADE_OUT).then(() => {
    if (!o.closing || o.closeId !== id) return; // taken over while fading out
    o.el.remove();
    if (overlay === o) overlay = null;
  });
}

// --- the indicator: UIRepeater drawn by ngui.js once the atlases are in; until then (or without a game) plain ---

function plain(host) {
  host.innerHTML = '<div class="loading-plain"><span></span><i></i><i></i><i></i></div>';
  host.querySelector("span").textContent = nowLoading();
}

function repeaterTree() {
  repeater ||= NGUI.init().then(() => NGUI.layout("UIRepeater")).catch(() => { repeater = null; return null; });
  return repeater;
}

async function upgrade(o) {
  if (o.sprites) return;
  o.sprites = true;
  const tree = await repeaterTree();
  if (!tree || o !== overlay) { o.sprites = false; return; }
  const next = document.createElement("div");
  next.className = "loading-repeater";
  // the corner widget is anchored to the screen: moved down to the stage's bottom edge
  await NGUI.render(tree, next, { scale: S, origin: [960, 540], shift: { "UIRepeater/Widget": [0, -(STAGE_UNITS_H - 1440) / 2] } });
  if (!next.querySelector(".ngui")) { o.sprites = false; return; } // the sprites are not in this install's atlases
  o.ind.replaceChildren(next);
}

// once the screen is black and the work goes on: the indicator, then the illustration once it is decoded
async function decorate(o) {
  if (!o.ind.firstChild) plain(o.ind);
  upgrade(o);
  if (o.mode !== "full" || o.artTried) return;
  o.artTried = true;
  await listKnown;
  const next = prefetch();
  if (!next || !(await next.ready)) {
    if (next && art.next === next) art.next = null; // a broken one is not tried again first
    return;
  }
  if (o !== overlay || o.closing || o.done || o.mode !== "full") return; // the work was done first: no flash
  art.next = null;
  art.recent.unshift(next.it.name);
  const { it, img } = next;
  const g = geometry || { x: 960, y: 540 };
  img.className = "loading-art";
  Object.assign(img.style, { left: `${(g.x - (it.w * S) / 2).toFixed(1)}px`, top: `${(g.y - (it.h * S) / 2).toFixed(1)}px`,
    width: `${(it.w * S).toFixed(1)}px`, height: `${(it.h * S).toFixed(1)}px` });
  o.el.insertBefore(img, o.ind);
  void img.offsetWidth;
  img.classList.add("in");
  o.artAt = performance.now();
  prefetch(); // the one after
}

// --- modes ---

// scene(fn, {opaque}): fn(covered) runs at once; covered resolves when the screen is black, so fn can switch screens
// behind it. Resolves with fn's result once the overlay is gone (or handed to a newer call).
export async function scene(fn, { opaque = false } = {}) {
  const my = ++gen;
  const o = cover(opaque);
  const covered = whenOpaque(o);
  let failed = false, error = null, timedOut = false, result;
  covered.then(() => { if (my === gen && !o.done) decorate(o); });
  try {
    result = await Promise.race([Promise.resolve().then(() => fn(covered)), sleep(HARD_CAP).then(() => { timedOut = true; })]);
  } catch (err) {
    failed = true;
    error = err;
  }
  if (my === gen) {
    o.done = true;
    if (timedOut) toast(T("loading.slow"));
    const left = o.artAt ? MIN_ART - (performance.now() - o.artAt) : 0;
    if (left > 0) await sleep(left);
    if (my === gen && o === overlay && !o.closing) await close(o);
  }
  if (failed) throw error;
  return result;
}

// wait(promise): the indicator over the current screen once the wait passes WAIT_AFTER; resolves with the result
export async function wait(promise) {
  if (covering()) return promise; // a scene covers it already
  const my = ++gen;
  let settled = false;
  // opened in an animation frame: a late timer (a busy page) must not show the indicator over a change that is
  // being committed in that same frame
  const timer = setTimeout(() => requestAnimationFrame(() => {
    if (my !== gen || settled || active()) return;
    decorate(open("indicator"));
  }), WAIT_AFTER);
  let failed = false, error = null, timedOut = false, result;
  try {
    result = await Promise.race([promise, sleep(HARD_CAP).then(() => { timedOut = true; })]);
  } catch (err) {
    failed = true;
    error = err;
  }
  settled = true;
  clearTimeout(timer);
  const o = overlay;
  if (my === gen && o && !o.closing && o.mode === "indicator") {
    if (timedOut) toast(T("loading.slow"));
    const left = WAIT_MIN - (performance.now() - o.shownAt);
    (left > 0 ? sleep(left) : Promise.resolve()).then(() => { if (my === gen && o === overlay && !o.closing) close(o); });
  }
  if (failed) throw error;
  return result;
}
