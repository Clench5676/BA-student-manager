// Tests for web/js/nav-items.js (the bottom navigation's entries: which are greyed, their names, the hand-off and its
// prompt, the greyed look) and, without a game folder, the hand-off prompt drawn plain by web/js/popup.js, on a small
// stand-in DOM. Run by tests/test_nav_items.py with Node's test runner: node --test tests/js/nav_items.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { ITEMS, NGUI_GREY, activate, greyed, handOffPrompt, tintOf, view } from "../../src/ba_modding_toolkit/web/js/nav-items.js";

const T = (key, vars = {}) => (key === "nav.classic" ? `${vars.label} - Classic UI` : `<${key}>`);
const CLASSIC = ["crc_tool", "asset_packer", "asset_extractor", "adb_push", "tools"];

test("Students and Batch Import have web screens and the five classic entries are greyed", () => {
  assert.equal(ITEMS.length, 7);
  assert.equal(ITEMS[1].route, "#/import");
  assert.equal(greyed(ITEMS[1]), false);
  assert.ok(!ITEMS.some((item) => ["mod_update", "batch_update", "mod_install"].includes(item.classic)));
  assert.equal(greyed(ITEMS[0]), false);
  assert.equal(ITEMS[0].route, "#/roster");
  assert.deepEqual(ITEMS.filter(greyed).map((it) => it.classic), CLASSIC);
});

test("an entry with a route is never greyed, whatever classic tab it keeps", () => {
  assert.equal(greyed({ label: "nav.crc", classic: "crc_tool", route: "#/update" }), false);
  assert.equal(greyed({ label: "x", classic: "tools" }), true);
  assert.equal(greyed({ label: "x" }), false);
});

test("each greyed entry is named for assistive technology, never with a tooltip, and hands off its tab", () => {
  for (const item of ITEMS.filter(greyed)) {
    const v = view(item, T);
    assert.equal(v.greyed, true);
    assert.equal(v.label, `<${item.label}>`);
    assert.equal(v.name, `<${item.label}> - Classic UI`);
    assert.equal(v.tab, item.classic);
    assert.equal(v.route, null);
    assert.equal("title" in v, false, "no tooltip (decision 19)");
  }
  const students = view(ITEMS[0], T);
  assert.deepEqual(students, { label: "<nav.students>", name: "<nav.students>", greyed: false, route: "#/roster", tab: null });
});

// the page's parts as stand-ins
function page(answer) {
  const log = [];
  return {
    log,
    go: (route) => log.push(["go", route]),
    ask: async (item) => { log.push(["ask", item.classic]); return answer; },
    open: async (tab) => { log.push(["open", tab]); },
    savePrompt: async (value) => { log.push(["save", value]); },
  };
}
const classicItem = ITEMS[2];

for (const item of ITEMS.filter((item) => item.route)) test(`a click on ${item.route} goes to its screen without a prompt`, async () => {
  const p = page(null);
  assert.equal(await activate(item, { ...p, prompt: true }), "route");
  assert.deepEqual(p.log, [["go", item.route]]);
});

test("with the prompt on: Open hands off; Don't Ask Again is saved only with Open (decision 6)", async () => {
  let p = page({ button: "ok", checked: false });
  assert.equal(await activate(classicItem, { ...p, prompt: true }), "open");
  assert.deepEqual(p.log, [["ask", "crc_tool"], ["open", "crc_tool"]]);

  p = page({ button: "ok", checked: true });
  assert.equal(await activate(classicItem, { ...p, prompt: true }), "open");
  assert.deepEqual(p.log, [["ask", "crc_tool"], ["save", false], ["open", "crc_tool"]], "turned off before the hand-off");

  for (const answer of [{ button: "cancel", checked: true }, { button: null, checked: true }, { button: "cancel", checked: false }]) {
    p = page(answer);
    assert.equal(await activate(classicItem, { ...p, prompt: true }), "cancel");
    assert.deepEqual(p.log, [["ask", "crc_tool"]], "Cancel, Escape, the backdrop or the close button save nothing");
  }
});

test("with classicPrompt off, a click hands off at once (decision 6)", async () => {
  const p = page(null);
  assert.equal(await activate(ITEMS[6], { ...p, prompt: false }), "open");
  assert.deepEqual(p.log, [["open", "tools"]]);
});

test("the hand-off prompt: the entry's label, where it opens, Don't Ask Again unticked, Cancel and Open", () => {
  assert.deepEqual(handOffPrompt(classicItem, T), {
    title: "<nav.crc>", lines: ["<classic.hint>"], check: { label: "<mods.dontAsk>", checked: false },
    ok: "<settings.classic.open>", cancel: "<popup.cancel>",
  });
});

// UILobby's bottom menu as the layout export gives it (Front/Bottom/Menu/BG/Grid), cut down
const n = (name, children = [], widgets = []) => ({ name, active: true, pos: [0, 0], scale: [1, 1], rotZ: 0, widgets, children });
const spr = (sprite, color) => ({ cls: "UISprite", sprite, color });
const GRID = n("Grid", [
  n("Student", [n("Label", [], [{ cls: "UILabel", text: "Students", color: "#2d4664/1.00" }]), n("Able", [], [spr("Common_Icon_Student", "#ffffff/1.00")]),
    n("Disable", [n("Icon", [], [spr("Common_Icon_Student", "#797979/1.00")]), n("Lock", [], [spr("Common_Icon_Lock", "#ffffff/1.00")])])]),
]);

