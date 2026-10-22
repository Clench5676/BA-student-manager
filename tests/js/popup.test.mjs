// Tests for web/js/popup.js (the shared popups: the stack Escape goes to, the message popup, the list popup with
// several cards ticked, the start sequence), web/js/update.js and detail.js's preview actions, on a small stand-in
// DOM. Run by tests/test_popup.py with Node's test runner: node --test tests/js/popup.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { afterEach, test } from "node:test";
import vm from "node:vm";
import { switchPrefabs } from "./switch_prefabs.mjs";
import { controls, insert } from "./control_prefabs.mjs";

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
  set innerHTML(html) {
    for (const c of [...this.children]) c.remove();
    const stack = [this];
    for (const match of html.matchAll(/<(\/?)(\w+)(?:\s+class="([^"]*)")?[^>]*>/g)) {
      if (match[1]) stack.pop();
      else { const el = new El(match[2]); el.className = match[3] || ""; stack.at(-1).appendChild(el); stack.push(el); }
    }
  }
  get classList() {
    return { replace: (a, b) => { this.classList.remove(a); this.classList.add(b); }, add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); } };
  }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get isConnected() { return document.body.contains(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() {
    let result;
    for (const fn of this.listeners.click || []) result = fn({ type: "click", target: this, currentTarget: this });
    return result;
  }
  focus() { document.activeElement = this; }
  querySelector(selector) { return walk(this).find((e) => selector.startsWith(".")
    ? e.className.split(" ").includes(selector.slice(1)) : e.tagName === selector.toUpperCase()) || null; }
  // a canvas: text is measured at 0.6 of its size per character
  getContext() { return { font: "", drawImage() {}, fillRect() {}, measureText(s) { return { width: s.length * 0.6 * parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || 10) }; } }; }
  toBlob(fn) { fn(new Blob()); }
}
globalThis.Image = class {
  naturalWidth = 8;
  naturalHeight = 8;
  set src(_) { queueMicrotask(() => this.onload?.()); }
};
let events;
globalThis.EventSource = class {
  constructor() { events = this; this.listeners = {}; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  emit(type, data) { this.listeners[type]?.({ data: JSON.stringify(data) }); }
};
const body = new El("body");
const walk = (n, out = []) => { out.push(n); for (const c of n.children) walk(c, out); return out; };
globalThis.document = {
  body, activeElement: body, documentElement: { lang: "en-US", appendChild() {} },
  createElement: (tag) => new El(tag),
  getElementById: (id) => walk(body).find((n) => n.id === id) || null,
  querySelector: (selector) => selector === ".popup-host:not([hidden]), .consent-host:not([hidden])"
    ? walk(body).find((e) => !e.hidden && ["popup-host", "consent-host"].some((cls) => e.className.split(" ").includes(cls))) || null : null,
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
const settings = host("settings");
settings.className = "popup-host";
consent.className = "consent-host";
const stage = host("stage");
stage.hidden = false;

// --- the server: a small atlas index (the progress and button sprites only), the popup
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
// A synthetic prefab pattern with a top-right pivot and fixed-size parent anchors.
for (const button of SORT.children[0].children[1].children.find((c) => c.name === "Btn").children) {
  button.children.find((c) => c.name === "BG (1)").children.push(n("Corner", [-50, -20], [
    spr("Common_Btn_Normal_B_C_Pt", 126, 70, { type: 0, pivot: 2,
      anchors: { leftAnchor: [1, -130], rightAnchor: [1, -4], bottomAnchor: [1, -76], topAnchor: [1, -6] } }),
  ]));
}
// The settings test uses General only; the tabs and popup frame retain their real paths.
const OPTIONS = structuredClone(SORT);
OPTIONS.name = "UIPopup_Option_PC";
OPTIONS.children[0].children[1].children.push(
  n("TabBg", [0, 0], [], [n("Grid", [0, 0])]),
  n("Game", [0, 0], [], ["Tab_On", "Tab_Off"].map((name) => n(name, [0, 0], [], [n("Label_Locale", [0, 0], [lbl()])]))),
);
const controlLayouts = controls();
const switchLayouts = switchPrefabs();
insert(OPTIONS, "Center/Popup/List/Sound_Setting/ETCSetting/ButtonBg", controlLayouts.option.children[0].children[0].children[0].children[0].children[0].children[0]);
let update = null; // what app.checkUpdate answers
const calls = [];
const requests = [], handlers = new Map();
const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
  if (url === "/api/rpc") {
    const { method, params } = JSON.parse(opts.body);
    calls.push(method);
    requests.push({ method, params });
    if (handlers.has(method)) return reply(await handlers.get(method)(params));
    return reply({ result: method === "app.checkUpdate" ? update : null, params });
  }
  if (url === "/asset/ui/atlases.json") return reply({ Common: Object.fromEntries(
    ["Common_Square_Bg", "Common_Bg_Raius10px", "Common_Btn_BG", "Common_Popup_Bg", "Common_Btn_Normal_B_C_Pt",
      "Common_Line_Raius20px", "Common_Icon_Reddot2", "Card_Ability_Select_Line", "Card_Ability_Select_Line_Icon", "Cafe_Icon_NameEdit"].map((name) => [name, { width: 8, height: 8 }])) });
  if (url === "/asset/ui/textures.json") return reply({});
  if (url === "/asset/ui/layout/UICharacterCollectionPopulatorUnit.json") return reply(switchLayouts.unit);
  if (url === "/asset/ui/layout/UINonEquipmentInventory.json") return reply(switchLayouts.inventory);
  if (url === "/asset/ui/layout/UIPopup_Sort.json") return reply(SORT);
  if (url === "/asset/ui/layout/UIPopup_FilterSort.json") return reply(controlLayouts.filter);
  if (url === "/asset/ui/layout/UIPopup_Option_PC.json") return reply(OPTIONS);
  return reply(null, false); // the other prefabs are optional
};

// the prefabs this server lacks are optional: their warning is expected
const warn = console.warn;
console.warn = (...args) => { if (!String(args[0]).startsWith("popup layout")) warn(...args); };

const Popup = await import("../../src/ba_modding_toolkit/web/js/popup.js");
const Update = await import("../../src/ba_modding_toolkit/web/js/update.js");
const { S } = await import("../../src/ba_modding_toolkit/web/js/util.js");
const { setStrings } = await import("../../src/ba_modding_toolkit/web/js/i18n.js");
const { setSpineConsent } = await import("../../src/ba_modding_toolkit/web/js/spine-runtime.js");
setSpineConsent(true);
const runtime = vm.createContext({ console, TextDecoder, TextEncoder, Float32Array, Uint8Array, Uint16Array, Int16Array, Int32Array, ArrayBuffer, DataView });
vm.runInContext(readFileSync(new URL("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js", import.meta.url), "utf8"), runtime);
globalThis.spine = runtime.spine;
const english = JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url))).webui;
function strings(value, prefix = "webui") {
  return Object.entries(value).flatMap(([key, text]) => typeof text === "object" ? strings(text, `${prefix}.${key}`) : [[`${prefix}.${key}`, text]]);
}
setStrings("en-US", Object.fromEntries(strings(english)));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const actionsIn = (root) => walk(root).filter((e) => e.dataset?.action);
const action = (root, name) => actionsIn(root).find((e) => e.dataset.action === name);
// waits until a button is drawn in root
async function drawn(root, name) {
  for (let i = 0; i < 1000; i++) { const b = action(root, name); if (b) return b; await tick(); }
  throw new Error(`no ${name} button`);
}
const state = (promise) => Promise.race([promise.then((v) => ({ done: v })), tick().then(() => "pending")]);
async function until(fn) {
  for (let i = 0; i < 1000; i++) { if (fn()) return; await tick(); }
  assert.fail("popup did not reach the expected state");
}
const part = (name) => walk(consent).find((e) => e.dataset.path === `Center/Popup/${name}`);

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  for (const layer of [...dialog.children].reverse()) action(layer, "close")?.click();
});

test("fitting message lines together keeps the size floor and all text when extra wrapping is needed", async () => {
  const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  const text = "A long explanation ".repeat(15).trim();
  const opened = Popup.message({ title: "Help", lines: ["On", text], width: 700, fitTogether: [0, 1] });
  await drawn(dialog, "close");
  const lines = [0, 1].map((i) => walk(dialog).find((e) => e.dataset.path === `Center/Popup/Lines/Line_${i}`));
  const size = `${(NGUI.fontSizeFor(text, 44) * S).toFixed(2)}px`;
  assert.equal(lines[0].style.fontSize, size);
  assert.equal(lines[1].style.fontSize, size);
  assert.ok(lines[1].textContent.split("\n").length > 4);
  assert.equal(lines[1].textContent.replaceAll("\n", " "), text);
  action(dialog, "close").click();
  await opened;
});

test("plain message line buttons keep their actions and allow closing the popup", async () => {
  let details = 0;
  const pending = Popup.message({ title: "Help", plain: true, lines: ["On", "Off",
    { text: "Not switched", button: { label: "Retry", fn: ({ close }) => close("retry") } },
    { text: "Left as is", button: { label: "Details", fn: () => { details++; } } },
  ] });
  await drawn(dialog, "line3");
  action(dialog, "line3").click();
  assert.equal(details, 1);
  assert.equal(dialog.hidden, false);
  action(dialog, "line2").click();
  assert.deepEqual(await pending, { button: "retry", checked: null });
  assert.equal(dialog.hidden, true);
});
const available = { current: "0.1.0-alpha.3", version: "0.1.0-beta", installable: true, downloaded: false, file: null };

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

