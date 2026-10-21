// Loading screen, from the game's own prefabs:
//   - UILoading (Resources/UI/UILoading.prefab): its black backdrop (BlackBG). The game also shows an illustration
//     there (the UITexture LoadingImage); the tool leaves the middle of the screen empty.
//   - UIRepeater: "Now Loading" letters, three hopping dots and Arona turning round, in the bottom-right corner;
//     app.css animates it like the game's legacy clip "UIAni_Repeat 1". Its UIAudioPlay is never played.
// Two modes. scene(fn) covers a change of screen: a fade to black, then the indicator while the
// work goes on. wait(promise) shades the edges of the current screen for an in-page wait. There is one
// page overlay at a time; a newer call takes over the one on screen instead of flashing a new one.
// Writer progress has its own indicator and lifetime, independent of page changes.
import { loadingLabel, loadingLetterSprites, alphaBounds } from "./ngui-label.js";
import { spriteUrl } from "./api.js";
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import { T } from "./i18n.js";
import { S } from "./util.js";

const STAGE_UNITS_H = 1080 / S; // 1665 units: the stage is taller than the prefabs' 2960 x 1440 frame
const FADE_BLACK = 150;         // a scene first fades to black; work done by then fades straight back
const FADE_OUT = 300;
const WAIT_AFTER = 300;         // indicator mode: a shorter wait shows nothing
const WAIT_MIN = 500;           // once shown, the indicator stays at least this long
const HARD_CAP = 15000;         // warn about a slow scene; only its work or cancellation can reveal it
const EDGE_HORIZONTAL = 260, EDGE_SIDE = 150, EDGE_ALPHA = 0.6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = () => document.getElementById("stage");

let overlay = null, gen = 0, closeSeq = 0;
let writerOverlay = null, writerGen = 0;
const pending = new Set();
function track(promise) {
  const work = Promise.resolve(promise);
  pending.add(work);
  const finish = () => pending.delete(work);
  work.then(finish, finish);
  return work;
}
let repeater = null, loadingTree = null, shade = null, geometry = null;
const letterInk = new Map();
const initialCover = document.getElementById("loading-boot");
let styled = !!initialCover && !initialCover.classList.contains("neutral"), assetsAllowed = styled;
let firstLoading = null;
export const timings = () => firstLoading || {};

// --- setup ---

// Before asset consent, covers use only system text and a neutral backdrop.
export function init(info) {
  assetsAllowed = info?.consent === true && !!info?.gameFound;
  styled = assetsAllowed && (styled || info.uiCached === true);
  for (const o of [overlay, writerOverlay]) if (o && !o.done) decorate(o);
  if (!assetsAllowed || !info?.gameFound) return;
  NGUI.layout("UILoading").then((tree) => {
    loadingTree = tree;
    for (const o of [overlay, writerOverlay]) if (o) renderProgress(o).catch(() => {});
    const back = NGUI.find(tree, "BlackBG")?.widgets.find((w) => "color" in w)?.color;
    geometry = { back: back ? back.split("/")[0] : "#000000" };
    if (overlay) overlay.el.querySelector(".loading-back").style.background = geometry.back;
  }).catch(() => {});
}

// the strings are in: the overlay's label and the fallback indicator's text
export function relabel() {
  for (const o of [overlay, writerOverlay]) {
    if (!o) continue;
    label(o.el);
    const text = o.ind.querySelector(".loading-fallback span") || o.ind.querySelector(".loading-plain span");
    if (text) text.textContent = indicatorText(o);
    o.relabelProgress?.();
  }
}

export const active = () => !!overlay && !overlay.closing;
export const covering = () => active() && overlay.mode === "full";
// Automatic popups wait for page work, input holds and independent writer progress.
export const busy = () => pending.size > 0 || active() || held() || (!!writerOverlay && !writerOverlay.closing);

export function progressText({ label = "", current = 0, total = 0 } = {}, fallback = T("progress.process", { name: T("progress.mods") })) {
  const text = label || fallback;
  return total > 0 ? T("progress.count", { label: text, current, total }) : text;
}

// A writer task stays visible until it settles. Progress survives the sprite upgrade and
// belongs to this task only, so a late callback cannot change a newer task's indicator.
export async function task(run, { label = null } = {}) {
  const my = ++writerGen;
  const o = writerOverlay && !writerOverlay.closing ? writerOverlay : open("indicator", false, true);
  o.el.classList.add("with-progress");
  const detail = document.createElement("div");
  detail.className = "loading-progress";
  o.progress?.remove();
  o.progress = detail;
  o.el.appendChild(detail);
  let latest = {};
  const update = (value = latest) => {
    if (my !== writerGen || o !== writerOverlay) return;
    latest = value;
    setProgress(o, progressText(value, label || undefined));
  };
  o.relabelProgress = () => update();
  update();
  refresh(); decorate(o);
  try { return await track(run(update)); }
  finally {
    detail.remove();
    if (my === writerGen && o === writerOverlay && !o.closing) {
      o.relabelProgress = null;
      await close(o);
    }
  }
}