test("the greyed look: UILobby's disabled tint, else NGUI's default grey, else plain without a game", () => {
  assert.deepEqual(tintOf(GRID), { mode: "game", factor: 0.4745 }, "#797979 on the icon, the label untouched");
  assert.deepEqual(tintOf(n("Grid", [n("Shop", [n("Able", [], [spr("Common_Icon_Shop", "#ffffff/1.00")])])])), { mode: "ngui", factor: NGUI_GREY });
  assert.deepEqual(tintOf(null), { mode: "ngui", factor: 0.5 }, "the prefab could not be read");
  assert.deepEqual(tintOf(GRID, { game: false }), { mode: "plain", factor: 0.5 });
  // a coloured tint is taken by its mean
  const tinted = n("Grid", [n("Cafe", [n("Disable", [n("Icon", [], [spr("Common_Icon_Cafe", "#ff0000/1.00")])])])]);
  assert.deepEqual(tintOf(tinted), { mode: "game", factor: 0.3333 });
});

// --- without a game folder: the hand-off prompt drawn plain (popup.js), on a stand-in DOM with no prefab to read ---
class El {
  constructor(tag = "div") {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentNode: null, style: {}, dataset: {}, attrs: {}, listeners: {} });
    Object.assign(this, { hidden: false, className: "", textContent: "", id: "", tabIndex: 0 });
  }
  get childNodes() { return [...this.children]; }
  get parentElement() { return this.parentNode; }
  appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...kids) { for (const c of [...this.children]) c.remove(); for (const k of kids) this.appendChild(k); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  contains(node) { for (let x = node; x; x = x.parentNode) if (x === this) return true; return false; }
  get isConnected() { return document.body.contains(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ type: "click" }); }
  focus() { document.activeElement = this; }
  querySelector() { return null; }
  getContext() { return { font: "", measureText(s) { return { width: s.length * 10 }; } }; }
}
const body = new El("body");
const walk = (x, out = []) => { out.push(x); for (const c of x.children) walk(c, out); return out; };
globalThis.document = {
  body, activeElement: body, documentElement: { lang: "en-US", appendChild() {} },
  createElement: (tag) => new El(tag),
  getElementById: (id) => walk(body).find((x) => x.id === id) || null,
  querySelector: () => null,
};
const keyListeners = [];
globalThis.addEventListener = (type, fn) => { if (type === "keydown") keyListeners.push(fn); };
globalThis.removeEventListener = () => {};
const press = (key) => { const ev = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const fn of keyListeners) fn(ev); return ev; };
const dialog = body.appendChild(new El());
dialog.id = "dialog";
dialog.hidden = true;
// no game: every prefab is missing
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null });
const warn = console.warn;
console.warn = (...args) => { if (!/popup layout|message popup without/.test(String(args[0]))) warn(...args); };
const Popup = await import("../../src/ba_modding_toolkit/web/js/popup.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const action = (name) => walk(dialog).find((e) => e.dataset?.action === name);
async function drawn(name) {
  for (let i = 0; i < 200; i++) { const b = action(name); if (b) return b; await tick(); }
  throw new Error(`no ${name} button`);
}

test("without a game folder the hand-off prompt is drawn plain, and works the same", async () => {
  const ask = (item) => Popup.message(handOffPrompt(item, T));
  // Open with Don't Ask Again ticked: saved, then handed off
  let p = page(null);
  let run = activate(classicItem, { ...p, ask, prompt: true });
  const check = await drawn("check");
  assert.equal(check.getAttribute("role"), "checkbox");
  assert.equal(check.getAttribute("aria-checked"), "false");
  const texts = walk(dialog).map((e) => e.textContent).filter(Boolean);
  assert.ok(texts.includes("<nav.crc>") && texts.includes("<classic.hint>"), "the title and the line");
  check.click();
  assert.equal(check.getAttribute("aria-checked"), "true");
  assert.equal(action("ok").getAttribute("aria-label"), "<settings.classic.open>");
  action("ok").click();
  assert.equal(await run, "open");
  assert.deepEqual(p.log, [["save", false], ["open", "crc_tool"]]);
  assert.equal(dialog.hidden, true);

  // ticked, then Cancel: nothing saved, nothing opened
  p = page(null);
  run = activate(classicItem, { ...p, ask, prompt: true });
  (await drawn("check")).click();
  action("cancel").click();
  assert.equal(await run, "cancel");
  assert.deepEqual(p.log, []);

  // Escape closes it like Cancel
  p = page(null);
  run = activate(classicItem, { ...p, ask, prompt: true });
  await drawn("ok");
  assert.ok(press("Escape").defaultPrevented);
  assert.equal(await run, "cancel");
  assert.deepEqual(p.log, []);
});

test("without a game folder a plain message still takes its confirm keys", async () => {
  const m = Popup.message({ title: "<quit.title>", lines: ["<quit.ask>"], ok: "<picker.ok>", cancel: "<popup.cancel>", confirmKeys: ["Enter", " "] });
  const ok = await drawn("ok");
  const layer = dialog.children[0];
  assert.equal(document.activeElement, layer, "the popup takes the focus");
  const key = (target, k) => { const ev = { key: k, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const fn of layer.listeners.keydown || []) fn(ev); return ev; };
  assert.equal(key(ok, "Enter").defaultPrevented, false, "a focused button takes its own key");
  assert.ok(key(layer, "Enter").defaultPrevented);
  assert.deepEqual(await m, { button: "ok", checked: null });
});
