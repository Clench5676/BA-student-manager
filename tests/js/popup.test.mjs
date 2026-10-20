// Tests for web/js/popup.js (the shared popups: the stack Escape goes to, the message popup, the list popup with
// several cards ticked, the start sequence) and web/js/update.js (resolves when its popup closes), on a small stand-in
// DOM. Run by tests/test_popup.py with Node's test runner: node --test tests/js/popup.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

// --- a stand-in DOM: elements in a tree, ids, clicks, the focus and the window's key listeners ---
class El {
  constructor(tag = "div") {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentNode: null, style: {}, dataset: {}, attrs: {}, listeners: {} });
    Object.assign(this, { hidden: false, className: "", textContent: "", id: "", font: "", tabIndex: 0 });
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
  set innerHTML(_) { for (const c of [...this.children]) c.remove(); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get isConnected() { return document.body.contains(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ type: "click" }); }
  focus() { document.activeElement = this; }
  querySelector() { return null; }
  // a canvas: text is measured at 0.6 of its size per character
  getContext() { return { font: "", measureText(s) { return { width: s.length * 0.6 * parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || 10) }; } }; }
}
const body = new El("body");
const walk = (n, out = []) => { out.push(n); for (const c of n.children) walk(c, out); return out; };
globalThis.document = {
  body, activeElement: body, documentElement: { lang: "en-US", appendChild() {} },
  createElement: (tag) => new El(tag),
  getElementById: (id) => walk(body).find((n) => n.id === id) || null,
  querySelector: () => null,
};
const keyListeners = [];
globalThis.addEventListener = (type, fn) => { if (type === "keydown") keyListeners.push(fn); };
globalThis.removeEventListener = () => {};
function press(key, extra = {}) {
  const ev = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  for (const fn of keyListeners) fn(ev);
  return ev;
}
const host = (id) => { const h = body.appendChild(new El()); h.id = id; h.hidden = true; return h; };
const dialog = host("dialog"), prompt = host("prompt"), consent = host("consent");

// --- the server: an empty atlas index (no sprite draws, the buttons are worked out from their nodes), the popup
// frame's prefab, the update check ---
const n = (name, pos, widgets = [], children = []) => ({ name, active: true, pos, scale: [1, 1], rotZ: 0, widgets, children });
const spr = (name, w, h, extra = {}) => ({ sprite: name, atlas: "Common", type: 1, w_: w, h_: h, pivot: 4, depth: 5, color: "#ffffff/1.00", ...extra });
const lbl = () => ({ cls: "UILabel", text: "text", fontSize: 72, color: "#2d4664/1.00", w_: 400, h_: 180, pivot: 4, depth: 9 });
const SORT = n("UIPopup_Sort", [0, 0], [], [n("Center", [0, 0], [], [
  n("BlackBg", [0, 0], [], [n("BlackBgClickArea", [0, 0], [spr("Common_Square_Bg", 2976, 2232, { color: "#000000/0.94" })])]),
  n("Popup", [0, 0], [], [
    n("Base", [0, -20], [], [n("BG", [0, 8], [spr("Common_Popup_Bg", 2458, 1355)], [
      n("Texture_Top", [-977, 609], [{ texture: "Top", w_: 500, h_: 100, pivot: 4, depth: 6, color: "#ffffff/1.00" }]),
      n("Label_Title_Locale", [0, 611], [lbl()], [n("Line", [0, -52], [spr("Common_Square_Bg", 160, 12)])]),
      n("Btn_Close", [1144, 616], [spr("Common_Icon_Close", 60, 60, { type: 0 })]),
    ])]),
    n("Btn", [0, -499], [], [
      n("Btn_Ok", [292, 0], [], [n("Label_Locale", [0, 2], [lbl()]), n("BG (1)", [0, -4], [spr("Common_Btn_BG", 496, 177)])]),
      n("Btn_Cancel", [-292, 0], [], [n("BG (1)", [0, -4], [spr("Common_Btn_BG", 496, 177)]), n("Label_Locale", [0, 2], [lbl()])]),
    ]),
    n("Normal", [0, 0]),
  ]),
])]);
let update = null; // what app.checkUpdate answers
const calls = [];
const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
  if (url === "/api/rpc") {
    const { method, params } = JSON.parse(opts.body);
    calls.push(method);
    return reply({ result: method === "app.checkUpdate" ? update : null, params });
  }
  if (url === "/asset/ui/atlases.json" || url === "/asset/ui/textures.json") return reply({});
  if (url === "/asset/ui/layout/UIPopup_Sort.json") return reply(SORT);
  return reply(null, false); // the other prefabs are optional
};