test("scrollable findings wrap long paths and unbroken names inside the frame, keeping actions outside", async () => {
  const lines = ["CH0261_home.skel - rig differs", "Intro_Shoulder_L/".repeat(90), "x".repeat(180),
    { text: "Region_".repeat(100), button: { label: "Details", fn: () => { details++; } } }];
  let details = 0;
  const pending = Popup.message({ title: "Compatibility", lines, ok: "Remap", cancel: "Cancel", scroll: true });
  const ok = await drawn(dialog, "ok");
  const area = walk(dialog).find((el) => el.className === "popup-cards");
  const inner = area.children[0];
  assert.ok(parseFloat(inner.style.height) > parseFloat(area.style.height));
  const rows = walk(inner).filter((el) => /^Lines\/Row_\d+$/.test(el.dataset.path));
  assert.equal(rows.length, lines.length);
  for (const row of rows) {
    const width = parseFloat(row.style.width), fs = parseFloat(row.style.fontSize);
    assert.ok(row.textContent.split("\n").every((line) => line.length * fs * 0.6 <= width + 1), row.dataset.path);
  }
  assert.ok(rows[1].textContent.includes("\n") && rows[2].textContent.includes("\n"));
  assert.ok(parseFloat(ok.style.top) >= parseFloat(area.style.top) + parseFloat(area.style.height));
  action(dialog, "line3").click();
  assert.equal(details, 1);
  assert.ok(action(dialog, "cancel"));
  ok.click();
  assert.deepEqual(await pending, { button: "ok", checked: null });
});

test("shared message sizes and scrolling preserve complete paths with and without row buttons", async () => {
  const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  const path = "Intro_Shoulder_L/".repeat(90), name = "x".repeat(180);
  for (const boxed of [false, true]) {
    const lines = ["On", path, boxed ? { text: name, button: { label: "Details" } } : name];
    const pending = Popup.message({ title: "Findings", lines, fitTogether: [0, 1], scroll: true, ok: "OK" });
    const ok = await drawn(dialog, "ok");
    const area = walk(dialog).find((el) => el.className === "popup-cards");
    const prefix = boxed ? "Row" : "Line";
    const rows = [0, 1, 2].map((i) => walk(area).find((el) => el.dataset.path === `Lines/${prefix}_${i}`));
    const size = `${(NGUI.fontSizeFor(path, boxed ? 40 : 44) * S).toFixed(2)}px`;
    assert.equal(rows[0].style.fontSize, size);
    assert.equal(rows[1].style.fontSize, size);
    assert.equal(rows[1].textContent.replaceAll("\n", ""), path);
    assert.equal(rows[2].textContent.replaceAll("\n", ""), name);
    for (const row of rows) {
      const width = parseFloat(row.style.width), fs = parseFloat(row.style.fontSize);
      assert.ok(row.textContent.split("\n").every((line) => line.length * fs * 0.6 <= width + 1));
    }
    assert.ok(parseFloat(area.children[0].style.height) > parseFloat(area.style.height));
    assert.ok(parseFloat(ok.style.top) >= parseFloat(area.style.top) + parseFloat(area.style.height));
    ok.click();
    await pending;
  }
});