// --- the overlay ---

const nowLoading = () => { const s = T("loading.now"); return s === "loading.now" ? "" : s; };
const indicatorText = (o) => o.plain ? (T("loading.plain") === "loading.plain" ? "" : T("loading.plain")) : nowLoading();
function label(el) {
  const s = T("app.loading");
  if (s !== "app.loading") el.setAttribute("aria-label", s);
}

// a new overlay; the boot one in index.html is taken when the page starts covered
function open(mode, opaque = false, writer = false) {
  const boot = writer ? null : document.getElementById("loading-boot");
  const el = opaque && boot ? boot : document.createElement("div");
  el.removeAttribute("id");
  el.className = `loading ${mode}${styled ? "" : " neutral"}`;
  el.setAttribute("role", "status");
  label(el);
  if (!el.querySelector(".loading-ind")) el.innerHTML = '<div class="loading-back"></div><div class="loading-ind" aria-hidden="true"></div>';
  if (geometry) el.querySelector(".loading-back").style.background = geometry.back;
  if (!el.isConnected) stage().appendChild(el);
  if (boot && el !== boot) boot.remove();
  const o = { el, mode, ind: el.querySelector(".loading-ind"), back: el.querySelector(".loading-back"),
    shownAt: performance.now(), closing: false, done: false, sprites: false, plain: !styled, boot: opaque && !writer };
  if (opaque) el.classList.add("on");
  else { void el.offsetWidth; el.classList.add("on"); } // fade in from the first frame
  if (writer) writerOverlay = o;
  else overlay = o;
  if (mode === "indicator" && !writer) {
    const detail = document.createElement("div"); detail.className = "loading-progress";
    o.el.appendChild(detail); o.progress = detail;
    o.relabelProgress = () => {
      setProgress(o, [...holds].reverse().find((hold) => hold.progress)?.progress() || o.waitLabel || T("app.loading"));
    };
    o.relabelProgress();
  }
  refresh();
  return o;
}

export function refresh() {
  for (const o of [overlay, writerOverlay]) o?.relabelProgress?.();
  if (overlay) overlay.el.style.visibility = overlay.mode === "indicator" && writerOverlay && !writerOverlay.closing ? "hidden" : "";
}

function setProgress(o, text) {
  o.progressText = text;
  o.el.setAttribute("aria-label", text);
  if (!o.progressTree) o.progress.textContent = text;
  renderProgress(o).catch(() => {});
}
async function renderProgress(o) {
  if (!assetsAllowed || !o.progress || !o.repeaterTree || o.closing) return;
  const template = await NGUI.layout("UICharacterDetail");
  const style = NGUI.find(template, "Inventory_ListControl/LeftInfo/CharInfo/Char_Target/Text_Lv/Text_Lv_Exp");
  const bounds = await Promise.all(loadingLetterSprites(o.repeaterTree).map(async ({ w }) => {
    if (!letterInk.has(w.sprite)) letterInk.set(w.sprite, NGUI.load(spriteUrl(w.atlas || "Common", w.sprite)).then((img) => {
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
      return alphaBounds(ctx.getImageData(0, 0, c.width, c.height));
    }).catch((err) => { letterInk.delete(w.sprite); throw err; }));
    return [w.sprite, await letterInk.get(w.sprite)];
  }));
  const tree = loadingLabel(o.repeaterTree, style || loadingTree, o.progressText || "", S, Object.fromEntries(bounds));
  if (!tree) return;
  const token = o.progressVersion = (o.progressVersion || 0) + 1;
  const next = document.createElement("div");
  await NGUI.render(tree, next, { scale: S, origin: [0, 0] });
  if (token !== o.progressVersion || o.closing || o.done) return;
  o.progressTree = tree;
  o.progress.classList.add("prefab-label");
  o.progress.replaceChildren(...next.childNodes);
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
    o.done = false; refresh();
    return o;
  }
  return open("full", opaque);
}

function close(o) {
  o.closing = true; o.done = true;
  const id = ++closeSeq;
  o.closeId = id;
  o.el.classList.add("out");
  refresh();
  return sleep(FADE_OUT).then(() => {
    if (!o.closing || o.closeId !== id) return; // taken over while fading out
    if (o.boot && !firstLoading) {
      const end = performance.now(), sprites = o.spritesAt ?? end;
      firstLoading = { "fallback-loading": sprites - o.shownAt, "sprite-loading": end - sprites };
    }
    o.el.remove();
    if (overlay === o) overlay = null;
    if (writerOverlay === o) writerOverlay = null;
  });
}

