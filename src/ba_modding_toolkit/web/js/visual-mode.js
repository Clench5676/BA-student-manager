// The portrait's fullscreen view: the game's visual mode (UICharacterVisualMode), which UICharacterDetail opens from
// its ZoomButton, the nameplate's square button with the rotate-phone icon (Char_ZoomBtn). Drawn from the prefab's PC
// group (Inventory_ListControl_PC):
// - BG: the student's collection background (4533 x 3400 units, larger than the detail screen's) under two light
//   patterns (Bg_Pt_1, Bg_Pt_2) whose TweenAlpha ping-pongs between 0.2 and 0.5 every 1.25 s, in opposite phase;
// - the portrait's own player (detail.js), so the face and the blink go on, framed by visual-view.js: the whole art,
//   the body in the middle;
// - TouchArea, a full-screen button whose press drags the portrait (OnPressScreen), and the zoom (PlayZoomInOut);
// - Btn_Back top left (leaves), Btn_HideUI top right (the buttons slide out, Btn_ShowUI fades in in its place and
//   brings them back), Btn_RefreshPos bottom right (UI_BUTTON_RESET_POS: back to the whole art; greyed out as
//   Btn_RefreshPos_Disable while there), sliding in from the screen's edges with UIAni_CharacterVisualMode_PC.
// Not reproduced: the phone's gyroscope moving the art (UpdateGyro, mobile only) and the button sounds.
// Input: press and drag (any button, a finger) moves the art; the mouse wheel zooms at the pointer; a trackpad pinches
// (ctrl + wheel in Chromium and WebView2, gesture events in WebKit) and swipes; two fingers pinch.
import * as NGUI from "./ngui.js";
import { wheelKind, wheelStep } from "./lobby-touch.js";
import { S, clone, hitButton } from "./util.js";
import {
  SLIDE, SLIDE_S, STAGE, anchoredCentre, artBox, atHome, homeView, limits, mix, panBy, slideFrames, viewOf, viewport, zoomAt,
} from "./visual-view.js";

const CENTRE = [960, 540];      // the screen's centre on the stage
const GLIDE_MS = 450;           // in and out, in step with the UI slide (app.css .45s)
const RESET_MS = 300;           // Btn_RefreshPos: back to the whole art
const SHOW_MS = 250;            // Btn_ShowUI's TweenAlpha, 0.02 to 1
const ZOOM_TAU = 0.08;          // s: a wheel zoom eases to its target, as in the lobby
const WHEEL = 0.0015, LINE = 40, PINCH = 0.01, SCROLL_MS = 120; // as lobby-touch.js
// the buttons' BoxColliders [width, height, centre y] in NGUI units around their node; the greyed reset has none
const HIT = { Btn_Back: [228.83, 165, 0], Btn_HideUI: [228.83, 165, 0], Btn_ShowUI: [228.83, 165, 0], Btn_RefreshPos: [228.83, 195.2, 32] };
const CORNERS = [["LeftTop", ["Btn_Back"]], ["RightTop", ["Btn_HideUI", "Btn_ShowUI"]], ["RightBottom", ["Btn_RefreshPos", "Btn_RefreshPos_Disable"]]];
// the buttons the clip moves, and their keys
const MOVING = { Btn_Back: SLIDE.Btn_Back, Btn_HideUI: SLIDE.Btn_HideUI, Btn_RefreshPos: SLIDE.Btn_RefreshPos, Btn_RefreshPos_Disable: SLIDE.Btn_RefreshPos };

let st = null;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const isOpen = () => !!st && !st.closing;

// prepare({layout, bg, strings}): the prefab's background and buttons rendered off screen, for one open(); null
// without the prefab. strings: {reset, back, hide, show}.
export async function prepare({ layout, bg, strings }) {
  const pc = layout ? NGUI.find(layout, "Inventory_ListControl_PC") : null;
  if (!pc) return null;
  const [back, groups] = await Promise.all([renderBg(pc, bg), renderButtons(pc, strings)]);
  return { pc, bg: back, groups };
}