// the prefabs this server lacks are optional: their warning is expected
const warn = console.warn;
console.warn = (...args) => { if (!String(args[0]).startsWith("popup layout")) warn(...args); };

const Popup = await import("../../src/ba_modding_toolkit/web/js/popup.js");
const Update = await import("../../src/ba_modding_toolkit/web/js/update.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const actionsIn = (root) => walk(root).filter((e) => e.dataset?.action);
const action = (root, name) => actionsIn(root).find((e) => e.dataset.action === name);
// waits until a button is drawn in root
async function drawn(root, name) {
  for (let i = 0; i < 200; i++) { const b = action(root, name); if (b) return b; await tick(); }
  throw new Error(`no ${name} button`);
}
const state = (promise) => Promise.race([promise.then((v) => ({ done: v })), tick().then(() => "pending")]);

test("Escape goes to the topmost open popup only, and to none under one that must be answered", () => {
  const a = body.appendChild(new El()), b = body.appendChild(new El());
  const closed = [];
  Popup.opened(a, (how) => closed.push(["a", how]));
  Popup.opened(b, (how) => closed.push(["b", how]));
  // drawing the lower one again keeps its place
  Popup.opened(a, (how) => closed.push(["a", how]));
  assert.equal(Popup.top().host, b);
  assert.ok(press("Escape").defaultPrevented);
  assert.deepEqual(closed, [["b", "escape"]]);
  b.hidden = true; // closed: off the stack by itself
  press("Escape");
  assert.deepEqual(closed, [["b", "escape"], ["a", "escape"]]);
  a.hidden = true;
  assert.equal(Popup.top(), null);
  assert.equal(press("Escape").defaultPrevented, false, "nothing open: the key is the screen's");
  // a popup without a way out takes the key: the one under it stays
  a.hidden = false;
  b.hidden = false;
  Popup.opened(a, () => closed.push(["a", "again"]));
  Popup.opened(b, null);
  assert.ok(press("Escape").defaultPrevented);
  assert.equal(closed.length, 2);
  // an input method composing, or a control that took the key itself
  b.hidden = true;
  press("Escape", { isComposing: true });
  press("Escape", { keyCode: 229 });
  press("Escape", { defaultPrevented: true });
  assert.equal(closed.length, 2);
  press("Enter");
  assert.equal(closed.length, 2);
  a.remove();
  b.remove();
});

test("a message resolves with the button and the checkbox however it closes", async () => {
  const before = body.appendChild(new El("button"));
  before.focus();
  const m = Popup.message({ title: "Classic UI Open", lines: ["Close the classic UI first"], ok: "OK", cancel: "Bring to Front", check: { label: "Apply automatically once it closes" } });
  await drawn(dialog, "ok");
  assert.equal(dialog.hidden, false);
  assert.equal(document.activeElement, dialog.children[0], "the popup takes the focus");
  assert.equal(await state(m), "pending");
  const check = action(dialog, "check");
  assert.equal(check.getAttribute("role"), "checkbox");
  assert.equal(check.getAttribute("aria-checked"), "false");
  check.click();
  assert.equal(check.getAttribute("aria-checked"), "true");
  press("Escape");
  assert.deepEqual(await m, { button: null, checked: true });
  assert.equal(dialog.hidden, true);
  assert.equal(document.activeElement, before, "the focus goes back");
  before.remove();

  for (const [name, button] of [["ok", "ok"], ["cancel", "cancel"], ["close", null]]) {
    const p = Popup.message({ title: "Remove", lines: ["The game may not start"], ok: "Remove", cancel: "Cancel", check: { label: "Don't Ask Again", checked: true } });
    (await drawn(dialog, name)).click();
    assert.deepEqual(await p, { button, checked: true }, name);
  }
  // without a checkbox, checked is null; the backdrop closes like Escape
  const p = Popup.message({ title: "Notice", lines: ["Quit?"], ok: "Confirm", cancel: "Cancel" });
  await drawn(dialog, "ok");
  Popup.top().close("backdrop");
  assert.deepEqual(await p, { button: null, checked: null });
});

test("messages stack: Escape closes the one in front, the line buttons act", async () => {
  const lower = Popup.message({ title: "Enable Mods", lines: ["Mods stay in the mod library", { text: "Not switched: 2", button: { label: "Retry", fn: () => retried.push(1) } },
    { text: "Other mods not checked", button: { label: "Allow Check", fn: ({ close }) => close("ok") } }], ok: "OK" });
  const retried = [];
  await drawn(dialog, "line1");
  action(dialog, "line1").click();
  assert.deepEqual(retried, [1]);
  const upper = Popup.message({ title: "Official File Overwritten", lines: ["No official copy left"], ok: "OK" });
  await tick();
  assert.equal(dialog.children.length, 2);
  press("Escape");
  assert.deepEqual(await upper, { button: null, checked: null });
  assert.equal(await state(lower), "pending");
  assert.equal(dialog.hidden, false);
  // a line's button may close its popup
  action(dialog, "line2").click();
  assert.deepEqual(await lower, { button: "ok", checked: null });
  assert.equal(dialog.hidden, true);
});

test("confirm keys press OK while the popup is in front and holds the focus; none by default", async () => {
  const keyOn = (layer, target, key, extra = {}) => {
    const ev = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of layer.listeners.keydown || []) fn(ev);
    return ev;
  };
  // the quit prompt: Enter and Space, as the PC client binds its popups' confirm
  const quit = Popup.message({ title: "Notice", lines: ["Quit?"], ok: "Confirm", cancel: "Cancel", confirmKeys: ["Enter", " "] });
  await drawn(dialog, "ok");
  const layer = dialog.children.at(-1);
  assert.equal(keyOn(layer, action(dialog, "cancel"), "Enter").defaultPrevented, false, "a focused button takes its own key");
  for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { defaultPrevented: true }]) {
    keyOn(layer, layer, "Enter", extra);
  }
  keyOn(layer, layer, "a");
  assert.equal(await state(quit), "pending");
  // another message in front: the keys are its own
  const front = Popup.message({ title: "Remove", lines: ["The game may not start"], ok: "Remove" });
  await tick();
  assert.equal(keyOn(layer, layer, "Enter").defaultPrevented, false);
  press("Escape");
  await front;
  assert.ok(keyOn(layer, layer, " ").defaultPrevented);
  assert.deepEqual(await quit, { button: "ok", checked: null });
  // without confirmKeys, Enter presses nothing
  const plain = Popup.message({ title: "Remove", lines: ["The game may not start"], ok: "Remove", cancel: "Cancel" });
  await drawn(dialog, "ok");
  const l2 = dialog.children.at(-1);
  assert.equal(keyOn(l2, l2, "Enter").defaultPrevented, false);
  assert.equal(await state(plain), "pending");
  action(dialog, "cancel").click();
  await plain;
});