test("compatibility details scroll the complete list and return to the same Remap and Cancel actions", async () => {
  const Compatibility = await import("../../src/ba_modding_toolkit/web/js/mod-compatibility.js");
  const names = Array.from({ length: 80 }, (_, i) => `Intro_Shoulder_L/Intro_Shoulder_L_${i}`);
  const input = (paths) => ({ atlases: {}, textures: {}, skeletons: { "CH0261_home.skel": {
    version: "4.2.33", data: Buffer.from(JSON.stringify({ bones: [{ name: "root" }], slots: [{ name: "face", bone: "root" }],
      skins: { default: { face: Object.fromEntries(paths.map((name) => [name, { width: 2, height: 2 }])) } } })).toString("base64"),
  } } });
  let remapped = 0;
  const pending = Compatibility.show({ official: input([]), mod: input(names), remappable: true },
    { onRemap: () => { remapped++; } });
  const remap = await drawn(dialog, "ok"), cancel = action(dialog, "cancel");
  assert.equal(remap.getAttribute("aria-label"), english.remap.action);
  const detail = action(dialog, "line0");
  assert.equal(detail.getAttribute("aria-label"), english.info.details);
  const viewing = detail.click();
  await until(() => dialog.children.length === 2 && actionsIn(dialog).filter((el) => el.dataset.action === "ok").length === 2);
  const full = dialog.children.at(-1), area = walk(full).find((el) => el.className === "popup-cards");
  assert.ok(parseFloat(area.children[0].style.height) > parseFloat(area.style.height));
  const text = walk(full).map((el) => el.textContent).join("\n");
  for (const name of names) assert.ok(text.replaceAll("\n", "").includes(name));
  assert.equal(remapped, 0);
  action(full, "ok").click();
  await viewing;
  assert.ok(remap.isConnected && cancel.isConnected);
  remap.click();
  await pending;
  assert.equal(remapped, 1);
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
    const done = activate(ITEMS.find((item) => item.classic === "crc_tool"), { prompt: true, ask, go: () => log.push("go"), open: async (tab) => log.push(`open ${tab}`), savePrompt: async (v) => log.push(`save ${v}`) });
    return { log, done };
  };
  for (const [ticked, button, expected] of [[true, "ok", ["save false", "open crc_tool"]], [false, "ok", ["open crc_tool"]], [true, "cancel", []], [true, "close", []]]) {
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

test("switch detail actions retain the prefab pattern at every button width and keep their hit areas", async () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.02, `${a} != ${b}`);
  for (const count of [1, 2, 3, 4]) {
    let clicked = -1;
    await Popup.listPopup({ host: prompt, title: "Portrait", items: [items[0]], selected: items[0].key,
      details: () => ({ title: "Portrait", fields: [], actions: Array.from({ length: count }, (_, i) =>
        [i ? "Check compatibility" : "Show in Finder", () => { clicked = i; }]) }) });
    for (let i = 0; i < count; i++) {
      const path = `Details/Act_${i}/Body`, findPart = (p) => walk(prompt).find((e) => e.dataset.path === p);
      const body = findPart(path), corner = findPart(`${path}/Corner`), box = (el) =>
        ["left", "top", "width", "height"].map((key) => parseFloat(el.style[key]));
      const [x, y, w, h] = box(body), [dx, dy, dw, dh] = box(corner), k = 120 / 177 * S;
      near(x + w - dx - dw, 4 * k);
      near(dy - y, 6 * k);
      near(dw, 126 * k);
      near(dh, 70 * k);
      const button = walk(prompt).find((e) => e.tagName === "BUTTON" && e.style.left === `${x}px` && e.style.top === `${y}px`);
      assert.ok(button);
      assert.deepEqual(box(button), box(body));
      button.click();
      assert.equal(clicked, i);
    }
    prompt.hidden = true;
  }
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

test("a late background update waits for every popup and job before showing on the current screen", async () => {
  let answer, job = true;
  handlers.set("app.checkUpdate", () => new Promise((resolve) => { answer = resolve; }));
  const pending = Update.check(consent, undefined, { beforeShow: () => Popup.whenIdle(5, () => job) });
  await until(() => answer);
  const first = Popup.message({ title: "Current screen", lines: ["Details"] });
  await drawn(dialog, "close");
  answer({ result: available });
  await tick();
  assert.equal(consent.hidden, true, "a late result must not cover the current popup");
  action(dialog, "close").click();
  await first;
  await tick();
  assert.equal(consent.hidden, true, "the job still runs after that popup closes");
  const second = Popup.message({ title: "Another screen", lines: ["Result"] });
  await drawn(dialog, "close");
  job = false;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(consent.hidden, true, "recheck popups after the job finishes");
  action(dialog, "close").click();
  await second;
  (await drawn(consent, "later")).click();
  assert.equal(await pending, "later");
  handlers.clear();
});

test("a queued update never replaces a consent popup in its own host", async () => {
  consent.hidden = false;
  const current = consent.appendChild(new El());
  const pending = Update.check(consent, available, { beforeShow: () => Popup.whenIdle(5) });
  await tick();
  assert.equal(consent.children[0], current);
  assert.equal(action(consent, "later"), undefined);
  consent.hidden = true;
  consent.innerHTML = "";
  (await drawn(consent, "later")).click();
  assert.equal(await pending, "later");
});

test("automatic checks with no release or an offline error do not wait for popup readiness", async () => {
  for (const response of [{ result: null }, { error: { code: "internal" } }]) {
    handlers.set("app.checkUpdate", () => response);
    assert.equal(await Update.check(consent, undefined, { beforeShow: () => assert.fail("no offer to queue") }), null);
    assert.equal(consent.hidden, true);
  }
  handlers.clear();
});

test("update progress stays in NGUI, blocks buttons and Escape, and completion waits for Restart", async () => {
  update = { ...available };
  const start = calls.length;
  let release;
  handlers.set("app.update", () => new Promise((resolve) => { release = () => resolve({ result: "download" }); }));
  handlers.set("jobs.get", () => ({ result: { state: "running" } }));
  const done = Update.check(consent);
  const first = await drawn(consent, "update");
  first.click();
  first.click();
  await until(() => release);
  const later = action(consent, "later"), downloading = action(consent, "update");
  assert.ok(later.disabled && downloading.disabled);
  assert.equal(downloading.getAttribute("aria-disabled"), "true");
  assert.equal(part("Btn/Btn_Ok/Label_Locale").style.color, "#828282");
  later.click();
  downloading.click();
  assert.ok(press("Escape").defaultPrevented);
  assert.equal(await state(done), "pending");
  assert.equal(consent.hidden, false);
  release();
  await until(() => calls.slice(start).includes("jobs.get"));
  const progress = async (current, total, p) => {
    events.emit("job.progress", { id: "download", current, total, label: "build.dmg" });
    await until(() => part("Status")?.textContent === `Downloading ${p}%`);
    return part("Progress/Fill");
  };
  assert.equal(await progress(20, 0, 0), undefined, "unknown total: zero, without an invalid bar width");
  const fill = await progress(50, 100, 50);
  assert.equal(parseFloat(fill.style.width) / parseFloat(part("Progress").style.width), 0.5);
  assert.ok(fill.style.backgroundImage, "the bar uses a rendered, tinted sprite");
  const bounds = (el) => {
    const top = parseFloat(el.style.top), height = parseFloat(el.style.height);
    return { top, height, bottom: top + height };
  };
  const bar = bounds(part("Progress")), status = bounds(part("Status")), frame = bounds(part("Base/BG"));
  assert.ok(bar.top - status.bottom >= 6 * S, "the status has a gap above the bar");
  for (const name of ["Btn_Ok", "Btn_Cancel"]) {
    const button = bounds(part(`Btn/${name}/BG (1)`));
    assert.ok(Math.abs(button.height - 177 * S) < 0.01, "check the prefab's full button background height");
    assert.ok(button.top - bar.bottom >= 12 * S, "the full button background clears the progress bar");
    assert.ok(button.bottom < frame.bottom, "the buttons stay within the 1500x820 frame");
  }
  await progress(200, 100, 100);
  await progress(-10, 100, 0);
  // In-flight progress renders cannot replace the ready state after completion.
  events.emit("job.progress", { id: "download", current: 100, total: 100 });
  events.emit("job.done", { id: "download", result: { file: "/session/build.dmg" } });
  await drawn(consent, "restart");
  assert.equal(part("Status").textContent, "Download Complete");
  assert.equal(part("Progress"), undefined);
  assert.equal(action(consent, "restart").disabled, false);
  assert.equal(await state(done), "pending");
  assert.equal(calls.slice(start).filter((m) => m === "app.update").length, 1);
  first.click();
  await tick();
  assert.equal(calls.slice(start).includes("app.installUpdate"), false);
  action(consent, "later").click();
  assert.equal(await done, "later");
  assert.equal(calls.slice(start).includes("app.installUpdate"), false);

  const ready = { ...available, downloaded: true, file: "/session/build.dmg" };
  // Settings passes its result; startup and subsequent checks fetch it themselves.
  for (const supplied of [true, false]) {
    update = ready;
    const before = calls.length;
    const again = supplied ? Update.check(consent, ready) : Update.check(consent);
    await drawn(consent, "restart");
    assert.equal(part("Status").textContent, "Download Complete");
    assert.deepEqual(calls.slice(before), supplied ? [] : ["app.checkUpdate"]);
    press("Escape");
    assert.equal(await again, "later");
  }
  handlers.clear();
});

test("download failures stay inside the popup, allow retry, and resolve only when dismissed", async () => {
  update = { ...available };
  handlers.set("app.update", () => ({ result: "retry" }));
  handlers.set("jobs.get", () => ({ result: { state: "running" } }));
  const start = calls.length;
  const done = Update.check(consent);
  (await drawn(consent, "update")).click();
  await until(() => calls.slice(start).includes("jobs.get"));
  events.emit("job.failed", { id: "retry", code: "update_checksum_mismatch" });
  await until(() => part("Status")?.textContent === english.error.update_checksum_mismatch);
  assert.equal(await state(done), "pending");
  assert.equal(consent.hidden, false);
  assert.equal(action(consent, "update").disabled, false);
  assert.equal(action(consent, "later").disabled, false);
  assert.equal(part("Progress"), undefined);
  const beforeRetry = calls.length;
  action(consent, "update").click();
  await until(() => calls.slice(beforeRetry).includes("jobs.get"));
  events.emit("job.done", { id: "retry", result: { file: "/session/retry.dmg" } });
  await drawn(consent, "restart");
  assert.equal(part("Status").textContent, "Download Complete");
  assert.equal(calls.slice(start).filter((m) => m === "app.update").length, 2);
  action(consent, "later").click();
  assert.equal(await done, "later", "a successful retry clears the failure");

  for (const code of ["update_download_failed", "internal"]) {
    handlers.set("app.update", () => ({ error: code === "internal" ? {} : { code } }));
    const failed = Update.check(consent);
    (await drawn(consent, "update")).click();
    await until(() => part("Status")?.textContent === english.error[code].replace(/\{\w+\}/g, ""));
    assert.equal(await state(failed), "pending");
    press("Escape");
    assert.equal(await failed, "update", "the failed-update result is deferred until the popup closes");
  }
  handlers.clear();
});

test("only Restart installs, and every install refusal stays ready for another attempt", async () => {
  update = { ...available, downloaded: true, file: "/session/verified.dmg" };
  const start = calls.length;
  let answer;
  handlers.set("app.installUpdate", () => new Promise((resolve) => { answer = resolve; }));
  const done = Update.check(consent);
  for (const code of ["classic_open", "busy", "update_unavailable", "update_unsupported", "update_restart_failed"]) {
    answer = null;
    (await drawn(consent, "restart")).click();
    await until(() => answer);
    assert.ok(action(consent, "restart").disabled);
    action(consent, "restart").click();
    action(consent, "later").click();
    press("Escape");
    assert.equal(await state(done), "pending");
    answer({ error: { code } });
    await until(() => part("Status")?.textContent === english.error[code]);
    assert.equal(action(consent, "restart").disabled, false);
    assert.equal(action(consent, "restart").getAttribute("aria-label"), "Restart");
    assert.equal(consent.hidden, false);
  }
  assert.equal(calls.slice(start).filter((m) => m === "app.installUpdate").length, 5);
  assert.equal(calls.slice(start).includes("app.update"), false);
  assert.ok(requests.filter((r) => r.method === "app.installUpdate").every((r) => r.params.file === update.file));
  action(consent, "later").click();
  assert.equal(await done, "update");
  handlers.clear();
});

test("Restart recovers to ready when installUpdate succeeds but the page is still alive", async (t) => {
  const timers = [], realTimeout = setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms === 3000) { timers.push(fn); return 0; }
    return realTimeout(fn, ms, ...args);
  });
  update = { ...available, downloaded: true, file: "/session/verified.dmg" };
  handlers.set("app.installUpdate", () => ({ result: null }));
  const restarted = Update.check(consent);
  (await drawn(consent, "restart")).click();
  await until(() => timers.length);
  assert.equal(part("Status").textContent, english.update.restarting);
  assert.equal(await state(restarted), "pending", "the app closes on successful install; startup cannot advance under it");
  assert.ok(action(consent, "restart").disabled);
  timers.shift()();
  await until(() => part("Status")?.textContent === english.error.update_restart_failed);
  assert.equal(action(consent, "restart").disabled, false);
  assert.equal(action(consent, "later").disabled, false);
  assert.equal(await state(restarted), "pending");
  handlers.set("app.installUpdate", () => ({ error: { code: "busy" } }));
  action(consent, "restart").click();
  await until(() => part("Status")?.textContent === english.error.busy);
  assert.equal(action(consent, "restart").disabled, false);
  press("Escape");
  assert.equal(await restarted, "update");
  handlers.clear();
});

test("concurrent checks share one request and popup through download and dismissal, per host", async () => {
  let answer;
  const start = calls.length;
  handlers.set("app.checkUpdate", () => new Promise((resolve) => { answer = resolve; }));
  handlers.set("app.update", () => ({ result: "single-download" }));
  handlers.set("jobs.get", () => ({ result: { state: "running" } }));
  const first = Update.check(consent), second = Update.check(consent);
  assert.equal(second, first, "the host is reserved before the check finishes");
  await until(() => answer);
  assert.equal(calls.slice(start).filter((m) => m === "app.checkUpdate").length, 1);
  answer({ result: available });
  (await drawn(consent, "update")).click();
  await until(() => calls.slice(start).includes("jobs.get"));
  const locked = action(consent, "update");
  assert.equal(Update.check(consent, { ...available, version: "9.0.0" }), first);
  await tick();
  assert.equal(action(consent, "update"), locked, "a late result cannot replace the locked popup");
  press("Escape");
  assert.equal(consent.hidden, false);
  assert.equal(await state(first), "pending");
  // Another host has its own popup and promise.
  const other = host("other-update"), independent = Update.check(other, available);
  assert.notEqual(independent, first);
  (await drawn(other, "later")).click();
  assert.equal(await independent, "later");
  other.remove();
  events.emit("job.done", { id: "single-download", result: { file: "/session/single.dmg" } });
  await drawn(consent, "restart");
  assert.equal(Update.check(consent), first);
  action(consent, "later").click();
  assert.deepEqual(await Promise.all([first, second]), ["later", "later"]);
  const again = Update.check(consent, available);
  assert.notEqual(again, first, "a closed popup releases the host");
  (await drawn(consent, "later")).click();
  assert.equal(await again, "later");
  handlers.clear();
});