// open({parts, skeleton, detail, host, bgHost, uiHost, players, onBack}): the portrait glides from the detail screen's
// viewport (detail) to the whole art while the prepared parts come in; without parts (no prefab) there is no
// background and no button, and the caller gives a way out. players(): every portrait player on the stage. The glide's
// clock starts with its first frame, as the page's own transitions do.
export function open(o) {
  close({ instant: true });
  const parts = o.parts || null;
  const box = artBox(o.skeleton?.data, measure(o.skeleton));
  const home = homeView(box, { s: S, scale: parts ? NGUI.find(parts.pc, "Character/CharacterPos")?.scale?.[0] : undefined });
  const detail = viewOf(o.detail);
  const s = st = {
    o, home, lim: limits(box, home), detail, view: detail, target: home, last: null,
    glide: { from: detail, to: home, t0: null, ms: GLIDE_MS, kind: "open" },
    groups: parts?.groups || {}, hidden: false, homeShown: null, ptrs: new Map(), pinch: null,
    scroll: { kind: null, at: -Infinity }, pinchUntil: -Infinity, gesture: 1,
  };
  const touch = document.createElement("div");
  touch.className = "visual-touch";
  for (const [type, fn, opts] of HANDLERS) touch.addEventListener(type, fn, opts);
  s.touch = touch;
  const g = s.groups;
  if (g.Btn_ShowUI) g.Btn_ShowUI.hidden = true;
  syncReset(s);
  o.uiHost.replaceChildren(touch, ...Object.values(g));
  o.uiHost.hidden = false;
  if (parts) {
    o.bgHost.classList.remove("on");
    o.bgHost.replaceChildren(...parts.bg);
    o.bgHost.hidden = false;
    void o.bgHost.offsetWidth; // the fade starts from transparent
    o.bgHost.classList.add("on");
    for (const [name, keys] of Object.entries(MOVING)) if (g[name]) slide(g[name], keys, false);
  }
  addEventListener("keydown", onKey);
}

// close(): the buttons slide out, the background fades and the portrait glides back to the detail screen's framing;
// instant: at once (the screen is being left)
export function close({ instant = false } = {}) {
  const s = st;
  if (!s) return;
  if (instant) { finish(s); return; }
  if (s.closing) return;
  s.closing = true;
  removeEventListener("keydown", onKey);
  s.ptrs.clear();
  s.touch.classList.remove("grabbing");
  s.touch.style.pointerEvents = "none";
  for (const [name, keys] of Object.entries(MOVING)) if (!s.hidden && s.groups[name]) slide(s.groups[name], keys, true);
  if (s.groups.Btn_ShowUI) s.groups.Btn_ShowUI.hidden = true;
  s.o.bgHost.classList.remove("on");
  s.glide = { from: s.view, to: s.detail, t0: null, ms: GLIDE_MS, kind: "close" };
  // the players draw the glide and end it; a portrait that broke meanwhile draws nothing, so a timer ends it too
  setTimeout(() => finish(s), GLIDE_MS + 1000);
}

function finish(s) {
  if (s.finished) return;
  s.finished = true;
  if (st === s) st = null;
  removeEventListener("keydown", onKey);
  // exactly the detail screen's framing again
  const { x, y, width, height } = s.o.detail;
  for (const p of s.o.players()) if (p?.currentViewport) Object.assign(p.currentViewport, { x, y, width, height, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 });
  for (const host of [s.o.bgHost, s.o.uiHost]) { host.hidden = true; host.replaceChildren(); host.classList.remove("on"); }
}

// Every fullscreen view of the detail screen (this one, the memorial lobby's, the 3D model's) slides the screen's UI
// out (app.css .stage.fullscreen). uiOut(parts): while out, the parts are inert, so a control nobody sees neither
// takes the keyboard's focus nor acts; the focused one lets go. uiBack(parts): they come back, the visual mode closes
// whichever tab the screen shows by then (a tab changed meanwhile must not leave its full-screen touch area over the
// screen), and the control that had the focus gets it back (refocus: false while the screen is being left).
let asideFocus = null;
export function uiOut(parts) {
  const live = parts.filter(Boolean), focused = document.activeElement;
  if (focused && live.some((p) => p.contains(focused))) {
    asideFocus = focused;
    focused.blur();
  }
  for (const p of live) p.inert = true;
}
export function uiBack(parts, { refocus = true } = {}) {
  close();
  for (const p of parts) if (p) p.inert = false;
  const back = asideFocus;
  asideFocus = null;
  if (refocus && back?.isConnected && !back.closest("[inert]")) back.focus({ preventScroll: true });
}