test("the hand-off prompt saves Don't Ask Again only with Open (decision 6)", async () => {
  const { ITEMS, activate, handOffPrompt } = await import("../../src/ba_modding_toolkit/web/js/nav-items.js");
  const T = (key) => key;
  const ask = (item) => Popup.message(handOffPrompt(item, T));
  const run = () => {
    const log = [];
    const done = activate(ITEMS[3], { prompt: true, ask, go: () => log.push("go"), open: async (tab) => log.push(`open ${tab}`), savePrompt: async (v) => log.push(`save ${v}`) });
    return { log, done };
  };
  for (const [ticked, button, expected] of [[true, "ok", ["save false", "open mod_install"]], [false, "ok", ["open mod_install"]], [true, "cancel", []], [true, "close", []]]) {
    const r = run();
    const box = await drawn(dialog, "check");
    if (ticked) box.click();
    action(dialog, button).click();
    await r.done;
    assert.deepEqual(r.log, expected, `${ticked ? "ticked" : "unticked"}, ${button}`);
  }
});

test("a message that must be answered has no close button and ignores Escape", async () => {
  const p = Popup.message({ title: "Mods Back to Official", lines: ["Game files verified, repaired or updated"], ok: "Apply Mod Configuration", cancel: "Keep as Is", close: false });
  await drawn(dialog, "ok");
  assert.equal(action(dialog, "close"), undefined);
  assert.ok(press("Escape").defaultPrevented);
  assert.equal(await state(p), "pending");
  action(dialog, "cancel").click();
  assert.deepEqual(await p, { button: "cancel", checked: null });
});

const items = [
  { key: "a", label: "A", full: "A", thumb: null, big: null, size: 100 },
  { key: "b", label: "B", full: "B", thumb: null, big: null, size: 250 },
  { key: "c", label: "C", full: "C", thumb: null, big: null, size: 4000, disabled: true, dim: true, badge: { text: "Overwritten", color: "#d9822b" } },
  { key: "d", label: "D", full: "D", thumb: null, big: null },
];