test("Settings disables Check for Updates while pending and uses the shared popup check", async () => {
  const Settings = await import("../../src/ba_modding_toolkit/web/js/settings.js");
  handlers.set("settings.get", () => ({ result: {
    version: "1.0.0", language: "en-US", languages: [["en-US", "English"]].map(([code, name]) => ({ code, name })),
    cacheDir: "/test/cache", native: true,
  } }));
  handlers.set("mods.state", () => ({ result: {} }));
  let answer;
  handlers.set("app.checkUpdate", () => new Promise((resolve) => { answer = resolve; }));
  const checkButton = () => walk(settings).find((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === english.settings.update.check);
  await Settings.open();
  const start = calls.length, button = checkButton();
  assert.ok(button);
  button.click();
  assert.equal(button.disabled, true, "disabled synchronously, before any RPC or redraw");
  button.click(); // even a stale or programmatic second click cannot start another check
  await until(() => answer);
  assert.equal(checkButton(), undefined, "a pending redraw has no enabled check hit area");
  assert.equal(calls.slice(start).filter((m) => m === "app.checkUpdate").length, 1);
  answer({ result: null });
  await until(() => checkButton());
  assert.equal(dialog.hidden, true, "no-update status stays silent");
  // A later check is allowed; its popup owns the same host and startup shares its promise.
  answer = null;
  checkButton().click();
  await until(() => answer);
  const shared = Update.check(consent);
  answer({ result: available });
  await drawn(consent, "update");
  assert.equal(settings.hidden, true);
  assert.equal(calls.slice(start).filter((m) => m === "app.checkUpdate").length, 2);
  assert.equal(Update.check(consent), shared);
  press("Escape");
  assert.equal(await shared, "later");
  handlers.clear();
});

test("Settings includes Thai as a sixth language with its native label and language tag", async () => {
  const Settings = await import("../../src/ba_modding_toolkit/web/js/settings.js");
  const languages = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "th-TH"].map((code) => ({
    code, name: JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${code}.json`, import.meta.url))).webui.languageName,
  }));
  handlers.set("settings.get", () => ({ result: { version: "1.0.0", language: "en-US", languages } }));
  handlers.set("mods.state", () => ({ result: {} }));
  try {
    await Settings.open();
    const labels = walk(settings).filter((e) => /Rows\/Language\/Opt_\d+\/Label$/.test(e.dataset.path || ""));
    assert.equal(labels.length, 6);
    assert.equal(labels[5].textContent, "ไทย");
    assert.equal(labels[5].lang, "th-TH");
    assert.ok(walk(settings).some((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === "ไทย"));
  } finally {
    press("Escape");
    handlers.clear();
  }
});

test("a manual Settings check joins an automatic offer already queued behind Settings", async () => {
  const Settings = await import("../../src/ba_modding_toolkit/web/js/settings.js");
  handlers.set("settings.get", () => ({ result: {
    version: "1.0.0", language: "en-US", languages: [{ code: "en-US", name: "English" }],
    cacheDir: "/test/cache", native: true,
  } }));
  handlers.set("mods.state", () => ({ result: {} }));
  let answer;
  handlers.set("app.checkUpdate", () => new Promise((resolve) => { answer = resolve; }));
  const start = calls.length;
  const automatic = Update.check(consent, undefined, { beforeShow: () => Popup.whenIdle(5) });
  await until(() => answer);
  await Settings.open();
  answer({ result: available });
  await tick();
  assert.equal(settings.hidden, false);
  assert.equal(consent.hidden, true);
  walk(settings).find((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === english.settings.update.check).click();
  await drawn(consent, "update");
  assert.equal(settings.hidden, true, "the joining check's onCheck still closes Settings");
  assert.equal(calls.slice(start).filter((m) => m === "app.checkUpdate").length, 1);
  action(consent, "later").click();
  assert.equal(await automatic, "later");
  handlers.clear();
});

test("every update locale has short completion and restart labels", () => {
  for (const language of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
    const locale = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${language}.json`, import.meta.url))).webui.update;
    assert.deepEqual(Object.keys(locale).sort(), Object.keys(english.update).sort());
    for (const key of ["complete", "restart"]) assert.ok(locale[key] && !/[.。!！·・]/u.test(locale[key]));
  }
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

test("whenIdle waits for caller work even without a popup", async () => {
  let busy = true;
  const pending = Popup.whenIdle(5, () => busy);
  assert.equal(await state(pending), "pending");
  busy = false;
  await pending;
});

test("the log popup preserves literal text, opens at the bottom and Copy leaves it open", async () => {
  const original = Array.from({ length: 500 }, (_, i) => `${i}: <script>literal</script>`).join("\n");
  let copied = null;
  const done = Popup.textViewer({ title: "Log", text: original, copy: "Copy", onCopy: () => { copied = original; } });
  await drawn(dialog, "copy");
  const pre = walk(dialog).find((n) => n.tagName === "PRE");
  assert.equal(pre.textContent, original);
  assert.equal(pre.children.length, 0);
  assert.equal(pre.scrollTop, pre.scrollHeight);
  action(dialog, "copy").click();
  assert.equal(copied, original);
  assert.equal(dialog.hidden, false);
  press("Escape");
  await done;
  assert.equal(dialog.hidden, true);
});

test("new card dots hide for in-use and selected mods independently", async () => {
  const items = [
    { key: "current", label: "In use", inUse: true, isNew: true },
    { key: "pending", label: "Pending", isNew: true },
    { key: "other", label: "Other", isNew: true },
    { key: "seen", label: "Seen" },
  ];
  for (const selected of ["current", "pending", "other"]) {
    await Popup.listPopup({ host: prompt, title: "Portrait", items, selected });
    const hasDot = (key) => walk(prompt).some((el) => el.dataset.path?.endsWith(`Card_${key}/Dot`));
    assert.equal(hasDot("current"), false, "an auto-applied mod stays unmarked after another card is picked");
    assert.equal(hasDot("pending"), selected !== "pending");
    assert.equal(hasDot("other"), selected !== "other");
    assert.equal(hasDot("seen"), false);
    assert.ok(items[0].isNew, "rendering must not consume the tab or roster mark");
  }
  prompt.hidden = true;
});

test("portrait and memorial lobby mods share the localized Mod chip under the name", async () => {
  for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
    const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
    setStrings(lang, { "webui.type.added": ui.type.added, "webui.popup.inUse": ui.popup.inUse });
    for (const kind of ["spr", "lobby"]) {
      await Popup.listPopup({ host: prompt, title: kind, items: [{ key: "m", kind: "mod", label: "Library mod", full: "Library mod", inUse: true }],
        selected: "m", okText: "OK", details: () => ({ title: kind, fields: [], actions: [] }) });
      const captions = walk(prompt).map((el) => el.textContent);
      assert.ok(captions.includes(ui.type.added), `${lang} ${kind}`);
      assert.ok(captions.includes(ui.popup.inUse), `${lang} ${kind} In Use`);
      prompt.hidden = true;
    }
  }
});

// Exercise the detail actions with the real RPC/job and popup code. The loader exposes its private actions only
// to this test and replaces thumbnail rendering; panel/player drawing is observed through the setup callback.
const DETAIL = new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url).href;
const THUMBS = new URL("../../src/ba_modding_toolkit/web/js/thumbs.js", import.meta.url).href;
const detailTest = `
export { baseOf, detailsBody, renderPopup, runUpdate, runCompatibility, copyName };
export function setupPreviewTest(data, kind, onLeft = async () => {}) {
  fam = data; variantKey = data.variants[0].key; ctx = { invalidateRoster() {} };
  open = true; busy = false; tab = kind === "lobby" ? "lobby" : "portrait";
  leftPage = new Promise(() => {});
  popupKind = kind; popupSeg = 0; pending = shownSource(variant(), kind); previewEnabled = modsOn();
  switchThumbnails?.cancel(); switchThumbnails = thumbnailScope(); switchPopupPage = pageToken;
  expression = "03"; mainPlayer = { cached: true }; lobbyShot = "cached";
  lobbySeq = "talk"; lobbyAll = true; lobbyStale = false; shownLeft = tab; shownKey = "cached";
  renderScreen = renderChips = renderExpressions = async () => {};
  renderLeft = onLeft;
}
export const previewTestState = () => ({ expression, mainPlayer, lobbyShot, lobbySeq, lobbyAll, lobbyStale, shownKey, pending });
`;
const thumbsTest = `
export const forgotten = [];
export const forget = (base) => forgotten.push(base);
export const thumb = async () => null;
export const withThumbnailFallback = async (picture, fallback) => await picture || fallback();
export function thumbnailScope() {
  const controller = new AbortController();
  return { signal: controller.signal, thumb, cancel: () => controller.abort() };
}
export const idleAnimation = () => null;
export const prioritise = () => {};
`;
register(`data:text/javascript,${encodeURIComponent(`
export async function load(url, ctx, next) {
  if (url === ${JSON.stringify(THUMBS)}) return { format: "module", shortCircuit: true, source: ${JSON.stringify(thumbsTest)} };
  const result = await next(url, ctx);
  if (url === ${JSON.stringify(DETAIL)}) {
    const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
    return { ...result, source: source + ${JSON.stringify(detailTest)} };
  }
  return result;
}`)}`);
const Detail = await import(DETAIL);
const Mods = await import("../../src/ba_modding_toolkit/web/js/mod-switch.js");
const Thumbs = await import(THUMBS);
const switchHost = host("popup");
const previewFamily = () => ({ key: "a", version: "rv1", variants: [
  { key: "a", spr: "a_spr", lobby: "a_home", configured: { spr: "mod:p", lobby: "mod:l" },
    state: { files: ["spr", "lobby"].map((kind) => ({ kind, file: `/game/${kind}.bundle`, applied: "official", official: true, crc: "ok" })) },
    modList: [{ id: "p", target: "a", kind: "spr", label: "Portrait mod" }, { id: "l", target: "a", kind: "lobby", label: "Lobby mod" }] },
  { key: "b", spr: "b_spr", state: { files: [{ kind: "spr", applied: "mod:leftover", official: false }] }, modList: [] },
] });
async function modsEnabled(enabled) {
  handlers.set("mods.state", () => ({ result: { enabled } }));
  await Mods.refresh();
}

test("detail variant candidates preview official assets independently of the source's live mod", () => {
  const fam = previewFamily(), source = fam.variants[1];
  assert.equal(Detail.baseOf({ kind: "variant", core: source.spr, variant: source }), "/asset/spine/official-spr/b_spr/skeleton");
  assert.equal(Detail.baseOf({ kind: "self", core: fam.variants[0].spr }), "/asset/spine/official-spr/a_spr/skeleton");
});