// spine-player's per-frame hook (detail.js passes it as the portrait players' config.frame): before the player
// frames its camera, the view of this frame
export function frame(player) {
  const s = st;
  if (!s || !player?.currentViewport) return;
  step(s, performance.now());
  if (s.finished) return;
  Object.assign(player.currentViewport, viewport(s.view));
  syncReset(s);
}

// advance the glide, or ease the view to its target (several players may call it in one frame)
function step(s, now) {
  const dt = s.last == null ? 0 : Math.max(0, Math.min(0.1, (now - s.last) / 1000));
  s.last = now;
  const g = s.glide;
  if (g) {
    g.t0 ??= now;
    const t = clamp01((now - g.t0) / g.ms);
    s.view = mix(g.from, g.to, ease(t));
    if (t < 1) return;
    s.glide = null;
    s.view = g.to;
    if (g.kind === "close") finish(s);
    else s.target = g.to;
    return;
  }
  if (s.view === s.target) return;
  const next = mix(s.view, s.target, 1 - Math.exp(-dt / ZOOM_TAU));
  s.view = Math.abs(next.k / s.target.k - 1) < 1e-4 && Math.abs((next.cx - s.target.cx) * next.k) < 0.05
    && Math.abs((next.cy - s.target.cy) * next.k) < 0.05 ? s.target : next;
}

// the setup pose's bounds, for a skeleton without exported ones
function measure(sk) {
  if (!sk || (sk.data.width > 0 && sk.data.height > 0) || !globalThis.spine) return null;
  const off = new spine.Vector2(), size = new spine.Vector2();
  sk.getBounds(off, size, []);
  return [off.x, off.y, size.x, size.y];
}

// --- the prefab's background and buttons ---

async function renderBg(pc, bg) {
  const node = NGUI.find(pc, "BG");
  if (!node) return [];
  const host = document.createElement("div");
  await NGUI.render(clone(node), host, { scale: S, origin: CENTRE, rootPath: "Inventory_ListControl_PC", textures: bg ? { BG: bg } : undefined });
  return [...host.children];
}

// one layer per button, so each slides on its own; the corners are anchored to the screen's edges
async function renderButtons(pc, strings) {
  const groups = {}, made = [];
  const labels = { Btn_Back: strings.back, Btn_HideUI: strings.hide, Btn_ShowUI: strings.show, Btn_RefreshPos: strings.reset };
  for (const [corner, names] of CORNERS) {
    const c = NGUI.find(pc, corner);
    if (!c) continue;
    const at = anchoredCentre(c.widgets.find((w) => w.anchors)) || c.pos;
    for (const name of names) {
      const n = NGUI.find(c, name);
      if (!n) continue;
      const el = document.createElement("div");
      el.className = "visual-btn";
      const tree = NGUI.node(corner, at, [], [{ ...clone(n), active: true }]);
      made.push(NGUI.render(tree, el, { scale: S, origin: CENTRE, rootPath: "Inventory_ListControl_PC", texts: { Label_Locale_Reset: strings.reset } }));
      if (HIT[name]) {
        const [w, h, dy] = HIT[name], x = CENTRE[0] + (at[0] + n.pos[0]) * S, y = CENTRE[1] - (at[1] + n.pos[1] + dy) * S;
        hitButton(el, [x - (w * S) / 2, y - (h * S) / 2, w * S, h * S], (e) => { e.stopPropagation(); press(name); }, labels[name]);
      }
      groups[name] = el;
    }
  }
  await Promise.all(made);
  return groups;
}
// a button of the open visual mode
function press(name) {
  const s = st;
  if (!s || s.closing) return;
  if (name === "Btn_Back") s.o.onBack();
  else if (name === "Btn_HideUI") hideUI(s);
  else if (name === "Btn_ShowUI") showUI(s);
  else if (name === "Btn_RefreshPos") reset(s);
}