// --- the indicator: neutral until consent and a decoded UIRepeater, stylized on subsequent covers ---

function fallback(o) {
  o.ind.innerHTML = o.plain ? '<div class="loading-plain"><span></span></div>' :
    '<div class="loading-fallback"><span></span><i></i><i></i><i></i></div>';
  o.ind.querySelector("span").textContent = indicatorText(o);
}

function repeaterTree() {
  repeater ||= NGUI.init().then(() => NGUI.layout("UIRepeater")).catch(() => { repeater = null; return null; });
  return repeater;
}

// The detail prefab's translucent gradient supplies the four window edges. CSS only positions/rotates its artwork.
async function shadeEdges(o) {
  if (!assetsAllowed || o.mode !== "indicator" || o.shade) return;
  o.shade = true;
  shade ||= NGUI.init().then(() => NGUI.layout("UICharacterDetail")).then((tree) =>
    NGUI.find(tree, "Inventory_ListControl/LeftInfo/CharCombatStyle/CharCombatStyleAniwidget/Bg"))
    .catch(() => { shade = null; return null; });
  const template = await shade;
  if (!template || o.closing || o.done || (o !== overlay && o !== writerOverlay)) { o.shade = false; return; }
  for (const [name, width, angle, x, y, reach, inset] of [
    ["Bottom", 1920, 0, 960, 1080, EDGE_HORIZONTAL, EDGE_SIDE], ["Top", 1920, 180, 960, 0, EDGE_HORIZONTAL, EDGE_SIDE],
    ["Left", 1080, 90, 0, 540, EDGE_SIDE, EDGE_HORIZONTAL], ["Right", 1080, -90, 1920, 540, EDGE_SIDE, EDGE_HORIZONTAL]]) {
    const host = document.createElement("div"); host.className = "loading-edge";
    Object.assign(host.style, { left: `${x}px`, top: `${y}px`, transform: `rotate(${angle}deg)` });
    const node = structuredClone(template); node.name = name; node.pos = [0, 0]; node.active = true; node.children = [];
    // flipped: the gradient's dark side sits on the window edge and fades inwards; shorter and lighter than the prefab
    const [hex, alpha = "1"] = node.widgets[0].color.split("/");
    Object.assign(node.widgets[0], { w_: width / S, h_: reach, pivot: 7, flip: (node.widgets[0].flip || 0) ^ 2,
      color: `${hex}/${(Number(alpha) * EDGE_ALPHA).toFixed(2)}` });
    await NGUI.render(node, host, { scale: S, origin: [0, 0] });
    // Neighbours share the diagonal from the window corner to their inner joint, without overlapping alpha.
    const outer = node.widgets[0].flip >= 2 ? "0" : "100%", inner = outer === "0" ? "100%" : "0";
    for (const edge of host.querySelectorAll(".ngui")) edge.style.clipPath =
      `polygon(0 ${outer}, 100% ${outer}, calc(100% - ${inset * S}px) ${inner}, ${inset * S}px ${inner})`;
    if (o.closing || (o !== overlay && o !== writerOverlay)) return;
    o.el.appendChild(host);
  }
}

async function upgrade(o) {
  if (!assetsAllowed || o.sprites) return;
  o.sprites = true;
  const tree = await repeaterTree();
  if (!tree || (o !== overlay && o !== writerOverlay)) { o.sprites = false; return; }
  const next = document.createElement("div");
  next.className = "loading-repeater";
  // the corner widget is anchored to the screen: moved down to the stage's bottom edge
  await NGUI.render(tree, next, { scale: S, origin: [960, 540], shift: { "UIRepeater/Widget": [0, -(STAGE_UNITS_H - 1440) / 2] } });
  const decoded = await NGUI.decoded(next, HARD_CAP);
  if (!assetsAllowed || (o !== overlay && o !== writerOverlay)) { o.sprites = false; return; }
  const widgets = [...next.querySelectorAll(".ngui")];
  // NGUI keeps hit geometry after image failures; it must not replace the fallback with empty widgets.
  if (!decoded || !widgets.length || widgets.some((el) => !el.style.backgroundImage && !el.textContent)) { o.sprites = false; return; }
  o.repeaterTree = tree;
  renderProgress(o).catch(() => {});
  o.ind.replaceChildren(next);
  styled = true;
  o.plain = false;
  o.el.classList.remove("neutral");
  o.spritesAt ??= performance.now();
}