test("Update reloads a configured portrait or lobby rebuilt under the same mod id while mods are off", async () => {
  await modsEnabled(false);
  const inputs = { skeletons: {}, atlases: {}, textures: {} };
  handlers.set("actions.compatibility", () => ({ result: "compatibility" }));
  for (const [kind, id] of [["spr", "p"], ["lobby", "l"]]) {
    const fam = previewFamily(), draws = [];
    handlers.set("actions.compatibilityStamp", ({ mod }) => ({ result: `stamp-${mod}` }));
    Detail.setupPreviewTest(fam, kind, async () => draws.push(Detail.previewTestState()));
    handlers.set("actions.update", (params) => { assert.deepEqual(params, { mod: id }); return { result: "rebuild" }; });
    handlers.set("jobs.get", ({ id }) => ({ result: { state: "done", result: id === "compatibility" ? { official: inputs, mod: inputs } : {} } }));
    handlers.set("family.get", () => ({ result: structuredClone(fam) }));
    Thumbs.forgotten.length = 0;
    const updating = Detail.runUpdate();
    (await drawn(dialog, "ok")).click();
    assert.equal(await updating, true);
    await new Promise(setImmediate);
    for (const layer of [...dialog.children].reverse()) (await drawn(layer, "close")).click();
    assert.deepEqual(Thumbs.forgotten, [`/asset/spine/mod/${id}`]);
    assert.equal(draws.length, 1, `${kind} reloads even when family.get has no changed source key or game file`);
    if (kind === "spr") {
      assert.equal(draws[0].mainPlayer, null);
      assert.equal(draws[0].expression, "00");
      assert.equal(draws[0].lobbyShot, "cached", "the other preview stays cached");
    } else {
      assert.equal(draws[0].lobbyStale, true);
      assert.equal(draws[0].lobbyShot, null);
      assert.equal(draws[0].lobbySeq, null);
      assert.equal(draws[0].lobbyAll, false);
      assert.equal(draws[0].shownKey, null);
      assert.deepEqual(draws[0].mainPlayer, { cached: true }, "the portrait stays cached");
    }
    Detail.setupPreviewTest(fam, kind, async () => assert.fail("a failed update must keep the player"));
    handlers.set("actions.compatibilityStamp", () => ({ result: "failed-inputs" }));
    handlers.set("jobs.get", () => ({ result: { state: "failed", error: { code: "internal" } } }));
    Thumbs.forgotten.length = 0;
    const failed = Detail.runUpdate();
    assert.equal(await failed, false);
    await new Promise(setImmediate);
    for (const layer of [...dialog.children].reverse()) (await drawn(layer, "close")).click();
    assert.deepEqual(Thumbs.forgotten, []);
    assert.deepEqual(Detail.previewTestState().mainPlayer, { cached: true });
    assert.equal(Detail.previewTestState().lobbyShot, "cached");
  }
});

test("a compatibility check never updates an existing mod even when its bundle date differs", async () => {
  setStrings("en-US", Object.fromEntries(strings(english)));
  await modsEnabled(false);
  const fam = previewFamily();
  Detail.setupPreviewTest(fam, "spr");
  const inputs = { skeletons: {}, atlases: {}, textures: {} };
  handlers.set("actions.compatibility", () => ({ result: "compatibility" }));
  handlers.set("actions.update", () => assert.fail("compatibility cannot overwrite the mod"));
  handlers.set("jobs.get", () => ({ result: { state: "done", result: { official: inputs, mod: inputs, outdated: true } } }));
  const done = Detail.runCompatibility();
  (await drawn(dialog, "ok")).click();
  await done;
});

test("each mod card exposes a read-only compatibility check for its own mod", async () => {
  setStrings("en-US", Object.fromEntries(strings(english)));
  await modsEnabled(false);
  for (const [kind, id] of [["spr", "p"], ["lobby", "l"]]) {
    const fam = previewFamily();
    Detail.setupPreviewTest(fam, kind);
    let checks = 0;
    handlers.set("actions.compatibility", (params) => { assert.deepEqual(params, { mod: id }); checks++; return { result: "compatibility" }; });
    handlers.set("actions.update", () => assert.fail("a match requires no update"));
    const inputs = { skeletons: {}, atlases: {}, textures: {} };
    handlers.set("jobs.get", () => ({ result: { state: "done", result: { official: inputs, mod: inputs } } }));
    await Detail.renderPopup();
    const check = walk(switchHost).find((el) => el.getAttribute("aria-label") === english.compatibility.check);
    assert.ok(check);
    const checking = check.click();
    (await drawn(dialog, "ok")).click();
    await checking;
    await until(() => checks === 1 && dialog.hidden);
    switchHost.hidden = true;
  }
});

test("configured switch cards, chips and Status use verified Set or Installed", async () => {
  for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
    const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
    setStrings(lang, Object.fromEntries(["type", "popup", "switch", "status"].flatMap((group) =>
      Object.entries(ui[group]).map(([key, value]) => [`webui.${group}.${key}`, value]))));
    for (const [kind, source] of [["spr", "mod:p"], ["lobby", "mod:l"], ["spr", "variant:b"]]) {
      for (const enabled of [false, true]) {
        await modsEnabled(enabled);
        const fam = previewFamily();
        fam.variants[0].configured[kind] = source;
        fam.variants[0].selection = { [kind]: { source, installed: enabled } };
        if (enabled) Object.assign(fam.variants[0].state.files.find((f) => f.kind === kind), { applied: source, official: false });
        Detail.setupPreviewTest(fam, kind);
        await Detail.renderPopup();
        const captions = walk(switchHost).map((el) => el.textContent);
        const caption = enabled ? ui.status.installed : ui.switch.configured;
        assert.equal(captions.filter((c) => c === caption).length, 3,
          `${lang} ${kind} ${source}: card, chip and configured status`);
        if (source.startsWith("mod:")) assert.ok(captions.includes(ui.type.added));
        assert.ok(!captions.includes(enabled ? ui.switch.configured : ui.status.installed));
        switchHost.hidden = true;
      }
    }
  }
});

test("a saved source's detail chip keeps its caption independently of In Use", async () => {
  const ui = JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url))).webui;
  await Popup.listPopup({ host: prompt, title: "Portrait", items: [{ key: "m", kind: "mod", label: "Saved mod", full: "Saved mod",
    inUse: false, inUseText: ui.switch.configured, badge: { text: ui.switch.configured, color: "#8de4ff" } }],
    selected: "m", details: () => ({ title: "Portrait", fields: [], actions: [] }) });
  assert.equal(walk(prompt).filter((el) => el.textContent === ui.switch.configured).length, 2, "card badge and detail chip");
  prompt.hidden = true;
});

test("switch popup fields fit a long file independently in portrait and lobby details", async () => {
  const field = (prefix, i) => walk(prompt).find((el) => el.dataset.path === `Details/${prefix}_${i}`);
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
      setStrings(lang, Object.fromEntries(strings(ui)));
      for (const kind of ["portrait", "lobby"]) {
        const snapshots = [];
        for (const file of ["ibuki_spr.bundle", `${"azusa_swimsuit_spr".repeat(4)}.bundle`]) {
          const fields = [[ui.field.file, file], [ui.field.size, "20 MB"], [ui.field.status, ui.status.replaced], [ui.field.crc, ui.crc.fixed]];
          await Popup.listPopup({ host: prompt, title: ui.info.title[kind], items: [{ key: "m", kind: "mod", label: "Mod", full: "Mod" }],
            selected: "m", details: () => ({ title: ui.info.title[kind], fields, actions: [] }) });
          const cells = fields.map((_, i) => field("V", i));
          assert.equal(cells[0].getAttribute("aria-label"), file);
          assert.equal(cells[0].title, undefined);
          assert.equal(cells[0].style.pointerEvents, "none");
          if (file.length > 50) assert.ok(cells[0].textContent.includes("\n"), "a long file wraps inside its own row");
          snapshots.push({ values: cells.slice(1).map((el) => [el.textContent, el.style.fontSize]),
            labels: fields.map((_, i) => field("F", i).style.fontSize) });
        }
        assert.deepEqual(snapshots[1], snapshots[0], `${lang} ${kind}: the file does not resize the other values or labels`);
      }
    }
  } finally { prompt.hidden = true; setStrings("en-US", Object.fromEntries(strings(english))); }
});

test("long mod aliases and original file names share the switch detail name band in every locale", async () => {
  const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
      setStrings(lang, Object.fromEntries(strings(ui)));
      const alias = "Painted <summer> & colors ".repeat(8), original = "ibuki_dress_spr".repeat(16) + ".bundle";
      await Popup.listPopup({ host: prompt, title: ui.info.title.portrait,
        items: [{ key: "m", kind: "mod", label: alias, full: alias, original, nameEdit: { label: ui.modAlias.title, fn() {} } }],
        selected: "m", details: () => ({ title: ui.info.title.portrait, fields: [], actions: [] }) });
      const part = (name) => walk(prompt).find((el) => el.dataset.path === `Details/${name}`);
      const main = part("Name"), secondary = part("OriginalName");
      assert.equal(main.getAttribute("aria-label"), alias);
      assert.equal(secondary.getAttribute("aria-label"), original);
      assert.ok(parseFloat(main.style.fontSize) > parseFloat(secondary.style.fontSize));
      for (const el of [main, secondary]) assert.equal(el.children[0].style.textOverflow, "ellipsis");
      const a = NGUI.rect(main), b = NGUI.rect(secondary), chip = NGUI.rect(part("Chip_0"));
      assert.ok(a[1] + a[3] <= b[1], `${lang}: name lines do not overlap`);
      assert.ok(b[1] + b[3] <= chip[1], `${lang}: original name stays above chips`);
    }
  } finally { prompt.hidden = true; setStrings("en-US", Object.fromEntries(strings(english))); }
});