test("several cards ticked: all that can be, to start with, and their size added up", () => {
  const all = Popup.selectable(items);
  assert.deepEqual([...all], ["a", "b", "d"]);
  assert.equal(Popup.sizeOf(items, all), 350);
  const less = Popup.toggled(all, items, "b");
  assert.deepEqual([...less].sort(), ["a", "d"]);
  assert.deepEqual([...all], ["a", "b", "d"], "the selection given is left as it is");
  assert.equal(Popup.sizeOf(items, less), 100);
  assert.deepEqual([...Popup.toggled(less, items, "b")].sort(), ["a", "b", "d"]);
  assert.deepEqual([...Popup.toggled(less, items, "c")].sort(), ["a", "d"], "a card that cannot be ticked");
  assert.deepEqual([...Popup.toggled(less, items, "zz")].sort(), ["a", "d"]);
  assert.equal(Popup.sizeOf(items, new Set()), 0);
});

test("a list popup with several cards ticked, its buttons and no way out but them", async () => {
  const picked = [], pressed = [];
  let selected = Popup.selectable(items);
  const draw = () => Popup.listPopup({
    host: prompt, title: "Mods Not in the Library", items, multi: true, selected,
    onSelect: (key) => { picked.push(key); selected = Popup.toggled(selected, items, key); return draw(); },
    buttons: [{ label: "Later", fn: () => pressed.push("later") }, { label: "Add to Library", fn: () => pressed.push("add"), primary: true, action: "add" }],
    hint: "Lost to a game update or file check unless added", footer: "Selected: 3",
    check: { label: "Don't Ask Again", checked: false },
    details: (it) => ({ title: "Portrait", fields: [["File", `${it.key}.bundle`]], actions: [] }),
  });
  await draw();
  const cards = () => walk(prompt).filter((e) => e.dataset?.key);
  assert.deepEqual(cards().map((c) => c.dataset.key), ["a", "b", "c", "d"], "in the list's order");
  assert.deepEqual(cards().map((c) => c.getAttribute("aria-checked")), ["true", "true", "false", "true"]);
  assert.equal(action(prompt, "close"), undefined, "no close button");
  assert.ok(press("Escape").defaultPrevented);
  assert.equal(prompt.hidden, false);
  await cards().find((c) => c.dataset.key === "b").click();
  await tick();
  assert.deepEqual(picked, ["b"]);
  assert.deepEqual(cards().map((c) => c.getAttribute("aria-checked")), ["true", "false", "false", "true"]);
  action(prompt, "add").click();
  action(prompt, "button0").click();
  assert.deepEqual(pressed, ["add", "later"]);
  action(prompt, "check").click();
  prompt.hidden = true;
});

test("Update.check resolves when its popup closes, not when it is drawn", async () => {
  update = null;
  assert.equal(await Update.check(consent), null, "no newer release: nothing to wait for");
  update = { current: "0.1.0-alpha.3", version: "0.1.0-beta", installable: true };
  const later = Update.check(consent);
  await drawn(consent, "later");
  assert.equal(await state(later), "pending");
  assert.equal(Popup.top().host, consent, "on the popup stack");
  action(consent, "later").click();
  assert.equal(await later, "later");
  assert.equal(consent.hidden, true);
  // Escape is Later
  const escaped = Update.check(consent);
  await drawn(consent, "later");
  press("Escape");
  assert.equal(await escaped, "later");
  // a build that cannot be installed here: the download page
  update = { ...update, installable: false };
  const page = Update.check(consent);
  (await drawn(consent, "page")).click();
  assert.equal(await page, "page");
  assert.ok(calls.includes("app.openReleasePage"));
});

test("the start popups come one at a time, in order; one that fails does not stop the others", async () => {
  const log = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const done = Popup.sequence([
    ["consent", () => { log.push("consent"); return first; }],
    ["scan", () => false], // nothing to show
    ["update", () => { log.push("update"); throw new Error("offline"); }],
    ["drift", async () => { log.push("drift"); }],
  ]);
  const errors = console.error;
  console.error = () => {};
  try {
    await tick();
    assert.deepEqual(log, ["consent"], "the next one waits for the first to close");
    release();
    await done;
  } finally {
    console.error = errors;
  }
  assert.deepEqual(log, ["consent", "update", "drift"]);
});

test("whenIdle waits for the open popups to close", async () => {
  const h = body.appendChild(new El());
  Popup.opened(h, () => {});
  let idle = false;
  const p = Popup.whenIdle(5).then(() => { idle = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(idle, false);
  h.hidden = true;
  await p;
  assert.equal(idle, true);
  assert.equal(Popup.anyOpen(), false);
  h.remove();
});