// once the screen is black and the work goes on: the indicator in the corner, nothing in the middle
function decorate(o) {
  shadeEdges(o).catch(() => { o.shade = false; });
  if (o.plain === styled) {
    o.plain = !styled;
    o.sprites = false;
    if (o.plain) o.el.classList.add("neutral");
    else o.el.classList.remove("neutral");
    fallback(o);
  } else if (!o.ind.firstChild) fallback(o);
  else {
    const text = o.ind.querySelector("span");
    if (text) text.textContent = indicatorText(o);
  }
  upgrade(o).catch(() => { o.sprites = false; });
}

// --- modes ---

// scene(fn, {opaque}): fn(covered) runs at once; covered resolves when the screen is black, so fn can switch screens
// behind it. Resolves with fn's result once the overlay is gone (or handed to a newer call).
export async function scene(fn, { opaque = false, until = null } = {}) {
  const my = ++gen;
  const o = cover(opaque);
  const covered = whenOpaque(o);
  let failed = false, error = null, result;
  covered.then(() => { if (my === gen && !o.done) decorate(o); });
  try {
    const work = Promise.resolve().then(() => fn(covered));
    result = await (until ? Promise.race([work, until]) : work);
  } catch (err) {
    failed = true;
    error = err;
  }
  if (my === gen) {
    o.done = true;
    if (o === overlay && !o.closing) await close(o);
  }
  if (failed) throw error;
  return result;
}

// wait(promise, {label, cap}): the indicator over the current screen once the wait passes WAIT_AFTER; resolves with
// the result. label: what the indicator says to assistive technology (the page's "loading" by default); cap: how long
// the indicator stays at most (a wait known to take longer than HARD_CAP, such as the classic UI's start)
export async function wait(promise, { label: text = null, cap = HARD_CAP, immediate = false } = {}) {
  promise = track(promise);
  if (covering()) return promise; // a scene covers it already
  const my = ++gen;
  let settled = false;
  // opened in an animation frame: a late timer (a busy page) must not show the indicator over a change that is
  // being committed in that same frame
  const reveal = () => {
    if (my !== gen || settled) return;
    if (active()) { if (immediate) overlay.holdOwned = true; refresh(); return; }
    const o = open("indicator");
    o.holdOwned = immediate;
    o.waitLabel = text; o.relabelProgress?.();
    decorate(o);
  };
  const timer = immediate ? (Promise.resolve().then(reveal), null) : setTimeout(() => requestAnimationFrame(reveal), WAIT_AFTER);
  let failed = false, error = null, result;
  try {
    result = cap === null ? await promise : await Promise.race([promise, sleep(cap)]);
  } catch (err) {
    failed = true;
    error = err;
  }
  settled = true;
  clearTimeout(timer);
  const o = overlay;
  if (my === gen && o && !o.closing && o.mode === "indicator" && !(o.holdOwned && held())) {
    const left = immediate ? 0 : WAIT_MIN - (performance.now() - o.shownAt);
    const finish = () => { if (my === gen && o === overlay && !o.closing) close(o); };
    if (left > 0) sleep(left).then(finish); else finish();
  }
  if (failed) throw error;
  return result;
}

// A write holds input from submission through the final reload. Default holds leave Back and popups available;
// all blocks them too. Leaving the page releases its hold while the job keeps reporting its end.
const holds = new Set(), wired = new WeakSet();
export const held = () => holds.size > 0;
export async function hold(work, { until = null, all = false, progress = null } = {}) {
  let latest = null;
  const el = stage(), key = { all, progress: () => latest === null ? progress?.() || T("app.loading")
    : typeof latest === "string" ? latest : progressText(latest) };
  const update = (value) => { latest = value; refresh(); };
  holds.add(key);
  refresh();
  if (all) el.classList.add("input-held");
  if (!wired.has(el)) {
    const block = (ev) => {
      if (!held() || (![...holds].some((hold) => hold.all)
        && (ev.target.closest?.(".topbar .back") || Popup.allowsInput(ev)))) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    for (const event of ["pointerdown", "pointerup", "pointermove", "click", "keydown", "wheel", "touchstart", "touchmove"]) el.addEventListener(event, block, true);
    wired.add(el);
  }
  const release = () => {
    holds.delete(key);
    refresh();
    if (!holds.size && overlay?.holdOwned && overlay.mode === "indicator" && !overlay.closing) close(overlay);
    if (![...holds].some((hold) => hold.all)) el.classList.remove("input-held");
  };
  const task = track(Promise.resolve().then(() => work(update)));
  const visible = until ? Promise.race([task, until.then(release)]) : task;
  wait(visible, { cap: null, immediate: true }).catch(() => {});
  try { return await task; } finally { release(); }
}

// In-place preview changes share the same shaded hold as writes; only route changes use scene's black cover.
export function page(fn, options = {}) {
  return hold(() => fn(Promise.resolve()), options);
}