test("file details keep a smaller original name below the mod alias, including file-name fallback", () => {
  for (const mod of [{ alias: "My paint", core: "ibuki_spr" }, { alias: "My paint", file: "C:\\mods\\ibuki_spr.bundle" }]) {
    const { tree } = Detail.detailsBody({ fields: [[english.info.current, mod.alias, mod]], rows: [] });
    const value = tree.children.find((n) => n.name === "V_0"), original = tree.children.find((n) => n.name === "Original_0");
    assert.equal(value.widgets[0].ariaLabel, mod.alias);
    assert.equal(original.widgets[0].ariaLabel, mod.core || "ibuki_spr.bundle");
    assert.ok(value.widgets[0].fontSize > original.widgets[0].fontSize);
    assert.ok(value.pos[1] - value.widgets[0].h_ / 2 > original.pos[1] + original.widgets[0].h_ / 2);
    assert.equal(original.widgets[0].ellipsis, true);
  }
});

test("a long folder in the file-details summary does not resize the current value or labels", () => {
  const fields = [[english.field.folder, "/game"], [english.info.current, "ibuki_spr"]];
  const before = Detail.detailsBody({ fields, rows: [] }).tree;
  fields[0][1] = `/game/${"folder/".repeat(60)}`;
  const after = Detail.detailsBody({ fields, rows: [] }).tree;
  const widget = (tree, name) => tree.children.find((n) => n.name === name).widgets[0];
  for (const name of ["F_0", "F_1", "V_1"]) assert.deepEqual(widget(after, name), widget(before, name));
  assert.equal(widget(after, "V_0").ariaLabel, fields[0][1]);
  assert.equal(widget(after, "V_0").title, undefined);
  assert.ok(widget(after, "V_0").fontSize >= 28, "a wrapped path respects its size floor");
  assert.ok(widget(after, "V_0").text.includes("\n"));
});

test("repair review displays both pages and warnings; Accept alone stores the repaired mod", async () => {
  setStrings("en-US", Object.fromEntries(strings(english)));
  const Compatibility = await import("../../src/ba_modding_toolkit/web/js/mod-compatibility.js");
  globalThis.getComputedStyle = () => ({ opacity: "1" });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  const built = { preview: "review", pages: [{ name: "page", original: "data:image/png;base64,YQ==", repaired: "data:image/png;base64,Yg==" }],
    report: { moved: ["face"], added: ["new"], dropped: ["old"], warnings: [{ key: "rig", name: "test.skel" }], partial: true },
    compare: { assets: [{ type: "Texture2D", name: "page", status: "changed" }] } };
  let saved = 0, discarded = 0, refreshed = 0;
  handlers.set("actions.remap", () => ({ result: "remap-job" }));
  handlers.set("actions.acceptRemap", () => { saved++; return { result: "accept-job" }; });
  handlers.set("actions.discardRemap", () => { discarded++; return { result: null }; });
  handlers.set("jobs.get", ({ id }) => ({ result: { state: "done", result: id === "remap-job" ? built : { mod: { id: "fixed" } } } }));
  for (const accept of [false, true]) {
    const done = Compatibility.remap("original", () => { refreshed++; }, "Painted");
    const ok = await drawn(dialog, "ok");
    assert.equal(saved, 0);
    const images = walk(dialog).filter((el) => el.tagName === "IMG");
    assert.deepEqual(images.map((el) => el.src), [built.pages[0].original, built.pages[0].repaired]);
    assert.ok(walk(dialog).some((el) => el.textContent === english.remap.partial));
    assert.ok(walk(dialog).some((el) => el.textContent.includes("test.skel")));
    assert.equal(ok.getAttribute("aria-label"), english.remap.accept);
    assert.equal(action(dialog, "cancel").getAttribute("aria-label"), english.remap.discard);
    (accept ? ok : action(dialog, "cancel")).click();
    await done;
    assert.equal(saved, Number(accept));
    assert.equal(refreshed, Number(accept));
  }
  assert.equal(discarded, 2);
});

test("repaired names carry their localized tag and originals jump to their repaired card", async () => {
  setStrings("en-US", Object.fromEntries(strings(english)));
  await modsEnabled(false);
  const fam = previewFamily(), mods = fam.variants[0].modList;
  mods[0].repaired_id = "fixed";
  mods.push({ ...mods[0], id: "fixed", repaired_from: mods[0].id, repaired_id: "" });
  Detail.setupPreviewTest(fam, "spr");
  await Detail.renderPopup();
  assert.ok(walk(switchHost).some((el) => el.textContent.includes(english.remap.repaired)));
  const jump = walk(switchHost).find((el) => el.getAttribute("aria-label") === english.remap.go);
  assert.ok(jump);
  assert.ok(!walk(switchHost).some((el) => el.getAttribute("aria-label") === english.remap.action));
  await jump.click();
  assert.equal(Detail.previewTestState().pending, "m:fixed");
  assert.ok(walk(switchHost).some((el) => el.textContent.includes(english.remap.repaired)));
  switchHost.hidden = true;
});

test("repair comparison uses separate in-memory players and disposes both on close", async () => {
  const Compare = await import("../../src/ba_modding_toolkit/web/js/mod-compare.js");
  const previous = globalThis.spine, created = [];
  globalThis.spine = {
    Downloader: class { rawDataUris = {}; },
    TextureAtlas: class { pages = [{ name: "page.png" }]; },
    SpinePlayer: class {
      constructor(host, config) {
        this.host = host; this.config = config; this.disposed = false;
        this.skeleton = { data: { animations: [{ name: "Idle_01" }] } };
        this.animationState = { setAnimation() {} };
        created.push(this);
        queueMicrotask(() => config.success(this));
      }
      dispose() { this.disposed = true; }
    },
  };
  const original = { name: "test.skel", json: true, skeleton: Buffer.from('\ufeff{"bones":[{"name":"root"}]}').toString("base64"), atlas: "original page data" };
  const repaired = { ...original, atlas: "repaired page data" };
  try {
    const pending = Compare.show({ pages: [{ name: "page", original: "original pixels", repaired: "repaired pixels" }],
      drawings: { original: [original], repaired: [repaired] } }, "Painted", "dialog",
    { lines: [], accept: english.remap.accept, discard: english.remap.discard });
    await drawn(dialog, "cancel");
    assert.equal(created.length, 2);
    assert.notEqual(created[0].host.parentNode, created[1].host.parentNode);
    for (const [i, player] of created.entries()) {
      let text, json;
      player.config.downloader.downloadText("skeleton.atlas", (value) => { text = value; });
      player.config.downloader.downloadJson("skeleton.json", (value) => { json = value; }, assert.fail);
      assert.equal(text, i ? repaired.atlas : original.atlas);
      assert.equal(json.bones[0].name, "root");
      assert.equal(player.config.rawDataURIs["page.png"], i ? "repaired pixels" : "original pixels");
    }
    press("Escape");
    assert.equal(await pending, false);
    assert.ok(created.every((player) => player.disposed));
  } finally { globalThis.spine = previous; }
});

test("the single Update action checks fresh inputs and routes a mixed page mismatch to review", async () => {
  setStrings("en-US", Object.fromEntries(strings(english)));
  await modsEnabled(false);
  const previous = globalThis.spine;
  globalThis.spine = { TextureAtlas: class {
    pages = [{ name: "page.png", width: 64, height: 64 }];
    regions = [];
  } };
  try {
    const fam = previewFamily();
    Detail.setupPreviewTest(fam, "spr");
    await Detail.renderPopup();
    assert.equal(walk(switchHost).filter((el) => el.getAttribute("aria-label") === english.act.update).length, 1);
    const inputs = { skeletons: {}, atlases: { "test.atlas": "page.png\nsize: 64,64\n" }, textures: { page: [64, 32] } };
    const built = { preview: "unified-review", pages: [], compare: { assets: [] },
      report: { moved: ["part"], added: [], dropped: [], warnings: [], partial: false } };
    const methods = [];
    handlers.set("actions.compatibilityStamp", () => ({ result: "mixed-review" }));
    handlers.set("actions.compatibility", () => { methods.push("check"); return { result: "unified-check" }; });
    handlers.set("actions.update", () => assert.fail("remap must not run the classic port"));
    handlers.set("actions.remap", () => { methods.push("remap"); return { result: "unified-remap" }; });
    handlers.set("actions.acceptRemap", () => assert.fail("Discard must not store a result"));
    handlers.set("actions.discardRemap", () => { methods.push("discard"); return { result: null }; });
    handlers.set("jobs.get", ({ id }) => ({ result: { state: "done", result: id === "unified-check"
      ? { official: inputs, mod: inputs, remappable: true } : built } }));
    const updating = Detail.runUpdate();
    await drawn(dialog, "ok");
    action(dialog, "cancel").click();
    await updating;
    assert.deepEqual(methods, ["check", "remap", "discard"]);
    switchHost.hidden = true;
  } finally { globalThis.spine = previous; }
});