// a button's slide (UIAni_CharacterVisualMode_PC), in or out (the clip backwards)
function slide(el, keys, out) {
  const frames = slideFrames(keys).map(({ offset, value }) => ({ offset, transform: `translateX(${(value * S).toFixed(2)}px)` }));
  el.slideRun?.cancel();
  el.slideRun = el.animate?.(frames, { duration: SLIDE_S * 1000, fill: "both", direction: out ? "reverse" : "normal" });
  return el.slideRun;
}

// the reset button greys out while the whole art is shown (CheckResetButtonState)
function syncReset(s) {
  const on = s.groups.Btn_RefreshPos, offBtn = s.groups.Btn_RefreshPos_Disable;
  if (!on || !offBtn || s.closing) return;
  const home = (!s.glide && atHome(s.target, s.home)) || s.glide?.kind === "open";
  if (home === s.homeShown) return;
  s.homeShown = home;
  on.hidden = home;
  offBtn.hidden = !home;
}

function hideUI(s) {
  if (s.hidden) return;
  s.hidden = true;
  const runs = Object.entries(MOVING).map(([name, keys]) => s.groups[name] && slide(s.groups[name], keys, true)).filter(Boolean);
  Promise.all(runs.map((a) => a.finished)).catch(() => {}).then(() => {
    if (st !== s || !s.hidden || s.closing) return;
    for (const name of Object.keys(MOVING)) if (s.groups[name]) s.groups[name].style.visibility = "hidden";
    const show = s.groups.Btn_ShowUI;
    if (!show) return;
    show.hidden = false;
    show.animate?.([{ opacity: 0.02 }, { opacity: 1 }], { duration: SHOW_MS, fill: "both" });
  });
}
function showUI(s) {
  if (!s.hidden) return;
  s.hidden = false;
  if (s.groups.Btn_ShowUI) s.groups.Btn_ShowUI.hidden = true;
  for (const [name, keys] of Object.entries(MOVING)) {
    const el = s.groups[name];
    if (!el) continue;
    el.style.visibility = "";
    slide(el, keys, false);
  }
}
// back to the whole art (co_ReturnToDefaultPosition); a press or a scroll meanwhile takes over
function reset(s) {
  s.glide = { from: s.view, to: s.home, t0: null, ms: RESET_MS, kind: "reset" };
  s.target = s.home;
}

// --- input ---

