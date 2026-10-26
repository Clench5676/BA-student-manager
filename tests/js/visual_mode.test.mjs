// Tests for web/js/visual-mode.js on a small stand-in DOM: the detail screen's UI set aside while a fullscreen view is
// open, and leaving it, which closes the visual mode whatever the screen shows by then. Run by
// tests/test_visual_mode.py with Node's test runner: node --test tests/js/visual_mode.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

// --- a stand-in DOM: a tree of nodes, the focus, the window's key listeners and a clock ---
class Node {
  constructor(name = "div") {
    Object.assign(this, { name, children: [], parent: null, hidden: false, inert: false, style: {}, className: "", listeners: {} });
    const names = new Set();
    this.classList = { add: (c) => names.add(c), remove: (c) => names.delete(c), contains: (c) => names.has(c) };
  }
  appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; }
  replaceChildren(...kids) { for (const c of [...this.children]) c.remove(); for (const k of kids) this.appendChild(k); }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  closest(selector) {
    assert.equal(selector, "[inert]");
    for (let n = this; n; n = n.parent) if (n.inert) return n;
    return null;
  }
  get isConnected() { return document.body.contains(this); }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  addEventListener(type, fn) { (this.listeners[type] ||= new Set()).add(fn); }
  removeEventListener(type, fn) { this.listeners[type]?.delete(fn); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1920, height: 1080 }; }
  get offsetWidth() { return 0; }
  getContext() { return { font: "", measureText: () => ({ width: 0 }) }; }
}
const body = new Node("body");
globalThis.document = { body, activeElement: body, createElement: (name) => new Node(name) };
const windowListeners = {};
globalThis.addEventListener = (type, fn) => (windowListeners[type] ||= new Set()).add(fn);
globalThis.removeEventListener = (type, fn) => windowListeners[type]?.delete(fn);
const press = (key) => { for (const fn of [...(windowListeners.keydown || [])]) fn({ key, preventDefault() {} }); };
let now = 0;
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true, writable: true });

const Visual = await import("../../src/ba_modding_toolkit/web/js/visual-mode.js");
const { setSpineConsent } = await import("../../src/ba_modding_toolkit/web/js/spine-runtime.js");
setSpineConsent(true);
globalThis.spine = {};

// the detail screen: the parts fullscreen slides out (the two halves of the prefab's UI, the top bar, the navigation),
// the hosts the visual mode draws into, the portrait's player in the detail framing
const DETAIL = { x: -1480, y: -1000, width: 2960, height: 1665 };
function screen() {
  const stage = body.appendChild(new Node("stage"));
  const [left, right, topbar, nav, bgHost, uiHost] = ["left", "right", "topbar", "nav", "visual-bg", "visual-ui"].map((n) => stage.appendChild(new Node(n)));
  const zoom = left.appendChild(new Node("button"));
  const lobbyTab = right.appendChild(new Node("button"));
  const player = { currentViewport: { ...DETAIL, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 } };
  const out = [left, right, topbar, nav];
  return { stage, out, left, right, topbar, nav, bgHost, uiHost, zoom, lobbyTab, player };
}
// the visual mode without its prefab (no background, no buttons): the touch area and Escape
function openVisual(s, onBack = () => {}, alive) {
  return Visual.open({
    parts: null, skeleton: { data: { x: -580, y: -747, width: 1161, height: 2074 } }, detail: { ...DETAIL },
    host: s.stage, bgHost: s.bgHost, uiHost: s.uiHost, players: () => [s.player], onBack, alive,
  });
}
// the portrait's player draws frames until the glide ends
function drawFrames(s, ms = 2000) {
  for (let t = 0; t <= ms; t += 16) { now += 16; Visual.frame(s.player); }
}

test("while a fullscreen view is open the slid-out UI is inert and the focus lets go of it; it comes back", () => {
  const s = screen();
  s.zoom.focus();
  Visual.uiOut([...s.out, null]);
  for (const part of s.out) assert.equal(part.inert, true);
  assert.equal(document.activeElement, body, "the zoom button keeps no focus behind the fullscreen view");
  // a second call (nothing focused in the parts) keeps the control to return to
  Visual.uiOut(s.out);
  Visual.uiBack([...s.out, null]);
  for (const part of s.out) assert.equal(part.inert, false);
  assert.equal(document.activeElement, s.zoom, "the focus is back on the control that had it");
  s.stage.remove();
});