test("errors use an answerable game popup, plain notices stay silent and the toast UI is absent", async () => {
  setStrings("en-US", Object.fromEntries(strings(english)));
  Popup.notify("Plain success"); assert.equal(dialog.hidden, true);
  for (const kind of ["error"]) {
    assert.equal(Popup.notify(`Review ${kind}`, { kind }), undefined, "notification delivery does not change caller return values");
    const layer = dialog.children.at(-1);
    const ok = await drawn(layer, "ok");
    assert.ok(walk(layer).some((el) => el.textContent === `Review ${kind}`));
    assert.ok(walk(layer).some((el) => el.dataset.path === "Center/Popup/Base/BG"), "uses the existing game popup frame");
    ok.click(); assert.equal(dialog.hidden, true);
  }
  const root = new URL("../../src/ba_modding_toolkit/web/", import.meta.url);
  assert.doesNotMatch(readFileSync(new URL("index.html", root), "utf8"), /id="toast"|class="toast"/);
  assert.doesNotMatch(readFileSync(new URL("css/app.css", root), "utf8"), /\.toast\b/);
  assert.doesNotMatch(readFileSync(new URL("js/util.js", root), "utf8"), /export function toast\b/);
});


test("clean Update asks Cancel / Update and reuses the checked report; problems update without that question", async () => {
  setStrings("en-US", Object.fromEntries(strings(english))); await modsEnabled(false);
  const inputs = { skeletons: {}, atlases: {}, textures: {} }, fam = previewFamily();
  let stamp = "force-current", checks = 0, updates = 0, problems = false;
  handlers.set("actions.compatibilityStamp", () => ({ result: stamp }));
  handlers.set("actions.compatibility", () => { checks++; return { result: "force-check" }; });
  handlers.set("actions.update", () => { updates++; return { result: "force-update" }; });
  handlers.set("family.get", () => ({ result: structuredClone(fam) }));
  handlers.set("jobs.get", ({ id }) => ({ result: { state: "done", result: id === "force-check"
    ? { official: problems ? { ...inputs, skeletons: { "required.skel": {} } } : inputs, mod: inputs } : {} } }));
  Detail.setupPreviewTest(fam, "spr");
  let work = Detail.runCompatibility(); (await drawn(dialog, "ok")).click(); await work;
  assert.equal(checks, 1); assert.equal(updates, 0);
  work = Detail.runUpdate(); await drawn(dialog, "cancel");
  assert.ok(walk(dialog).some((el) => el.textContent.replaceAll("\n", " ") === english.compatibility.forceUpdate));
  assert.equal(action(dialog, "ok").getAttribute("aria-label"), english.act.update);
  action(dialog, "cancel").click(); assert.equal(await work, false); assert.equal(updates, 0); assert.equal(checks, 1);
  work = Detail.runUpdate(); (await drawn(dialog, "ok")).click(); assert.equal(await work, true);
  assert.equal(updates, 1); assert.equal(checks, 1);
  assert.equal(dialog.hidden, true, "successful updates finish without a confirmation popup");
  problems = true; stamp = "new-game-inputs";
  work = Detail.runUpdate(); assert.equal(await work, true);
  assert.equal(checks, 2); assert.equal(updates, 2);
  assert.ok(!walk(dialog).some((el) => el.textContent.replaceAll("\n", " ") === english.compatibility.forceUpdate));
  const exact = JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/zh-CN.json", import.meta.url))).webui.compatibility.forceUpdate;
  assert.equal(exact, "\u76ee\u524d\u5b8c\u6574\u6027\u65e0\u95ee\u9898\uff0c\u662f\u5426\u786e\u5b9a\u4ecd\u8981\u5f3a\u5236\u66f4\u65b0\uff1f");
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`unavailable compatibility asks before updating in ${locale}`, async () => {
  const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url))).webui;
  setStrings(locale, Object.fromEntries(strings(ui))); await modsEnabled(false);
  const inputs = { skeletons: {}, atlases: {}, textures: {} }, fam = previewFamily();
  let updates = 0;
  handlers.set("actions.compatibilityStamp", () => ({ result: `unchecked-${locale}` }));
  handlers.set("actions.compatibility", () => ({ result: "unchecked-check" }));
  handlers.set("actions.update", () => { updates++; return { result: "unchecked-update" }; });
  handlers.set("family.get", () => ({ result: structuredClone(fam) }));
  handlers.set("jobs.get", ({ id }) => ({ result: { state: "done", result: id === "unchecked-check"
    ? { official: inputs, mod: inputs, unavailable: true } : {} } }));
  Detail.setupPreviewTest(fam, "spr");
  try {
    let work = Detail.runUpdate(); await drawn(dialog, "cancel");
    assert.ok(walk(dialog).some((el) => el.textContent.replaceAll("\n", " ") === ui.compatibility.updateUnchecked));
    assert.ok(walk(dialog).some((el) => el.dataset.path === "Center/Popup/Base/BG"));
    assert.equal(action(dialog, "ok").getAttribute("aria-label"), ui.act.update);
    assert.equal(action(dialog, "cancel").getAttribute("aria-label"), ui.popup.cancel);
    action(dialog, "cancel").click(); assert.equal(await work, false); assert.equal(updates, 0);
    work = Detail.runUpdate(); (await drawn(dialog, "ok")).click(); assert.equal(await work, true);
    assert.equal(updates, 1);
  } finally { setStrings("en-US", Object.fromEntries(strings(english))); }
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`copy-name failures use an error popup while success stays silent in ${locale}`, async () => {
  const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url))).webui;
  const previous = navigator.clipboard, copied = [];
  setStrings(locale, Object.fromEntries(strings(ui)));
  Detail.setupPreviewTest(previewFamily(), "spr");
  try {
    navigator.clipboard = { writeText: async (name) => { copied.push(name); } };
    await Detail.copyName();
    assert.equal(copied.length, 1); assert.ok(copied[0]);
    assert.equal(dialog.hidden, true, "successful copying stays silent");
    for (const clipboard of [undefined, { writeText: async () => { throw new Error("Clipboard rejected"); } }]) {
      navigator.clipboard = clipboard;
      await Detail.copyName();
      const layer = dialog.children.at(-1), ok = await drawn(layer, "ok");
      assert.ok(walk(layer).some((el) => el.textContent.replaceAll("\n", " ") === ui.detail.copyFailed));
      assert.ok(walk(layer).some((el) => el.dataset.path === "Center/Popup/Base/BG"));
      ok.click(); assert.equal(dialog.hidden, true);
    }
  } finally { navigator.clipboard = previous; setStrings("en-US", Object.fromEntries(strings(english))); }
});

test("failed-job notifications offer Error Report on the game frame", async () => {
  setStrings("en-US", Object.fromEntries(strings(english)));
  let reports = 0;
  globalThis.BAMTRecovery = { report: () => { reports++; } };
  try {
    Popup.notify("Failed job", { kind: "error" });
    const layer = dialog.children.at(-1);
    const report = await drawn(layer, "cancel");
    assert.ok(walk(layer).some((el) => el.textContent === "Error Report"));
    report.click();
    assert.equal(reports, 1);
    assert.equal(dialog.hidden, true);
    const refused = Popup.message({ title: "Refusal", lines: ["Busy"], error: true, ok: "OK", cancel: "Existing Action" });
    const next = dialog.children.at(-1);
    await drawn(next, "line1");
    action(next, "line1").click();
    assert.equal(reports, 2);
    assert.ok(action(next, "cancel"), "the original refusal action remains available");
    action(next, "ok").click();
    await refused;
  } finally { delete globalThis.BAMTRecovery; }
});


test("error popup report actions retain the triggering code and parameters", async () => {
  const events = [], error = { code: "library_io_error", params: { file: "Private Mod Name.bundle", operation: "read" } };
  globalThis.BAMTRecovery = { report: (event) => events.push(event) };
  try {
    Popup.notify("Cannot read", { kind: "error", error });
    const layer = dialog.children.at(-1);
    (await drawn(layer, "cancel")).click();
    assert.equal(events[0].code, error.code);
    assert.deepEqual(events[0].params, error.params);
    const pending = Popup.message({ title: "Failed", error, ok: "OK", cancel: "Retry" });
    const next = dialog.children.at(-1);
    (await drawn(next, "line0")).click();
    assert.equal(events[1].code, error.code);
    action(next, "ok").click();
    await pending;
  } finally { delete globalThis.BAMTRecovery; }
});