const ready = (s) => s && !s.closing && s.glide?.kind !== "open";
function stagePoint(s, e) {
  const r = s.o.host.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * STAGE.width, ((e.clientY - r.top) / r.height) * STAGE.height];
}
// a running reset gives way to the user
function interrupt(s) {
  if (s.glide?.kind !== "reset") return;
  s.glide = null;
  s.target = s.view;
}
function pan(s, dx, dy) {
  interrupt(s);
  const same = s.view === s.target;
  s.view = panBy(s.view, dx, dy, s.lim);
  s.target = same ? s.view : panBy(s.target, dx, dy, s.lim);
}
// a wheel or trackpad zoom: the target, eased to
function zoomTo(s, f, sx, sy) {
  interrupt(s);
  s.target = zoomAt(s.target, f, sx, sy, s.lim);
}
const notchZoom = (e, unit) => Math.exp(-Math.sign(e.deltaY) * Math.max(Math.abs(e.deltaY * unit), LINE) * WHEEL);
function pinchOf(s) {
  if (s.ptrs.size < 2) return null;
  const [a, b] = s.ptrs.values();
  return { d: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
}

function down(e) {
  const s = st;
  if (!ready(s) || (e.pointerType === "mouse" && e.button > 2)) return;
  if (e.button === 1 || e.button === 2) e.preventDefault();
  interrupt(s);
  try { s.touch.setPointerCapture?.(e.pointerId); } catch { /* the drag goes on without capture */ }
  s.ptrs.set(e.pointerId, stagePoint(s, e));
  s.pinch = pinchOf(s);
  s.touch.classList.add("grabbing");
}
function move(e) {
  const s = st;
  if (!s || !s.ptrs.has(e.pointerId) || s.closing) return;
  const p = stagePoint(s, e), was = s.ptrs.get(e.pointerId);
  s.ptrs.set(e.pointerId, p);
  if (s.ptrs.size === 1) { pan(s, p[0] - was[0], p[1] - was[1]); return; }
  // two fingers: the art follows their middle and their spread
  const g = pinchOf(s);
  if (s.pinch && g) {
    const moved = panBy(s.view, g.mid[0] - s.pinch.mid[0], g.mid[1] - s.pinch.mid[1], s.lim);
    s.view = s.target = zoomAt(moved, g.d / s.pinch.d, g.mid[0], g.mid[1], s.lim);
  }
  s.pinch = g;
}
function up(e) {
  const s = st;
  if (!s || !s.ptrs.delete(e.pointerId)) return;
  s.pinch = pinchOf(s);
  if (!s.ptrs.size) s.touch.classList.remove("grabbing");
}
// A mouse wheel zooms, a trackpad swipe pans, a pinch zooms; one scroll keeps its kind (lobby-touch.js wheelKind)
function wheel(e) {
  const s = st;
  e.preventDefault();
  if (!ready(s)) return;
  const [sx, sy] = stagePoint(s, e), unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1, now = performance.now();
  const r = s.o.host.getBoundingClientRect(), k = r.width ? STAGE.width / r.width : 1;
  const step = wheelStep(e);
  if (e.ctrlKey) {
    s.scroll = { kind: null, at: -Infinity };
    if (now < s.pinchUntil) return; // WebKit's pinch comes as gesture events
    zoomTo(s, step !== "smooth" ? notchZoom(e, unit) : Math.exp(-e.deltaY * unit * PINCH), sx, sy);
    return;
  }
  const fresh = !(now - s.scroll.at < SCROLL_MS && s.scroll.kind), kind = wheelKind(e, now, s.scroll);
  if (fresh) {
    // a scroll that starts like a wheel keeps the view it started from, to go back to if it turns out a trackpad
    const zooms = kind === "mouse" && !e.deltaMode && Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    s.scroll = { kind, at: now, from: zooms ? s.target : null };
  } else {
    if (s.scroll.kind === "mouse" && kind === "trackpad" && s.scroll.from) s.target = s.scroll.from;
    if (step === "notch" || kind === "trackpad") s.scroll.from = null;
    s.scroll.kind = kind;
    s.scroll.at = now;
  }
  if (kind === "mouse" && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) { zoomTo(s, notchZoom(e, unit), sx, sy); return; }
  pan(s, -e.deltaX * unit * k, kind === "mouse" ? 0 : -e.deltaY * unit * k);
}
// Safari and WKWebView trackpad pinch
function gestureStart(e) { e.preventDefault(); if (st) { st.gesture = 1; st.pinchUntil = performance.now() + 300; } }
function gestureChange(e) {
  e.preventDefault();
  const s = st;
  if (!ready(s)) return;
  s.pinchUntil = performance.now() + 300;
  const [sx, sy] = stagePoint(s, e);
  zoomTo(s, e.scale / s.gesture, sx, sy);
  s.gesture = e.scale;
}
function gestureEnd(e) { e.preventDefault(); if (st) st.pinchUntil = performance.now() + 300; }
const prevent = (e) => e.preventDefault();

const HANDLERS = [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up],
  ["wheel", wheel, { passive: false }], ["gesturestart", gestureStart], ["gesturechange", gestureChange],
  ["gestureend", gestureEnd], ["contextmenu", prevent], ["dragstart", prevent]];

// Escape leaves, like the game's back key
function onKey(e) {
  if (e.key !== "Escape" || !isOpen()) return;
  e.preventDefault();
  st.o.onBack();
}

// for checks: the view, the home view and the limits
export const state = () => (st ? {
  view: { ...st.view }, target: { ...st.target }, home: { ...st.home }, kMax: st.lim.kMax, box: [...st.lim.box],
  glide: st.glide?.kind || null, hidden: st.hidden, closing: !!st.closing,
} : null);