test("a focus outside the slid-out UI stays; none comes back to a control that is gone or while the screen is left", () => {
  let s = screen();
  const exit = s.stage.appendChild(new Node("fs-exit"));
  exit.focus();
  Visual.uiOut(s.out);
  assert.equal(document.activeElement, exit);
  Visual.uiBack(s.out);
  assert.equal(document.activeElement, exit);
  // the screen was rendered again meanwhile: the old zoom button is gone
  s.zoom.focus();
  Visual.uiOut(s.out);
  s.zoom.remove();
  Visual.uiBack(s.out);
  assert.equal(document.activeElement, body);
  // the screen is being left (detail.js hide())
  s.stage.remove();
  s = screen();
  s.zoom.focus();
  Visual.uiOut(s.out);
  Visual.uiBack(s.out, { refocus: false });
  assert.equal(document.activeElement, body);
  // nothing is left over for the next fullscreen view
  Visual.uiOut(s.out);
  Visual.uiBack(s.out);
  assert.equal(document.activeElement, body);
  s.stage.remove();
});

test("visual mode without confirmation opens no fullscreen controls", async () => {
  const s = screen();
  setSpineConsent(false);
  try {
    assert.equal(await openVisual(s), false);
    assert.equal(Visual.isOpen(), false);
    assert.equal(s.uiHost.children.length, 0);
  } finally { setSpineConsent(true); s.stage.remove(); }
});

test("leaving while visual mode awaits the runtime cannot open stale controls", async () => {
  const s = screen();
  let active = true;
  const opening = openVisual(s, () => {}, () => active);
  active = false;
  assert.equal(await opening, false);
  assert.equal(Visual.isOpen(), false);
  assert.equal(s.uiHost.children.length, 0);
  s.stage.remove();
});

test("leaving fullscreen closes the visual mode even after the tab changed under it", async () => {
  const s = screen();
  let backs = 0;
  s.zoom.focus();
  Visual.uiOut(s.out);
  await openVisual(s, () => { backs += 1; });
  assert.ok(Visual.isOpen());
  assert.equal(s.uiHost.hidden, false);
  assert.equal(s.uiHost.children[0].className, "visual-touch");
  drawFrames(s);
  assert.equal(Visual.state().glide, null, "the portrait shows the whole art");
  // the lobby tab cannot be reached: it is inert, and so is every other control of the detail screen
  assert.ok(s.lobbyTab.closest("[inert]"));
  // Escape is the game's back key: the caller leaves fullscreen (detail.js setFullscreen(false)), which closes the
  // visual mode whatever the tab is by then; the portrait's player is gone when the tab changed, so the glide back
  // may never be drawn and the timer ends it
  press("Escape");
  assert.equal(backs, 1);
  s.player = { currentViewport: null };
  Visual.uiBack(s.out);
  assert.equal(Visual.isOpen(), false);
  assert.equal(Visual.state().closing, true);
  assert.equal(s.uiHost.children[0].style.pointerEvents, "none", "the touch area takes no more presses");
  press("Escape");
  assert.equal(backs, 1, "Escape does nothing once the visual mode is leaving");
  assert.equal(document.activeElement, s.zoom);
  s.stage.remove();
});

test("leaving glides the portrait back to the detail framing exactly and takes the visual mode's parts away", async () => {
  const s = screen();
  Visual.uiOut(s.out);
  await openVisual(s);
  drawFrames(s);
  Visual.uiBack(s.out);
  drawFrames(s, 300);
  assert.ok(Visual.state(), "still gliding back");
  drawFrames(s);
  assert.equal(Visual.state(), null);
  assert.equal(s.uiHost.hidden, true);
  assert.equal(s.uiHost.children.length, 0);
  assert.equal(s.bgHost.hidden, true);
  const { x, y, width, height } = s.player.currentViewport;
  assert.deepEqual({ x, y, width, height }, DETAIL);
  s.stage.remove();
});

test("the visual mode draws no top-right Hide UI / Show UI button (BL-047)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../src/ba_modding_toolkit/web/js/visual-mode.js", import.meta.url), "utf8");
  const corners = /const CORNERS = (\[.*\]);/.exec(src)[1];
  assert.doesNotMatch(corners, /RightTop|Btn_HideUI|Btn_ShowUI/);
  assert.match(corners, /"LeftTop", \["Btn_Back"\]/);
  assert.match(corners, /"RightBottom", \["Btn_RefreshPos", "Btn_RefreshPos_Disable"\]/);
});