// Exercise the actual rendered popup at all supported text lengths and kinds, without localhost.
test("switch geometry: per-kind columns, aspects, card bounds, labels and portrait split", async () => {
  const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  const box = (path) => NGUI.rect(walk(prompt).find((el) => el.dataset.path === path));
  const inside = (a, b, message) => {
    assert.ok(a[0] >= b[0] - 1 && a[1] >= b[1] - 1 && a[0] + a[2] <= b[0] + b[2] + 1 && a[1] + a[3] <= b[1] + b[3] + 1, message);
  };
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
      setStrings(lang, Object.fromEntries(strings(ui)));
      for (const [kind, columns] of [["spr", 4], ["lobby", 2], ["model", 4]]) {
        const items = Array.from({ length: 9 }, (_, i) => ({ key: String(i), kind: "mod", full: "ch0200_spr", label: "ch0200_spr",
          nameEdit: { label: ui.modAlias.title, fn() {} }, inUseText: ui.switch.configured,
          badge: { text: ui.switch.configured, color: "#8de4ff" } }));
        const fields = [[ui.field.file, `assets-_mx-spinecharacters-${"long_bundle_name_".repeat(5)}.bundle`],
          [ui.field.size, "2.5 MB"], [ui.field.status, `${ui.switch.configured}\n${ui.error.game_file_locked.replace("{file}", "/very/long/path".repeat(20))}`], [ui.field.crc, "—"]];
        await Popup.listPopup({ host: prompt, title: kind, layoutKind: kind, items, selected: "0", okText: ui.popup.apply,
          details: () => ({ title: ui.info.title.portrait, fields, actions: [[ui.open.mac], [ui.btn.extract]] }) });
        const cards = items.map((it) => box(`Card_${it.key}`));
        const ratio = cards[0][2] / cards[0][3];
        if (kind === "spr") {
          const still = box("Details/Picture/Texture");
          assert.ok(Math.abs(1 / ratio - 2.2) < .01, "portrait height follows the latest 2.2:1 sketch");
        }
        if (kind === "lobby") assert.ok(Math.abs(ratio - 16 / 9) < .02);
        if (kind === "model") { assert.equal(ratio, 1); assert.ok(cards[0][2] > 220); }
        for (let i = 0; i < cards.length; i++) {
          if (i % columns) assert.ok(cards[i][0] > cards[i - 1][0] + cards[i - 1][2] + 8, `${kind}: column gap`);
          if (i >= columns) assert.ok(cards[i][1] > cards[i - columns][1] + cards[i - columns][3] + 65, `${kind}: row gap includes names`);
          assert.equal(cards[i][1], cards[Math.floor(i / columns) * columns][1]);
          const label = walk(prompt).find((el) => el.dataset.path?.startsWith(`Card_${i}/Bar/Name/`) && el.textContent);
          const band = box(`Card_${i}/Bar`);
          inside(NGUI.rect(label), band, `${lang}: name in card bar`);
          inside(box(`Card_${i}/Bar/EditName`), band, `${lang}: edit pencil in card bar`);
          assert.ok(band[1] > cards[i][1] + cards[i][3], "the name band is below the artwork");
          const el = (suffix = "") => walk(prompt).find((e) => e.dataset.path === `Card_${i}${suffix}`);
          assert.ok(el().style.backgroundImage, "shared card body sprite renders");
          for (const suffix of ["", "/Thumb", "/Line", "/Bar", "/Using"]) {
            assert.equal(el(suffix).style.transform, "skewX(-10deg)", `${kind}: shared incline for ${suffix}`);
          }
          assert.equal(el("/Thumb").style.borderRadius, `${(18 * S).toFixed(1)}px`);
          const image = el("/Thumb").children[0], window = box(`Card_${i}/Thumb`);
          assert.equal(image.style.transform, "skewX(10deg)", "art stays upright inside the shared incline");
          const margin = -parseFloat(image.style.left) / 100 * window[2];
          assert.ok(margin + .01 >= window[3] * Math.tan(Math.PI / 18) / 2, "image covers the tall slanted corners");
          assert.ok(!walk(prompt).some((e) => e.dataset.path?.startsWith(`Card_${i}/Sort`)), "no collection Sort overlay across the art");
          if (i === 0) {
            assert.ok(el("/Select").style.backgroundImage, "shared selection outline renders");
            assert.equal(el("/Select").style.transform, "skewX(-10deg)");
            assert.ok(el("/Select/Check").style.backgroundImage, "shared check sprite renders");
          }
        }
        if (kind === "spr") {
          const picture = box("Details/Picture/Texture"), name = box("Details/Name"), buttons = box("Details/Act_0/Body");
          assert.ok(picture[3] > picture[2] * 2);
          assert.ok(picture[0] + picture[2] < name[0]);
          assert.ok(picture[1] + picture[3] < buttons[1]);
          let previous = box("Details/Chip_0");
          for (let i = 0; i < 4; i++) {
            const caption = box(`Details/F_${i}`), value = box(`Details/V_${i}`);
            assert.ok(caption[0] > picture[0] + picture[2]);
            assert.ok(caption[1] >= previous[1] + previous[3]);
            assert.ok(value[1] >= caption[1] + caption[3]);
            assert.ok(value[0] + value[2] <= buttons[0] + 500);
            assert.ok(value[1] + value[3] < buttons[1], `${lang}: fields above actions`);
            previous = value;
          }
          assert.ok(walk(prompt).find((el) => el.dataset.path === "Details/V_0").textContent.includes("\n"));
        }
        prompt.hidden = true;
      }
    }
  } finally { prompt.hidden = true; setStrings("en-US", Object.fromEntries(strings(english))); }
});


test("portrait columns fit available space with four tall cards at the standard width", async () => {
  const { switchGrid } = await import("../../src/ba_modding_toolkit/web/js/switch-layout.js");
  for (const width of [1300, 1818, 2200]) {
    const { card, columns, pitch, overhang } = switchGrid("spr", width);
    assert.equal(card.h / card.w, 2.2);
    assert.equal(pitch[1] - card.h - card.bar, 48);
    assert.ok(columns <= 4);
    assert.ok((columns - 1) * pitch[0] + card.w + overhang <= width - 80 + .001);
  }
  assert.equal(switchGrid("spr").columns, 4);
});

// Measure rendered CSS rectangles independently of switch-layout's calculations. Include each widget's shear.
test("every kind centres one, two and full rows by their outer corners with the same header inset", async () => {
  const { rect } = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  const { switchGrid } = await import("../../src/ba_modding_toolkit/web/js/switch-layout.js");
  const outer = (el) => {
    const [x, y, w, h] = rect(el), angle = Number(/skewX\(([-\d.]+)deg\)/.exec(el.style.transform)?.[1] || 0);
    const overhang = Math.abs(Math.tan(angle * Math.PI / 180) * h / 2);
    return { left: x - overhang, right: x + w + overhang, top: y, bottom: y + h };
  };
  const headerInsets = [];
  for (const kind of ["spr", "lobby", "model"]) {
    const { columns } = switchGrid(kind);
    for (const count of new Set([1, 2, columns, columns + 1, 2 * columns])) {
      const items = Array.from({ length: count }, (_, i) => ({ key: String(i), full: "Owner label", label: "Owner label", isNew: true }));
      await Popup.listPopup({ host: prompt, layoutKind: kind, items, selected: "0", title: kind, okText: "Set" });
      const paper = outer(walk(prompt).find((e) => e.dataset.path === "Center/Popup/ListPaper"));
      const area = walk(prompt).find((e) => e.className === "popup-cards");
      const dx = parseFloat(area.style.left), dy = parseFloat(area.style.top);
      for (let start = 0; start < count; start += columns) {
        const names = items.slice(start, start + columns).map((it) => `Card_${it.key}`);
        const ink = walk(prompt).filter((e) => e.style.backgroundImage && names.some((n) => e.dataset.path === n || e.dataset.path?.startsWith(`${n}/`))).map(outer);
        const left = Math.min(...ink.map((b) => b.left)) + dx - paper.left;
        const right = paper.right - Math.max(...ink.map((b) => b.right)) - dx;
        assert.ok(Math.abs(left - right) <= 1, `${kind}, ${count} cards, row ${start}: ${left} vs ${right}`);
        assert.ok(left >= 24 && right >= 24, "inclined name bands stay clear of both paper edges");
        if (!start) headerInsets.push(Math.min(...ink.map((b) => b.top)) + dy - paper.top);
      }
      prompt.hidden = true;
    }
  }
  assert.ok(Math.max(...headerInsets) - Math.min(...headerInsets) < 1, "all kinds share the top inset");
  assert.ok(Math.abs(headerInsets[0] - 40 * S) < 1);
});

test("NGUI preview placeholders remain for pending, missing, rejected and undecodable stills", async () => {
  const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  let finish;
  const pending = Object.assign(new Promise((resolve) => { finish = resolve; }), { thumbnail: true });
  const target = new El();
  const view = await NGUI.render(n("Still", [0, 0], [{ clipImage: pending, placeholder: "Preview unavailable", w_: 320, h_: 704 }]), target);
  const note = () => walk(target).find((e) => e.dataset.path === "Still/Placeholder");
  assert.ok(note().textContent); assert.equal(note().hidden, false);
  finish(null); await Promise.all(view.thumbnails);
  assert.equal(note().hidden, false);
  for (const source of [null, Promise.reject(new Error("capture failed")), "missing:still", "blob:ready"]) {
    target.replaceChildren();
    const Original = Image;
    globalThis.Image = class { set src(url) { queueMicrotask(() => url === "missing:still" ? this.onerror?.() : this.onload?.()); } };
    try {
      const v = await NGUI.render(n("Still", [0, 0], [{ clipImage: source, placeholder: "Preview unavailable", w_: 320, h_: 704 }]), target);
      await Promise.all(v.pictures);
      if (source === "blob:ready") assert.equal(note(), undefined, "successful decoding removes the label from the DOM");
      else {
        assert.equal(note().hidden, false);
        assert.equal(note().style.color, "#2d4664", "UIPopup_Sort cancel label colour is retained");
      }
    } finally { globalThis.Image = Original; }
  }
});

for (const kind of ["spr", "model"]) test(`${kind} card and info panel remove placeholders after their shared still succeeds`, async () => {
  let finish;
  const picture = Object.assign(new Promise((resolve) => { finish = resolve; }), { thumbnail: true });
  const items = ["Original", "Dress", "hina_spr"].map((label) => ({ key: label, label, full: label, thumb: picture, big: () => picture }));
  await Popup.listPopup({ host: prompt, title: kind, layoutKind: kind, items, selected: "Original",
    details: () => ({ title: kind, fields: [], actions: [] }) });
  const paths = [...items.map((it) => `Card_${it.key}/Thumb`), kind === "spr" ? "Details/Picture/Texture" : "Details/Picture/Thumb"];
  const element = (path) => walk(prompt).find((el) => el.dataset.path === path);
  const geometry = paths.map((path) => { const s = element(path).style; return [s.left, s.top, s.width, s.height]; });
  for (const path of paths) assert.ok(element(`${path}/Placeholder`));
  finish(`blob:${kind}-success`);
  await until(() => paths.every((path) => element(path).children[0].style.backgroundImage), "all stills decoded");
  paths.forEach((path, i) => {
    assert.equal(element(`${path}/Placeholder`), undefined, path);
    const s = element(path).style;
    assert.deepEqual([s.left, s.top, s.width, s.height], geometry[i], "image publication preserves prefab geometry");
  });
  prompt.hidden = true;
});
