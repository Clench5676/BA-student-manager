// Tests for web/js/mod-switch.js (the Enable Mods switch: its view from mods.state, a click, the first toggle's
// explanation, the "?" help, the result, the classic modal, the start prompts), with the en-US strings, on a small
// stand-in DOM. Run by tests/test_mod_switch.py with Node's test runner: node --test tests/js/mod_switch.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { controls, insert } from "./control_prefabs.mjs";

// --- a stand-in DOM: elements in a tree, ids, clicks, the focus and the window's key listeners ---
class El {
  constructor(tag = "div") {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentNode: null, style: {}, dataset: {}, attrs: {}, listeners: {}, captureListeners: {} });
    Object.assign(this, { hidden: false, className: "", textContent: "", id: "", font: "", tabIndex: 0, title: "", scrollWidth: 0 });
    const self = this;
    this.classList = {
      set: new Set(),
      add(...c) { c.forEach((x) => this.set.add(x)); },
      remove(...c) { c.forEach((x) => this.set.delete(x)); },
      toggle(c, on = !this.set.has(c)) { if (on) this.set.add(c); else this.set.delete(c); return on; },
      contains(c) { return this.set.has(c) || self.className.split(" ").includes(c); },
    };
  }
  get childNodes() { return [...this.children]; }
  get parentElement() { return this.parentNode; }
  appendChild(child) { child.remove?.(); child.parentNode = this; this.children.push(child); return child; }
  append(...kids) { for (const k of kids) this.appendChild(k); }
  replaceChildren(...kids) { for (const c of [...this.children]) c.remove(); for (const k of kids) this.appendChild(k); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  set innerHTML(text) {
    for (const c of [...this.children]) c.remove();
    this.parts = {};
    for (const key of text.includes("loading-back") ? [".loading-back", ".loading-ind"] : /loading-(fallback|plain)/.test(text) ? ["span"] : []) {
      this.parts[key] = this.appendChild(new El());
    }
  }
  get firstChild() { return this.children[0]; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get isConnected() { return document.body.contains(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "title") this.title = ""; }
  closest(selector) {
    for (let n = this; n; n = n.parentNode) {
      if (selector === ".topbar .back" && n.classList.contains("back") && n.parentNode?.classList.contains("topbar")) return n;
      if (selector.includes(":not([hidden])") && !n.hidden && ["popup-host", "consent-host"].some((c) => n.classList.contains(c))) return n;
    }
    return null;
  }
  addEventListener(type, fn, capture = false) { ((capture ? this.captureListeners : this.listeners)[type] ||= []).push(fn); }
  dispatch(type, extra = {}) {
    const ev = { type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    const path = []; for (let n = this; n; n = n.parentNode) path.push(n);
    for (const node of [...path].reverse()) for (const fn of node.captureListeners[type] || []) { fn(ev); if (ev.stopped) return ev; }
    for (const node of path) for (const fn of node.listeners[type] || []) { fn(ev); if (ev.stopped) return ev; }
    if (type === "keydown") for (const fn of keyListeners) fn(ev);
    return ev;
  }
  click() { return this.dispatch("click"); }
  focus() { document.activeElement = this; }
  querySelector(key) { return this.parts?.[key] || (key.startsWith(".") ? walk(this).find((e) => e.classList.contains(key.slice(1))) : null); }
  getContext() { return { font: "", drawImage() {}, fillRect() {}, scale() {}, transform() {}, putImageData() {},
    getImageData(_x, _y, width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) }; },
    measureText(s) { return { width: s.length * 0.6 * parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || 10) }; } }; }
  toBlob(fn) { fn(new Blob()); }
  toDataURL() { return "data:image/png;base64,c3ludGhldGljLW1hc2s="; }
}
globalThis.Image = class {
  naturalWidth = 8; naturalHeight = 8;
  set src(value) { queueMicrotask(() => this.onload?.()); }
  decode() { return Promise.resolve(); }
};
const body = new El("body");
const walk = (n, out = []) => { out.push(n); for (const c of n.children) walk(c, out); return out; };
globalThis.document = {
  body, activeElement: body, documentElement: { lang: "en-US", appendChild() {} },
  createElement: (tag) => new El(tag),
  getElementById: (id) => walk(body).find((n) => n.id === id) || null,
  querySelector: () => null,
  addEventListener() {},
};
const keyListeners = [];
globalThis.addEventListener = (type, fn) => { if (type === "keydown") keyListeners.push(fn); };
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
function press(key, target = document.activeElement) { return target.dispatch("keydown", { key }); }
const stage = body.appendChild(new El()); stage.id = "stage";
const host = (id) => { const h = stage.appendChild(new El()); h.id = id; h.hidden = true; return h; };
const dialog = host("dialog"), consent = host("consent"), prompt = host("prompt"), settingsHost = host("settings");
dialog.className = prompt.className = "popup-host"; consent.className = "consent-host";
const switchHost = host("mod-switch");

// --- the server: the popup frame's prefab, the RPC calls (recorded with their params) and the jobs ---
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
  ]),
])]);
const OPTIONS = structuredClone(SORT);
OPTIONS.name = "UIPopup_Option_PC";
OPTIONS.children[0].children.find((e) => e.name === "Popup").children.push(
  n("TabBg", [0, 0], [], [n("Grid", [0, 0])]),
  n("Game", [0, 0], [], ["Tab_On", "Tab_Off"].map((name) => n(name, [0, 0], [], [n("Label_Locale", [0, 0], [lbl()])]))),
  n("List", [0, 0], [], [n("Sound_Setting", [0, 0], [], [n("Sound_Scroll View", [0, 0], [], [
    n("Grid_2", [0, 0], [], [n("Master", [0, 0], [], [n("Type_3", [0, 0])])]),
  ])])]),
);
const controlLayouts = controls();
insert(OPTIONS, "Center/Popup/List/Sound_Setting/ETCSetting/ButtonBg", controlLayouts.option.children[0].children[0].children[0].children[0].children[0].children[0]);
const calls = [];
const answers = { "mods.sizes": ({ kind }) => ({ [`${kind}Size`]: 0 }) }; // method -> result (or a function of params)
const jobs = {}; // id -> {state, result, error}
const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
  if (url === "/api/rpc") {
    const { method, params } = JSON.parse(opts.body);
    calls.push([method, params]);
    if (method === "jobs.get") return reply({ result: jobs[params.id] || { state: "running" } });
    const a = answers[method];
    const result = typeof a === "function" ? await a(params) : a ?? null;
    if (result && result.error) return reply({ error: result.error });
    return reply({ result });
  }
  if (url === "/asset/ui/atlases.json") return reply({ Common: Object.fromEntries([
    "Common_Square_Bg", "Common_Popup_Bg", "Common_Icon_Close", "Common_Btn_BG", "Common_Line_Dot",
    "Common_Btn_Normal_B_C_Pt", "Common_Filter_Tab_Type1", "Common_Filter_Tab_Type1_Pressed", "Common_Btn_Normal_Y_S_Pt",
  ].map((name) => [name, { width: 8, height: 8 }])) });
  if (url === "/asset/ui/textures.json") return reply({});
  if (url === "/asset/ui/layout/UIPopup_Sort.json") return reply(SORT);
  if (url === "/asset/ui/layout/UIPopup_FilterSort.json") return reply(controlLayouts.filter);
  if (url === "/asset/ui/layout/UIPopup_Option_PC.json") return reply(OPTIONS);
  return reply(null, false);
};
// the event stream: the page subscribes; emit() sends an event as the server would
const streams = [];
globalThis.EventSource = class { constructor() { this.listeners = {}; streams.push(this); } addEventListener(type, fn) { this.listeners[type] = fn; } };
const emit = (type, data) => { for (const stream of streams) stream.listeners[type]?.({ data: JSON.stringify(data) }); };
const warn = console.warn;
console.warn = (...args) => { if (!/^(popup layout|thumbnail failed)/.test(String(args[0]))) warn(...args); };

// the en-US strings, as i18n.strings gives them (webui.* keys)
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") flat(v, `${p}${k}.`, out); else out[`${p}${k}`] = v; } return out; };
const strings = Object.fromEntries(Object.entries(flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))))
  .filter(([k]) => k.startsWith("webui.")));
const I18n = await import("../../src/ba_modding_toolkit/web/js/i18n.js");
I18n.setStrings("en-US", strings);
const S = (key) => strings[`webui.${key}`];

const MS = await import("../../src/ba_modding_toolkit/web/js/mod-switch.js");
const Loading = await import("../../src/ba_modding_toolkit/web/js/loading.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const actionsIn = (root) => walk(root).filter((e) => e.dataset?.action);
const action = (root, name) => actionsIn(root).find((e) => e.dataset.action === name);
async function drawn(root, name) {
  for (let i = 0; i < 300; i++) { const b = action(root, name); if (b) return b; await tick(); }
  throw new Error(`no ${name} button`);
}
async function until(fn, what) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await tick(); }
  throw new Error(`never: ${what}`);
}
const noticeDelay = globalThis.setTimeout;
async function expectNotice(text) {
  for (let i = 0; i < 2000; i++) {
    const layer = dialog.children.at(-1), ok = layer && action(layer, "ok");
    if (ok && walk(layer).some((el) => el.textContent.replaceAll("\n", " ") === text)) { ok.click(); return; }
    await new Promise((resolve) => noticeDelay(resolve, 1));
  }
  throw new Error(`message not shown: ${text}`);
}
afterEach(async () => {
  await tick();
  for (const layer of [...dialog.children].reverse()) action(layer, "close")?.click();
});
const called = (method) => calls.filter(([m]) => m === method).map(([, p]) => p);
const labels = (root) => walk(root).map((e) => e.attrs?.["aria-label"]).filter(Boolean);
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// a mods.state as the services answer it
const install = (key, label, extra = {}) => ({ id: key.slice(-4), key, server: "global", folder: key, label, named: true, ...extra });
const base = (over = {}) => ({
  installs: [install("/games/BlueArchive", "Global")], current: "/games/BlueArchive", enabled: true,
  available: true, reason: null, reasonParams: {}, scan: true, explained: true, configured: 2, pending: 0, stuck: 0,
  left: 0, unfinished: { pending: 0, left: 0, stuck: 0 }, drift: 0, untracked: 0, damaged: 0, sourceMissing: 0,
  queued: 0, scanned: null, tray: false, traySupported: false, busy: false, progress: null,
  ...over,
});

test("the switch's view from mods.state: on, off, busy, unavailable with its reason, the red dot, hidden", () => {
  assert.equal(MS.view(base()).on, true);
  assert.equal(MS.view(base({ enabled: false })).on, false);
  // busy: a toggle queued or running, or writes waiting for the classic window; busy wins over unavailable
  assert.equal(MS.view(base({ busy: true })).busy, true);
  assert.deepEqual([MS.view(base({ busy: true, queued: 2, available: false, reason: "classic_open" }))].map((v) => [v.busy, v.unavailable]), [[true, false]]);
  for (const reason of ["game_running", "game_status_unavailable", "steam_busy", "classic_open", "game_not_found", "profiles_unreadable"]) {
    const v = MS.view(base({ available: false, reason }));
    assert.equal(v.unavailable, true, reason);
    assert.equal(v.reason, reason);
    assert.notEqual(MS.reasonText(base({ available: false, reason, reasonParams: { file: "profiles.json" } })), `error.${reason}`);
  }
  assert.equal(MS.reasonText(base({ available: false, reason: "game_running" })), S("error.game_running"));
  assert.equal(MS.reasonText(base({ available: false, reason: "profiles_unreadable", reasonParams: { file: "p.json" } })), "Unreadable mod settings: p.json");
  // the red dot: entries not switched or left as is, as the services count them (the last scan with the scan consent,
  // the unfinished list's counts by why without it)
  assert.equal(MS.view(base()).dot, false);
  for (const k of ["pending", "stuck", "left"]) assert.equal(MS.view(base({ [k]: 1 })).dot, true, k);
  assert.equal(MS.view(base({ scan: false, pending: 0, left: 1, unfinished: { pending: 0, left: 1, stuck: 0 } })).dot, true);
  // Legacy visibility values cannot hide the switch; only the absence of a current install does.
  assert.equal(MS.view(base({ shown: false })).hidden, false);
  assert.equal(MS.view(base({ current: null })).hidden, true);
  assert.equal(MS.view(base({ shown: false }), { place: "settings" }).hidden, false, "Settings keeps the switch");
  assert.equal(MS.view(null).hidden, true);
});

test("a click: the reason, busy, the classic modal, the first toggle's explanation, else the toggle at once", () => {
  assert.equal(MS.clickAction(base()), "toggle");
  assert.equal(MS.clickAction(base({ explained: false })), "explain");
  assert.equal(MS.clickAction(base({ explained: false }), true), "toggle", "explained in this page already");
  assert.equal(MS.clickAction(base({ busy: true })), "busy");
  assert.equal(MS.clickAction(base({ busy: true, queued: 1 })), "queued");
  assert.equal(MS.clickAction(base({ available: false, reason: "game_running" })), "reason");
  assert.equal(MS.clickAction(base({ available: false, reason: "steam_busy", explained: false })), "reason");
  assert.equal(MS.clickAction(base({ available: false, reason: "classic_open" })), "classic");
  assert.equal(MS.clickAction(base({ available: false, reason: "classic_open", explained: false })), "explain");
  assert.deepEqual(MS.toggleParams(base()), { enabled: false, expect: true });
  assert.deepEqual(MS.toggleParams(base({ enabled: false })), { enabled: true, expect: false });
  assert.deepEqual(MS.retryParams(base()), { enabled: true, expect: true });
  assert.deepEqual(MS.retryParams(base({ enabled: false })), { enabled: false, expect: false });
});

test("the first toggle's explanation: the help's opening text, not shown again", () => {
  const off = MS.explanation(base());
  assert.equal(off.title, S("mods.offTitle"));
  assert.equal(off.ok, S("mods.offTitle"));
  assert.deepEqual(off.lines, [S("mods.helpOn"), S("mods.helpOff"), S("mods.explainOnce")]);
  assert.equal(MS.explanation(base({ enabled: false })).ok, S("mods.onTitle"));
});

test("every locale gives the help and first toggle two separate opening lines", () => {
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
      I18n.setStrings(lang, flat({ webui: ui }));
      const opening = [ui.mods.helpOn, ui.mods.helpOff];
      assert.ok(opening.every((s) => typeof s === "string" && s.length > 0 && !s.includes("\n")), lang);
      assert.ok(!("help" in ui.mods), lang);
      assert.deepEqual(MS.basics(), opening, lang);
      assert.deepEqual(MS.helpLines(base()).slice(0, 2), opening.map((text) => ({ text })), lang);
      for (const enabled of [true, false]) assert.deepEqual(MS.explanation(base({ enabled })).lines,
        [...opening, ui.mods.explainOnce], lang);
    }
  } finally { I18n.setStrings("en-US", strings); }
});

test("the help's lines: game folders, Retry and Details, independent of scan consent", () => {
  const texts = (s, sizes) => MS.helpLines(s, sizes).map((l) => l.text);
  const buttons = (s) => MS.helpLines(s).filter((l) => l.button).map((l) => [l.button.id, l.button.label]);
  assert.deepEqual(texts(base()), [S("mods.helpOn"), S("mods.helpOff")]);
  assert.ok(!texts(base()).some((t) => t.startsWith("Game folders")));
  assert.ok(!texts(base()).some((t) => t.startsWith("Disk use:")));
  assert.ok(!texts(base(), { originalsSize: 3 * 1048576 }).some((t) => t.includes("Official copies for Off")));
  assert.deepEqual(buttons(base()), []);
  assert.deepEqual(buttons(base({ builtSize: 5 * 1073741824 })), []);
  // two game folders: their install labels, with the language's separator
  const two = base({ installs: [install("/a/BlueArchive", "Global (BlueArchive)"), install("/b/Steam", "Global (Steam)")] });
  assert.ok(texts(two).includes("Game folders: Global (BlueArchive), Global (Steam)"));
  assert.equal(texts(two)[2], "Game folders: Global (BlueArchive), Global (Steam)", "after the opening text");
  assert.equal(MS.helpLines(two, { sep: "、" }).find((l) => l.text.startsWith("Game folders")).text, "Game folders: Global (BlueArchive)、Global (Steam)");
  // Retry for the entries not switched (pending and left), Details for those left as is (stuck), never a Retry for them
  const counts = base({ pending: 2, left: 1, stuck: 3, sourceMissing: 1 });
  assert.ok(texts(counts).includes("Not switched: 3"));
  assert.ok(texts(counts).includes("Left as is, no official copy: 3"));
  assert.ok(texts(counts).includes("Gone from the library: 1"));
  assert.deepEqual(buttons(counts), [["retry", S("mods.retry")], ["details", S("mods.details")]]);
  assert.deepEqual(buttons(base({ stuck: 2 })), [["details", S("mods.details")]]);
  // Without scan consent the unfinished list supplies the same counts and actions, with no extra consent row.
  for (const scan of [null, false]) {
    const s = base({ scan, pending: 1, left: 1, stuck: 1, unfinished: { pending: 1, left: 1, stuck: 1 } });
    assert.deepEqual(MS.helpLines(s), MS.helpLines({ ...s, scan: true }), String(scan));
    assert.deepEqual(buttons(s), [["retry", S("mods.retry")], ["details", S("mods.details")]]);
    assert.ok(texts(s).includes("Not switched: 2"));
  }
  for (const l of MS.helpLines(counts)) assert.ok(!/^mods\./.test(l.text), `a string for ${l.text}`);
});

test("a toggle's end: silence, or the result popup naming each failed entry with its error string", () => {
  assert.deepEqual(MS.resultSummary({ enabled: false, done: [{}, {}], adopted: [], failed: [], stuck: [], left: [], skipped: [{}] }), null);
  assert.deepEqual(MS.resultSummary({ enabled: true, done: [] }), null);
  const names = (e) => ({ airi: "Airi", ch0251: "Airi (Band)" })[e.variant] || e.variant;
  const r = MS.resultSummary({
    enabled: false, done: [{}, {}, {}], adopted: [{ variant: "airi" }],
    failed: [{ entry: { install: "/g", core: "airi_spr", variant: "airi", kind: "spr" }, code: "game_file_locked", params: {} },
      { entry: { install: "/g", core: "ch0251_home", variant: "ch0251", kind: "lobby" }, code: "not_enough_space", params: { need: 3 * 1048576, free: 1048576 } }],
    stuck: [{ variant: "ch0251" }], left: [{ install: "/g", core: "zz_spr", variant: "zz", kind: "spr", code: "not_enough_space", params: { need: 2 * 1048576, free: 1048576 } }],
  }, names);
  assert.equal(r.title, S("mods.offState"));
  assert.deepEqual(r.lines, [
    "Added to the library first: 1",
    "Done: 3, failed: 3",
    "Left as is, no official copy: 1",
    `Airi, Portrait - ${S("error.game_file_locked")}`,
    "Airi (Band), Memorial Lobby - Not enough space: 3.0 MB needed, 1.0 MB free",
    "zz, Portrait - Not enough space: 2.0 MB needed, 1.0 MB free",
  ]);
  // many failures: the first ones named, the rest counted
  const many = MS.resultSummary({ enabled: true, failed: Array.from({ length: 9 }, (_, i) => ({ entry: { core: `c${i}_spr`, variant: `c${i}` }, code: "game_file_locked" })) });
  assert.equal(many.lines.at(-1), "+3");
  assert.equal(many.lines[0], "Done: 0, failed: 9");
  assert.equal(many.lines.length, 1 + 6 + 1);
});

test("the classic modal's outcome follows its box however it closes (decision 5)", () => {
  assert.equal(MS.classicOutcome({ queued: false, checked: true }), "queue");
  assert.equal(MS.classicOutcome({ queued: false, checked: false }), null);
  assert.equal(MS.classicOutcome({ queued: true, checked: true }), null, "the queued writes stay");
  assert.equal(MS.classicOutcome({ queued: true, checked: false }), "clear", "unticked: the queue is emptied");
  assert.deepEqual(MS.QUEUEABLE, ["actions.apply", "actions.restore", "mods.toggle", "mods.restoreDrift"]);
});

test("the start prompts: their order, the scan consent, and no prompt from the scan while files may be written", () => {
  assert.deepEqual(MS.START, ["consent", "spine", "scan", "update", "drift", "untracked"]);
  const due = (state, entries = [], info = { consent: true, spineConsent: true, compiled: false }) => MS.START.filter((name) => MS.startDue(name, { info, state, entries }));
  assert.deepEqual(due(base({ scan: null }), [], { consent: null, spineConsent: null, compiled: true }), ["consent", "spine", "scan", "update"]);
  assert.deepEqual(due(base({ scan: false }), [], { consent: true, spineConsent: false }), [], "a Spine refusal is remembered");
  assert.deepEqual(due(base({ scan: null, installs: [] })), [], "no game folder known: no scan consent");
  assert.deepEqual(due(base({ scan: false })), [], "answered: not asked again");
  const reset = { install: "/g", core: "airi_spr", state: "reset" }, untracked = { install: "/g", core: "ch0251_spr", state: "untracked" };
  assert.deepEqual(due(base(), [reset, untracked]), ["drift", "untracked"]);
  assert.deepEqual(due(base(), [{ ...reset, state: "updated" }, { ...untracked, state: "changed" }]), ["drift", "untracked"]);
  for (const reason of MS.PROMPT_BLOCKERS) assert.deepEqual(due(base({ available: false, reason }), [reset, untracked]), [], reason);
  assert.deepEqual(due(base({ available: false, reason: "game_status_unavailable" }), [reset]), ["drift"]);
  assert.deepEqual(due(base({ scan: false }), [reset, untracked]), [], "no drift or untracked prompt without the scan consent");
  assert.deepEqual(due(base(), [{ ...reset, dismissed: true }, { ...untracked, dismissed: true }]), [], "a dismissed set does not prompt");
  assert.deepEqual(due(base({ enabled: false }), [reset, untracked]), ["untracked"], "mods off: official files are the intent");
});

test("the prompts' buttons: Add and Turn On Mods only while off; Apply Mod Configuration and Keep as Is", () => {
  assert.deepEqual(MS.untrackedButtons(base()), ["add", "later"]);
  assert.deepEqual(MS.untrackedButtons(base({ enabled: false })), ["add", "addTurnOn", "later"]);
  const a = { install: "/g", core: "airi_spr" }, b = { install: "/g", core: "ch0251_spr" }, c = { install: "/j", core: "airi_spr" };
  assert.deepEqual(MS.driftChoice("apply", [a, b, c], ["/g|airi_spr", "/j|airi_spr"]), { restore: [a, c], dismiss: [b] });
  assert.deepEqual(MS.driftChoice("keep", [a, b, c], ["/g|airi_spr"]), { restore: [], dismiss: [a, b, c] });
});

test("sizes and the free-space refusal's sizes", () => {
  assert.equal(MS.sizeText(0), "0 MB");
  assert.equal(MS.sizeText(500), "1 KB");
  assert.equal(MS.sizeText(200 * 1024), "200 KB");
  assert.equal(MS.sizeText(1.5 * 1048576), "1.5 MB");
  assert.equal(MS.sizeText(2.25 * 1073741824), "2.25 GB");
  assert.equal(MS.errorText("not_enough_space", { need: 1073741824, free: 0 }), "Not enough space: 1.00 GB needed, 0 MB free");
  assert.equal(MS.listSep("zh-CN"), "、");
  assert.equal(MS.listSep("ja-JP"), "、");
  assert.equal(MS.listSep("ko-KR"), ", ");
  assert.equal(MS.listSep("th-TH"), ", ");
  assert.equal(MS.listSep("en-US"), ", ");
});

// --- the page: the top bar's switch, a click, the explanation once, the help, the classic modal ---

test("the top bar's switch follows mods.state, and the first toggle explains once from any place", async () => {
  answers["mods.state"] = base({ explained: false });
  await MS.init({ names: async () => (e) => e.variant });
  const toggle = switchHost.children.find((e) => e.className === "ms-toggle");
  assert.equal(switchHost.hidden, false);
  assert.equal(toggle.getAttribute("role"), "switch");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.deepEqual(toggle.children.filter((e) => e.className.startsWith("ms-seg")).map((e) => e.className), ["ms-seg ms-on", "ms-seg ms-off"]);
  assert.equal(switchHost.children.find((e) => e.className === "ms-help").getAttribute("aria-label"), S("mods.guide"));
  // the first click (here from Settings): the explanation; closing it any way but its button toggles nothing
  MS.click("settings");
  await drawn(dialog, "cancel");
  const explanation = walk(dialog).filter((e) => /^Center\/Popup\/Lines\/Line_\d+$/.test(e.dataset.path));
  assert.equal(explanation.length, 3);
  assert.ok(explanation.every((e) => e.style.textAlign === "left"));
  assert.ok(!walk(dialog).some((e) => /Lines\/(Box|Dot_)/.test(e.dataset.path)));
  action(dialog, "cancel").click();
  await until(() => called("mods.explained").length === 1, "mods.explained");
  assert.equal(called("mods.toggle").length, 0);
  // the next click (the top bar) toggles at once: the explanation came once
  answers["mods.toggle"] = "job-1";
  jobs["job-1"] = { state: "done", result: { enabled: false, done: [], adopted: [], failed: [], stuck: [], left: [] } };
  toggle.click();
  await until(() => called("mods.toggle").length === 1, "mods.toggle");
  assert.deepEqual(called("mods.toggle")[0], { enabled: false, expect: true });
  assert.equal(called("mods.explained").length, 1, "no explanation the second time");
  await tick(); assert.equal(dialog.hidden, true, "plain confirmations stay silent");
  // greyed with an accessible reason; a click says why and submits nothing
  answers["mods.state"] = base({ available: false, reason: "game_running" });
  await MS.refresh();
  assert.ok(toggle.classList.contains("unavailable"));
  assert.equal(toggle.title, "");
  assert.equal(toggle.getAttribute("aria-description"), S("error.game_running"));
  MS.click("top");
  await expectNotice(S("error.game_running"));
  assert.equal(called("mods.toggle").length, 1);
  // An older state response cannot hide the main switch.
  answers["mods.state"] = base({ shown: false });
  await MS.refresh();
  assert.equal(switchHost.hidden, false);
  assert.equal(toggle.getAttribute("aria-description"), null);
  assert.ok(walk(switchHost).every((e) => !e.title && !e.getAttribute("title")));
});

test("state refresh, the first explanation and help never measure logical originals as extra space", async () => {
  assert.deepEqual(called("mods.sizes"), []);
  answers["mods.state"] = base();
  await MS.refresh();
  for (let i = 0; i < 2; i++) {
    const opened = MS.openHelp();
    await drawn(dialog, "close");
    assert.ok(walk(dialog).some((e) => e.textContent.replaceAll("\n", " ") === S("mods.helpOn")));
    assert.ok(!walk(dialog).some((e) => e.textContent.includes("Official copies for Off")));
    assert.ok(!labels(dialog).includes(S("mods.cache")));
    assert.equal(Loading.active(), false);
    action(dialog, "close").click();
    await opened;
  }
  assert.deepEqual(called("mods.sizes"), []);
});

test("Settings measures built mods only when its Mods row is drawn, and remeasures after cleanup", async () => {
  const Settings = await import("../../src/ba_modding_toolkit/web/js/settings.js");
  answers["settings.get"] = { languages: [{ code: "en-US", name: "English" }], language: "en-US", consent: false,
    cacheDir: "/cache", native: false, version: "1.0", logPath: "/log" };
  const count = called("mods.sizes").length;
  await Settings.open();
  assert.equal(called("mods.sizes").length, count, "General does not measure mods");
  const button = (name) => walk(settingsHost).find((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === name);
  const hasText = (text) => walk(settingsHost).some((e) => e.textContent === text);
  const pending = deferred();
  answers["mods.sizes"] = () => pending.promise;
  button(S("settings.tab.mods")).click();
  await until(() => called("mods.sizes").length === count + 1, "built size request");
  assert.deepEqual(called("mods.sizes").at(-1), { kind: "built" });
  assert.ok(hasText(S("job.running")));
  assert.ok(!hasText(S("loading.now")), "Now Loading belongs to the shared indicator");
  assert.equal(button(S("settings.mods.clear")), undefined, "cleanup disabled while measuring");
  pending.resolve({ builtSize: 2 * 1048576 });
  await until(() => !!button(S("settings.mods.clear")), "cleanup button");
  assert.ok(hasText(S("mods.cache")));
  assert.ok(hasText("2.0 MB"));
  assert.equal(called("mods.sizes").length, count + 1, "drawing the fetched size does not fetch again");
  answers["mods.clearBuilt"] = "clear-built";
  jobs["clear-built"] = { state: "done", result: { freed: 2 * 1048576 } };
  answers["mods.sizes"] = { builtSize: 0 };
  button(S("settings.mods.clear")).click();
  await until(() => hasText("0 MB"), "size after cleanup");
  assert.equal(called("mods.clearBuilt").length, 1);
  assert.equal(called("mods.sizes").length, count + 2);
  assert.equal(button(S("settings.mods.clear")), undefined, "cleanup disabled when empty");
  await tick(); assert.equal(dialog.hidden, true, "plain confirmations stay silent");
  button(S("settings.tab.general")).click();
  await until(() => !!button(S("settings.tab.mods")), "General tab");
  assert.equal(called("mods.sizes").length, count + 2);
  const stale = deferred();
  answers["mods.sizes"] = () => stale.promise;
  button(S("settings.tab.mods")).click();
  await until(() => called("mods.sizes").length === count + 3, "remeasure on reopening Mods");
  button(S("settings.tab.general")).click();
  await until(() => !!button(S("settings.tab.mods")), "General before the reply");
  stale.resolve({ builtSize: 9 * 1048576 });
  await tick(); await tick();
  assert.ok(!hasText(S("mods.cache")), "late reply cannot restore the old tab");
  const error = { code: "internal", params: { error: "size failed" } };
  answers["mods.sizes"] = { error };
  button(S("settings.tab.mods")).click();
  await until(() => hasText(MS.errorText(error.code, error.params)), "size error");
  assert.equal(button(S("settings.mods.clear")), undefined);
  button(S("display.close")).click();
  assert.equal(settingsHost.hidden, true);
  answers["mods.sizes"] = ({ kind }) => ({ [`${kind}Size`]: 0 });
});

test("the help fits its opening lines together in every locale, with and without action rows", async () => {
  const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  const { S: scale } = await import("../../src/ba_modding_toolkit/web/js/util.js");
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
      I18n.setStrings(lang, flat({ webui: ui }));
      for (const scan of [true, false, null]) for (const counts of [{}, { pending: 2, left: 1, stuck: 1 }]) {
        answers["mods.state"] = base({ scan, ...counts });
        await MS.refresh();
        const opened = MS.openHelp();
        await drawn(dialog, "close");
        const texts = [ui.mods.helpOn, ui.mods.helpOff];
        const fs = Math.max(44, Math.min(...texts.map((text) => NGUI.fitText(text, 52, 44, 1860, 4).fs)));
        const lines = texts.map((_, i) => walk(dialog).find((e) => e.dataset.path === `Center/Popup/Lines/Line_${i}`));
        assert.equal(lines[0].style.fontSize, lines[1].style.fontSize, `${lang}, scan=${scan}`);
        assert.ok(!walk(dialog).some((e) => /Lines\/(Box|Row_|Dot_)/.test(e.dataset.path)));
        assert.ok(!("scanOff" in ui.mods) && !("allowCheck" in ui.mods), lang);
        for (let i = 0; i < 2; i++) {
          assert.equal(lines[i].style.textAlign, "left");
          assert.equal(lines[i].style.fontSize, `${(NGUI.fontSizeFor(texts[i], fs) * scale).toFixed(2)}px`);
          assert.equal(lines[i].textContent.replaceAll("\n", " ").replaceAll(" ", ""), texts[i].replaceAll(" ", ""));
        }
        if (counts.pending) for (const [i, caption] of [[2, ui.mods.retry], [3, ui.mods.details]]) {
          const row = walk(dialog).find((e) => e.dataset.path === `Center/Popup/Lines/Line_${i}`);
          const button = walk(dialog).find((e) => e.dataset.path === `Center/Popup/Lines/Btn_${i}`);
          assert.equal(row.style.textAlign, "left");
          assert.ok(labels(dialog).includes(caption));
          assert.ok(parseFloat(button.style.left) > parseFloat(row.style.left) + parseFloat(row.style.width));
          const center = (e) => parseFloat(e.style.top) + parseFloat(e.style.height) / 2;
          assert.ok(Math.abs(center(row) - center(button)) < 1, "button at the line's right end");
        }
        action(dialog, "close").click();
        await opened;
      }
    }
  } finally { I18n.setStrings("en-US", strings); }
});

test("Settings combines scan consent and automatic checks, preserving the consent popup from Off", async () => {
  const Settings = await import("../../src/ba_modding_toolkit/web/js/settings.js");
  const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  let prefs = { ...answers["settings.get"], native: true, traySupported: true, gameDirs: { global: "/game" },
    fileSource: "windows_global", libraryDir: "/library", outputDir: "/output" };
  let state = base({ scan: false });
  answers["settings.get"] = () => prefs;
  answers["settings.set"] = ({ key, value }) => (prefs = { ...prefs, [key]: value });
  answers["mods.state"] = () => state;
  answers["mods.consent"] = ({ granted }) => { state = { ...state, scan: granted }; return {}; };
  await MS.refresh();
  await Settings.open();
  const button = (name) => walk(settingsHost).find((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === name);
  const hasPath = (path) => walk(settingsHost).some((e) => e.dataset.path === path);
  const selected = (i) => hasPath(`Rows/Scan/Opt_${i}/On`);
  const scanButton = (i) => {
    const bg = walk(settingsHost).find((e) => e.dataset.path === `Rows/Scan/Opt_${i}/BG`);
    const [l, t] = NGUI.rect(bg);
    return walk(settingsHost).find((e) => e.tagName === "BUTTON" && e.style.left === `${l}px` && e.style.top === `${t}px`);
  };
  await until(() => selected(1), "Off selected");
  assert.ok(!hasPath("Rows/Scan/Opt_2/BG"), "the file check has exactly two radio options");
  assert.ok(!hasPath("Rows/StartupChecks/Title"));
  assert.ok(!hasPath("Rows/Folders/Title"));
  const rowPaths = walk(settingsHost).map((e) => e.dataset.path).filter((p) => /^Rows\/[^/]+$/.test(p));
  assert.ok(!rowPaths.includes("Rows/Shown"), "visibility is no longer a preference");
  assert.ok(rowPaths.includes("Rows/Tray"), "the tray row is shown on supported systems");
  assert.equal(rowPaths[rowPaths.indexOf("Rows/Scan") + 1], "Rows/Files", "startup checks sit directly above manual Check");
  assert.ok(button(S("settings.mods.check")), "manual Check available without consent");
  const before = called("mods.consent").length;
  scanButton(0).click();
  await drawn(consent, "ok");
  assert.equal(called("mods.consent").length, before, "picking On grants nothing");
  action(consent, "cancel").click();
  await until(() => consent.hidden && selected(1), "declined, still Off");
  scanButton(0).click();
  (await drawn(consent, "ok")).click();
  await until(() => selected(0), "On selected");
  assert.ok(button(S("settings.mods.check")), "manual Check available while On");
  const granted = called("mods.consent").length;
  scanButton(0).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(called("mods.consent").length, granted, "selecting On again changes nothing");
  assert.equal(consent.hidden, true, "consent already granted");
  scanButton(1).click();
  await until(() => selected(1), "Off withdraws consent");
  assert.equal(state.scan, false);
  assert.ok(button(S("settings.mods.check")), "manual Check remains available after withdrawing consent");
  scanButton(0).click();
  (await drawn(consent, "ok")).click();
  await until(() => selected(0), "Off to On also requires consent");
  button(S("settings.tab.general")).click();
  await until(() => hasPath("Rows/ClassicAsk/Title"), "classic confirmation title");
  const title = walk(settingsHost).find((e) => e.dataset.path === "Rows/ClassicAsk/Title");
  assert.equal(title.textContent.replaceAll("\n", " "), S("settings.classic.ask"));
  button(S("settings.tab.folders")).click();
  await until(() => hasPath("Rows/Output/Title"), "folder rows");
  assert.equal(walk(settingsHost).filter((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === S("settings.change")).length, 3);
  assert.ok(walk(settingsHost).every((e) => !e.title && !e.getAttribute("title")));
  button(S("display.close")).click();
  assert.equal(settingsHost.hidden, true);
  answers["settings.get"] = prefs;
  delete answers["settings.set"];
  delete answers["mods.consent"];
});

test("Settings' manual Check asks for missing consent, stops on refusal, and checks after Allow", async () => {
  const Settings = await import("../../src/ba_modding_toolkit/web/js/settings.js");
  const saved = { ...answers };
  let state;
  answers["mods.state"] = () => state;
  answers["mods.consent"] = ({ granted }) => { state = { ...state, scan: granted }; return {}; };
  answers["mods.scan"] = () => { assert.equal(state.scan, true, "consent must be saved before scanning"); return { requested: true }; };
  const button = (name) => walk(settingsHost).find((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === name);
  const selected = (i) => walk(settingsHost).some((e) => e.dataset.path === `Rows/Scan/Opt_${i}/On`);
  try {
    for (const scan of [false, null]) {
      state = base({ scan });
      answers["settings.get"] = { ...saved["settings.get"], native: false, traySupported: false };
      await MS.refresh();
      await Settings.open();
      button(S("settings.tab.mods"))?.click();
      await until(() => selected(1), "automatic checks Off");
      const rowPaths = walk(settingsHost).map((e) => e.dataset.path).filter((p) => /^Rows\/[^/]+$/.test(p));
      assert.ok(!rowPaths.includes("Rows/Tray"));
      assert.equal(rowPaths[rowPaths.indexOf("Rows/Scan") + 1], "Rows/Files");
      const scans = called("mods.scan").length, grants = called("mods.consent").length;
      button(S("settings.mods.check")).click();
      await drawn(consent, "ok");
      assert.ok(consent.classList.contains("over"), "consent appears over Settings");
      assert.equal(settingsHost.hidden, false);
      assert.equal(called("mods.consent").length, grants, "Check grants nothing itself");
      assert.equal(called("mods.scan").length, scans, "no scan before consent");
      action(consent, "cancel").click();
      await until(() => consent.hidden && MS.current().scan === false && selected(1), "refusal keeps checks Off");
      await tick();
      assert.equal(called("mods.scan").length, scans, "refusing cancels the manual Check");
      button(S("settings.mods.check")).click();
      await drawn(consent, "ok");
      assert.equal(called("mods.scan").length, scans);
      action(consent, "ok").click();
      await until(() => called("mods.scan").length === scans + 1, "manual Check after Allow");
      assert.deepEqual(called("mods.consent").at(-1), { granted: true });
      assert.deepEqual(called("mods.scan").at(-1), { dismissed: true }, "manual Check includes dismissed entries");
      assert.equal(dialog.hidden, true, "waits for the scan result");
      emit("library.scanned", { entries: [] });
      await until(() => !Loading.busy(), "scan settled without a confirmation");
      assert.equal(dialog.hidden, true);
      await until(() => selected(0), "scan result and On selected");
      assert.equal(settingsHost.hidden, false);
      const granted = called("mods.consent").length;
      button(S("settings.mods.check")).click();
      await until(() => called("mods.scan").length === scans + 2, "manual Check with existing consent");
      assert.equal(consent.hidden, true, "existing consent needs no popup");
      assert.equal(called("mods.consent").length, granted);
      assert.deepEqual(called("mods.scan").at(-1), { dismissed: true });
      emit("library.scanned", { entries: [] });
      await until(() => !Loading.busy(), "scan settled without a confirmation");
      assert.equal(dialog.hidden, true);
      button(S("display.close")).click();
    }
  } finally {
    emit("library.scanned", { entries: [] });
    if (!settingsHost.hidden) button(S("display.close"))?.click();
    for (const key of Object.keys(answers)) delete answers[key];
    Object.assign(answers, saved);
  }
});

test("the scan consent renders the two replacement sections in every locale and grants nothing until answered", async () => {
  const before = called("mods.consent").length;
  try {
    for (const [index, lang] of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"].entries()) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
      I18n.setStrings(lang, flat({ webui: ui }));
      const pending = MS.askScan();
      await drawn(consent, "ok");
      assert.ok(consent.classList.contains("over"), "over Settings");
      assert.equal(called("mods.consent").length, before + index, "nothing granted yet");
      for (const [name, section] of [["Checked", ui.mods.scan.will], ["Never", ui.mods.scan.willNot]]) {
        const part = (path) => walk(consent).find((e) => e.dataset.path === `Center/Popup/${name}/${path}`);
        assert.equal(part("Title_Bg/Label").textContent, section.label, lang);
        assert.equal(part("Item_0").textContent.replaceAll("\n", " ").replaceAll(" ", ""), section.items.replaceAll(" ", ""), lang);
        assert.equal(part("Item_1"), undefined, "one item per section");
      }
      assert.ok(press("Escape").defaultPrevented, "it must be answered");
      assert.equal(consent.hidden, false);
      action(consent, "ok").click();
      assert.equal(await pending, true);
      assert.deepEqual(called("mods.consent").at(-1), { granted: true });
      assert.equal(consent.classList.contains("over"), false);
    }
  } finally { I18n.setStrings("en-US", strings); }
});

test("the classic modal queues the refused write only when its box is ticked, on any close", async () => {
  const queued = () => called("classic.queue").length;
  // unticked, closed with OK: nothing
  let m = MS.classicModal({ method: "mods.toggle", params: { enabled: false, expect: true } });
  await drawn(dialog, "ok");
  action(dialog, "ok").click();
  assert.equal(await m, null);
  assert.equal(queued(), 0);
  // ticked, closed with Escape: queued with its call
  m = MS.classicModal({ method: "actions.apply", params: { variant: "airi", source: "variant:ch0251", kind: "spr" } });
  await drawn(dialog, "check");
  action(dialog, "check").click();
  press("Escape");
  assert.equal(await m, "queue");
  await until(() => queued() === 1, "classic.queue");
  await tick(); assert.equal(dialog.hidden, true, "plain confirmations stay silent");
  assert.deepEqual(called("classic.queue")[0], { method: "actions.apply", params: { variant: "airi", source: "variant:ch0251", kind: "spr" } });
  // ticked, Bring to Front: raised and queued
  m = MS.classicModal({ method: "mods.toggle", params: { enabled: true, expect: false } });
  await drawn(dialog, "check");
  action(dialog, "check").click();
  action(dialog, "cancel").click();
  assert.equal(await m, "queue");
  await until(() => queued() === 2 && called("classic.front").length === 1, "front and queue");
  await tick(); assert.equal(dialog.hidden, true, "plain confirmations stay silent");
  // opened on writes already queued (a click on the busy switch): the box ticked; unticked and closed, the queue empties
  answers["mods.state"] = base({ busy: true, queued: 2 });
  await MS.refresh();
  MS.click("top");
  await drawn(dialog, "check");
  assert.equal(action(dialog, "check").getAttribute("aria-checked"), "true");
  action(dialog, "check").click();
  action(dialog, "ok").click();
  await until(() => called("classic.clearQueue").length === 1, "classic.clearQueue");
  // a toggle refused at submit with classic_open opens the modal instead of a notify
  answers["mods.state"] = base();
  await MS.refresh();
  answers["mods.toggle"] = { error: { code: "classic_open", params: {} } };
  MS.click("top");
  await drawn(dialog, "check");
  assert.equal(walk(dialog).some((e) => e.attrs?.["aria-label"] === S("classic.front")), true);
  press("Escape");
  await until(() => dialog.hidden, "closed");
  assert.equal(queued(), 2, "unticked: nothing queued");
});

// --- item 1's prompts (prompts.js) ---

const P = await import("../../src/ba_modding_toolkit/web/js/prompts.js");
const GLOBAL = "/games/BlueArchive", JAPAN = "/games/Japan";
const gameFile = (core, extra = {}) => ({ file: `${GLOBAL}/${core}.bundle`, core, kind: /_spr$/.test(core) ? "spr" : "lobby", applied: "unknown", crc: "fixed",
  original: false, date: "", size: 100, copy: "kept", restorable: true, official: false, ...extra });
const entry = (core, state, extra = {}) => ({
  install: GLOBAL, core, variant: core.replace(/_spr$|_home.*$/, ""), names: null, kind: /_spr$/.test(core) ? "spr" : "lobby", source: "unknown",
  configured: null, state, overwritten: false, fixed: true, size: 100, files: [gameFile(core)], dismissed: false, ...extra,
});

test("which entries each prompt lists: drift while mods are on, untracked and changed, the rest apart", () => {
  const all = [entry("airi_spr", "reset"), entry("airi_home", "updated"), entry("hina_spr", "untracked"), entry("mika_spr", "changed", { configured: "mod:x" }),
    entry("yuzu_spr", "damaged"), entry("aris_spr", "pending", { overwritten: true }), entry("noa_spr", "ok"), entry("kei_spr", "reset", { dismissed: true })];
  const keys = (list) => list.map((e) => e.core);
  const drift = P.promptEntries(all, "drift");
  assert.deepEqual(keys(drift.listed), ["airi_spr", "airi_home"]);
  assert.deepEqual(keys(drift.apart), ["aris_spr"], "stuck: no repair brought it back");
  assert.deepEqual(keys(P.promptEntries(all, "drift", { dismissed: true }).listed), ["airi_spr", "airi_home", "kei_spr"], "Settings' Check");
  assert.deepEqual(P.promptEntries(all, "drift", { enabled: false }).listed, [], "mods off: official files are the intent");
  const untracked = P.promptEntries(all, "untracked");
  assert.deepEqual(keys(untracked.listed), ["hina_spr", "mika_spr"]);
  assert.deepEqual(keys(untracked.apart), ["yuzu_spr"], "damaged: never added");
  // something new to show: an entry not shown in this state yet
  const shown = new Set([`${GLOBAL}|airi_spr|reset`]);
  assert.equal(P.fresh([entry("airi_spr", "reset")], shown), false);
  assert.equal(P.fresh([entry("airi_spr", "updated")], shown), true);
});

test("a prompt's cards: the name, the kind and install chips, No Official Copy, and what cannot be ticked", () => {
  const two = base({ installs: [install(GLOBAL, "Global"), install(JAPAN, "Japan", { id: "0123abcd4567" })] });
  const nameOf = (e) => ({ airi: "Airi", hina: "Hina" })[e.variant] || e.variant;
  const c = P.card(entry("airi_spr", "untracked"), { state: base(), nameOf });
  assert.deepEqual([c.key, c.label, c.full, c.chips, c.disabled, c.size], [`${GLOBAL}|airi_spr`, `Airi, ${S("tab.portrait")}`, "Airi", [S("tab.portrait")], false, 100]);
  assert.equal(P.card(entry("hina_home", "reset"), { nameOf, sep: "、" }).label, `Hina、${S("tab.lobby")}`, "a portrait and a lobby are told apart");
  // two installs: the install chip; an alternate lobby core: its suffix after the kind
  const j = P.card(entry("hina_home_gl", "untracked", { install: JAPAN, overwritten: true }), { state: two, nameOf });
  assert.deepEqual(j.chips, [`${S("tab.lobby")} gl`, "Japan", S("mods.copy.none")]);
  assert.equal(j.badge.text, S("mods.copy.none"));
  // damaged: listed apart, never ticked, drawn dim
  const d = P.card(entry("yuzu_spr", "damaged"), { state: base(), nameOf });
  assert.deepEqual([d.disabled, d.dim, d.size, d.badge.text], [true, true, 0, S("mods.damaged")]);
  // another install's card draws that install's own files (<core>@<id>), the current one's its plain core
  assert.equal(P.entryBase(entry("hina_home_gl", "untracked", { install: JAPAN }), two), "/asset/spine/lobby/hina_home_gl@0123abcd4567/skeleton");
  assert.equal(P.entryBase(entry("airi_spr", "untracked"), two), "/asset/spine/spr/airi_spr/skeleton");
  // the details: file, size, CRC state and where an official copy is
  const det = P.details(entry("airi_spr", "untracked", { files: [gameFile("airi_spr", { copy: "backup", size: 2 * 1048576 })] }));
  assert.equal(det.title, S("tab.portrait"));
  assert.deepEqual(det.fields, [[S("field.file"), "airi_spr.bundle"], [S("field.size"), "2.0 MB"], [S("field.crc"), S("crc.fixed")], [S("field.copy"), S("mods.copy.backup")]]);
  assert.equal(P.details(entry("yuzu_spr", "damaged")).repair, true);
  assert.equal(P.copyText(entry("x_spr", "untracked", { files: [gameFile("x_spr", { copy: null, restorable: false })] })), S("mods.copy.none"));
  assert.equal(P.copyText(entry("x_spr", "untracked", { files: [gameFile("x_spr", { copy: "elsewhere" })] })), S("mods.copy.elsewhere"));
  // the footer: the ticked cards and their size
  const items = [P.card(entry("a_spr", "untracked", { size: 1048576 }), {}), P.card(entry("b_spr", "untracked", { size: 1048576 }), {})];
  assert.equal(P.footer(items, new Set([items[0].key]), { sep: ", " }), "Selected: 1, Total size: 1.0 MB");
  assert.equal(P.footer(items, new Set([items[0].key]), { size: false }), "Selected: 1", "the drift prompt copies nothing");
  // an entry back to official: its official files, with their size
  const reset = P.details(entry("airi_spr", "reset", { files: [gameFile("airi_spr", { official: true, applied: "official", size: 1048576 })] }));
  assert.deepEqual(reset.fields.slice(0, 2), [[S("field.file"), "airi_spr.bundle"], [S("field.size"), "1.0 MB"]]);
});

test("the untracked prompt's buttons: add the ticked cards, Don't Ask Again dismisses the others, Later adds nothing", () => {
  const items = [P.card(entry("a_spr", "untracked"), {}), P.card(entry("b_spr", "untracked"), {}), P.card(entry("c_spr", "damaged"), {})];
  const ticked = new Set([items[0].key]);
  const a = { install: GLOBAL, core: "a_spr" }, b = { install: GLOBAL, core: "b_spr" };
  assert.deepEqual(P.untrackedOutcome("add", items, ticked, false), { adopt: [a], dismiss: [], turnOn: false });
  assert.deepEqual(P.untrackedOutcome("add", items, ticked, true), { adopt: [a], dismiss: [b], turnOn: false });
  assert.deepEqual(P.untrackedOutcome("addTurnOn", items, ticked, false), { adopt: [a], dismiss: [], turnOn: true });
  assert.deepEqual(P.untrackedOutcome("later", items, ticked, false), { adopt: [], dismiss: [], turnOn: false });
  assert.deepEqual(P.untrackedOutcome("later", items, ticked, true), { adopt: [], dismiss: [a, b], turnOn: false }, "the damaged entry is never dismissed");
});

test("Apply Mod Configuration's result names the entries skipped because their files changed", () => {
  assert.deepEqual(P.driftSummary({ done: [{}], failed: [], skipped: [], stuck: [] }), null);
  const nameOf = (e) => e.variant;
  const r = P.driftSummary({
    done: [{}], stuck: [],
    failed: [{ entry: { core: "airi_spr", variant: "Airi", kind: "spr" }, code: "game_file_locked", params: {} }],
    skipped: [{ install: GLOBAL, core: "hina_home", variant: "Hina", kind: "lobby", why: "changed" }, { core: "x_spr", why: "missing" }],
  }, nameOf);
  assert.equal(r.title, S("mods.driftTitle"));
  assert.deepEqual(r.lines, ["Done: 1, failed: 2", `Airi, Portrait - ${S("error.game_file_locked")}`, `Hina, Memorial Lobby - ${S("error.entry_changed")}`]);
});

test("an overwritten entry's message: Add First until its mod is in the library, then the repair lines", () => {
  assert.equal(P.overwrittenKind([gameFile("airi_spr", { applied: "unknown" })]), "addFirst");
  assert.equal(P.overwrittenKind([gameFile("airi_spr", { applied: "mod:abc" }), gameFile("airi_spr", { applied: "mod:abc", official: true })]), "overwritten");
  assert.equal(P.overwrittenKind([gameFile("airi_spr", { applied: "mod:abc" }), gameFile("airi_spr", { applied: "unknown" })]), "addFirst");
  assert.equal(P.overwrittenKind([]), "addFirst");
});

// --- the tray's events: the window comes to the front, and the page shows what follows ---

test("the tray's first toggle explains once, and the explanation's button submits the tray's toggle", async () => {
  // a page that has not explained anything yet (the explanation is once per place it shows)
  const Fresh = await import("../../src/ba_modding_toolkit/web/js/mod-switch.js?tray");
  answers["mods.state"] = base({ explained: false, enabled: true });
  answers["mods.toggle"] = "job-tray-1";
  jobs["job-tray-1"] = { state: "done", result: { enabled: false, done: [], adopted: [], failed: [], stuck: [], left: [] } };
  const before = called("mods.toggle").length;
  const shown = Fresh.trayOpen({ view: "explain", enabled: false, expect: true });
  await drawn(dialog, "ok");
  assert.equal(labels(dialog).includes(S("mods.offTitle")), true, "Turn Off Mods");
  action(dialog, "ok").click();
  await shown;
  assert.deepEqual(called("mods.toggle").slice(before), [{ enabled: false, expect: true }]);
  await tick(); assert.equal(dialog.hidden, true, "plain confirmations stay silent");
  // closed any other way: shown, and nothing toggled
  const Other = await import("../../src/ba_modding_toolkit/web/js/mod-switch.js?tray-cancel");
  const explained = called("mods.explained").length;
  const cancelled = Other.trayOpen({ view: "explain", enabled: false, expect: true });
  await drawn(dialog, "cancel");
  action(dialog, "cancel").click();
  await cancelled;
  assert.equal(called("mods.explained").length, explained + 1);
  assert.equal(called("mods.toggle").length, before + 1);
});

test("the tray's refusal shows as the page's own, and its toggle is followed to its result", async () => {
  await MS.trayOpen({ view: "error", code: "game_running", params: {} });
  await expectNotice(S("error.game_running"));
  // classic_open from the tray: the tray never queues, so no classic modal
  await MS.trayOpen({ view: "error", code: "classic_open", params: {} });
  await expectNotice(S("error.classic_open"));
  assert.equal(dialog.hidden, true);
  jobs["job-tray-2"] = { state: "done", result: { enabled: true, done: [{}], adopted: [], failed: [], stuck: [], left: [] } };
  emit("tray.toggle", { job: "job-tray-2", enabled: true, expect: false });
  await tick(); assert.equal(dialog.hidden, true, "plain confirmations stay silent");
  // a result with failed entries: the result popup
  jobs["job-tray-3"] = { state: "done", result: { enabled: false, done: [], adopted: [], stuck: [], left: [],
    failed: [{ entry: { core: "airi_spr", variant: "airi", kind: "spr" }, code: "game_file_locked", params: {} }] } };
  const followed = MS.trayToggle({ job: "job-tray-3", enabled: false, expect: true });
  await drawn(dialog, "ok");
  action(dialog, "ok").click();
  await followed;
  // a toggle job that failed (switched elsewhere first): its notify
  jobs["job-tray-4"] = { state: "failed", error: { code: "state_changed", params: {} } };
  await MS.trayToggle({ job: "job-tray-4", enabled: true, expect: false });
  await expectNotice(S("error.state_changed"));
});

test("the tray's Back to Official opens the drift prompt: two buttons and no way out but them", async () => {
  P.init({ names: async () => (e) => ({ airi: "Airi", hina: "Hina" })[e.variant] || e.variant });
  answers["mods.state"] = base();
  await MS.refresh();
  answers["mods.entries"] = [entry("airi_spr", "reset", { configured: "mod:a" }), entry("hina_home", "updated", { configured: "mod:b" }), entry("noa_spr", "untracked")];
  answers["mods.restoreDrift"] = "job-drift";
  jobs["job-drift"] = { state: "done", result: { done: [{ install: GLOBAL, core: "airi_spr" }], failed: [], skipped: [], stuck: [] } };
  const opened = MS.trayOpen({ view: "drift" });
  await drawn(prompt, "apply");
  assert.ok(action(prompt, "keep"), "Keep as Is");
  assert.equal(action(prompt, "close"), undefined, "no close button");
  assert.ok(press("Escape").defaultPrevented, "Escape does nothing");
  assert.equal(prompt.hidden, false);
  const cards = () => walk(prompt).filter((e) => e.dataset?.key);
  assert.deepEqual(cards().map((c) => [c.dataset.key, c.getAttribute("aria-checked")]), [[`${GLOBAL}|airi_spr`, "true"], [`${GLOBAL}|hina_home`, "true"]]);
  cards().find((c) => c.dataset.key === `${GLOBAL}|hina_home`).click();
  await until(() => cards().find((c) => c.dataset.key === `${GLOBAL}|hina_home`)?.getAttribute("aria-checked") === "false", "unticked");
  action(prompt, "apply").click();
  await opened;
  await until(() => called("mods.restoreDrift").length === 1, "mods.restoreDrift");
  assert.deepEqual(called("mods.restoreDrift")[0], { entries: [{ install: GLOBAL, core: "airi_spr", state: "reset" }] });
  assert.deepEqual(called("mods.dismiss").at(-1), { kind: "drift", entries: [{ install: GLOBAL, core: "hina_home", state: "updated" }] });
  assert.equal(prompt.hidden, true);
  await tick(); assert.equal(dialog.hidden, true, "plain confirmations stay silent");
  // nothing back to official any more: the tray's item was stale, the page says so
  answers["mods.entries"] = [];
  await MS.trayOpen({ view: "drift" });
  await until(() => !Loading.busy(), "scan settled without a confirmation");
      assert.equal(dialog.hidden, true);
});

test("the Game Files row's \"?\": one definition of configuration drift", async () => {
  const Settings = await import("../../src/ba_modding_toolkit/web/js/settings.js");
  try {
    for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui;
      I18n.setStrings(lang, flat({ webui: ui }));
      assert.deepEqual(Settings.driftLines(), [ui.settings.mods.driftHelp.what]);
      assert.equal(Settings.driftLines()[0].includes("\n"), false);
      assert.deepEqual(Object.keys(ui.settings.mods.driftHelp), ["title", "what"]);
    }
  } finally { I18n.setStrings("en-US", strings); }
});

test("held refusal prompts accept Overwritten, Add First and its result, and scan consent", async () => {
  answers["mods.state"] = base();
  await MS.refresh();
  let held = Loading.hold(() => P.overwritten({ name: "Airi", core: "airi_spr", files: [gameFile("airi_spr", { applied: "mod:a" })] }));
  await drawn(dialog, "ok");
  assert.equal(Loading.held(), true);
  assert.equal(action(dialog, "ok").click().stopped, false, "Overwritten can be answered inside the hold");
  assert.equal(await held, false);

  answers["mods.adopt"] = "job-held-adopt";
  jobs["job-held-adopt"] = { state: "done", result: { added: [], failed: [{ entry: { variant: "airi", core: "airi_spr" }, code: "game_file_locked" }] } };
  held = Loading.hold(() => P.overwritten({ name: "Airi", core: "airi_spr", files: [gameFile("airi_spr")] }));
  await drawn(dialog, "cancel");
  assert.equal(action(dialog, "ok").click().stopped, false, "Add First can submit adoption");
  await drawn(dialog, "ok");
  assert.equal(action(dialog, "cancel").attrs["aria-label"], S("recovery.report"), "the failed adoption offers Error Report");
  assert.equal(Loading.held(), true);
  assert.equal(press("Escape", stage).stopped, false, "the follow-up result receives Escape from the page");
  assert.equal(await held, false);
  assert.equal(Loading.held(), false);

  const Consent = await import("../../src/ba_modding_toolkit/web/js/consent.js");
  held = Loading.hold(() => Consent.scan(consent));
  await drawn(consent, "ok");
  assert.equal(press("Escape", stage).stopped, false);
  assert.equal(consent.hidden, false, "consent still requires a button");
  assert.equal(action(consent, "ok").click().stopped, false);
  assert.equal(await held, true);
  assert.equal(Loading.held(), false);
});

test("a toggle holds page input through the refresh and drawing, then shows an answerable result", async () => {
  const fetched = deferred(), drawnPage = deferred(), started = deferred();
  answers["mods.state"] = base();
  answers["mods.toggle"] = "job-refresh";
  jobs["job-refresh"] = { state: "done", result: { enabled: false, failed: [{ entry: { variant: "airi", core: "airi_spr" }, code: "game_file_locked" }] } };
  await MS.init({ refreshPage: async () => { started.resolve(); await fetched.promise; await drawnPage.promise; } });
  const chooser = stage.appendChild(new El("button"));
  let opened = 0; chooser.addEventListener("click", () => { opened++; });
  const toggled = MS.turn({ enabled: false, expect: true });
  assert.equal(Loading.held(), true, "held from submission");
  try {
    await started.promise;
    assert.equal(dialog.hidden, true, "the result cannot defer the refresh");
    for (const type of ["pointerdown", "click", "keydown"]) {
      assert.ok(chooser.dispatch(type, { key: "Enter" }).defaultPrevented, `${type} while the page is stale`);
    }
    fetched.resolve();
    await tick();
    assert.equal(Loading.held(), true, "RPC completion still waits for drawing");
    assert.equal(opened, 0);
    drawnPage.resolve();
    await drawn(dialog, "ok");
    assert.equal(Loading.held(), false, "the result is outside the hold");
    assert.equal(action(dialog, "ok").click().stopped, false);
    await toggled;
    assert.equal(dialog.hidden, true);
    chooser.click();
    assert.equal(opened, 1);

    // Escape also closes the result when focus has remained on the page.
    const again = MS.turn({ enabled: false, expect: true });
    await drawn(dialog, "ok");
    assert.ok(press("Escape", chooser).defaultPrevented);
    await again;
    assert.equal(dialog.hidden, true);
  } finally {
    fetched.resolve(); drawnPage.resolve();
    action(dialog, "ok")?.click();
    await toggled;
    chooser.remove();
    await MS.init({ refreshPage: async () => {} });
  }
});

test("a failed or stalled page refresh releases the toggle hold within its bound", async (t) => {
  answers["mods.state"] = base();
  answers["mods.toggle"] = "job-refresh-failed";
  jobs["job-refresh-failed"] = { state: "done", result: { enabled: true } };
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  await MS.init({ refreshPage: async () => { throw new Error("refresh failed"); } });
  await MS.turn({ enabled: true, expect: false });
  assert.equal(Loading.held(), false);
  await tick(); assert.equal(dialog.hidden, true, "plain confirmations stay silent");
  assert.match(String(errors[0]), /refresh failed/);

  const started = deferred();
  await MS.init({ refreshPage: () => { started.resolve(); return new Promise(() => {}); } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const toggled = MS.turn({ enabled: true, expect: false });
    await started.promise;
    assert.equal(Loading.held(), true);
    t.mock.timers.tick(14999);
    await new Promise(setImmediate);
    assert.equal(Loading.held(), true, "the bound has not expired");
    t.mock.timers.tick(1);
    await toggled;
    assert.equal(Loading.held(), false);
    assert.equal(dialog.hidden, true, "plain confirmations stay silent");
    // The in-flight guard was released too: another toggle can complete.
    await MS.init({ refreshPage: async () => {} });
    await MS.turn({ enabled: true, expect: false });
    assert.equal(Loading.held(), false);
  } finally {
    t.mock.timers.reset();
    await MS.init({ refreshPage: async () => {} });
  }
});

test("scan, cache cleanup and both switch directions name their action in every locale", async () => {
  const progress = (label) => walk(stage).some((el) => el.classList.contains("loading-progress") && el.textContent === label);
  try {
    await MS.init({ refreshPage: async () => {} });
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const table = flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")));
      const ui = (key, vars = {}) => table[`webui.${key}`].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
      I18n.setStrings(locale, table);
      const cache = `clear-${locale}`;
      answers["mods.clearBuilt"] = cache;
      jobs[cache] = { state: "running" };
      const cleared = MS.clearBuilt();
      try { await until(() => progress(ui("progress.clear")), "cache action"); }
      finally { jobs[cache] = { state: "done", result: { freed: 1 } }; emit("job.done", { id: cache, result: { freed: 1 } }); }
      assert.equal(await cleared, true);

      answers["mods.scan"] = { requested: true };
      const checked = MS.check();
      const scanResult = { entries: [], counts: {} };
      try { await until(() => progress(ui("progress.check")), "scan action"); }
      finally { emit("library.scanned", scanResult); }
      assert.deepEqual(await checked, scanResult);

      for (const enabled of [false, true]) {
        answers["mods.state"] = base({ enabled: !enabled, explained: true });
        await MS.refresh();
        const id = `toggle-${locale}-${enabled}`, action = enabled ? "apply" : "restore";
        const result = { enabled, done: [], failed: [], adopted: [], stuck: [], left: [] };
        jobs[id] = { state: "running" }; answers["mods.toggle"] = id;
        const toggled = MS.turn({ enabled, expect: !enabled });
        try {
          await until(() => progress(ui(`progress.${action}`, { name: ui("progress.mods") })), "switch action");
          const label = ui(`progress.${action}`, { name: "test_spr" });
          emit("job.progress", { id, label, current: 0, total: 2 });
          assert.ok(progress(ui("progress.count", { label, current: 0, total: 2 })));
        } finally { jobs[id] = { state: "done", result }; emit("job.done", { id, result }); }
        await toggled;
        assert.equal(dialog.hidden, true, "plain switch results stay silent");
      }
    }
  } finally { I18n.setStrings("en-US", strings); }
});

test("the toggle flushes the event delay and awaits the visible detail or roster redraw", async () => {
  const main = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
  const changed = main.slice(main.indexOf("let heldChange,"), main.indexOf("// the window back in front"));
  assert.match(main, /refreshPage: refreshAfterToggle/, "the switch uses the awaited refresh");
  for (const screen of ["detail", "roster"]) {
    const ready = deferred();
    let refreshed = false, invalidated = 0, settled = false;
    const timers = new Set();
    const env = {
      $: (id) => ({ hidden: id !== `screen-${screen}` }),
      ctx: { invalidateRoster: () => { invalidated++; } },
      BatchImport: { invalidate() {} },
      forget() {}, spinePrefix() {},
      Detail: { filesChanged: async () => { refreshed = true; await ready.promise; } },
      Popup: { whenIdle: async () => {} },
      route: async () => { refreshed = true; await ready.promise; },
      setTimeout: (fn) => { timers.add(fn); return fn; }, clearTimeout: (fn) => timers.delete(fn),
    };
    const h = new Function("env", `let { ${Object.keys(env).join(", ")} } = env; let routeToken = 1;
      ${changed}
      return { libraryChanged, refreshAfterToggle };`)(env);
    h.libraryChanged({ cores: ["airi_spr"] });
    assert.equal(refreshed, false, "the event is coalesced for 150 ms");
    const refresh = h.refreshAfterToggle().then(() => { settled = true; });
    await tick();
    assert.equal(timers.size, 0, "the pending delay is flushed");
    assert.equal(invalidated, 2, "also refreshes if the event has not arrived");
    assert.equal(refreshed, true);
    assert.equal(settled, false, `${screen} is still drawing`);
    ready.resolve();
    await refresh;
    assert.equal(settled, true);
  }
});

test("main refreshes on external Enable Mods changes and keeps the awaited local toggle refresh", async () => {
  const main = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
  const setup = main.slice(main.indexOf('  await timed("mod-state"'), main.indexOf("  Prompts.init("));
  let listener, options, changes = 0;
  const names = async () => {}, refresh = async () => {};
  const ModSwitch = {
    init: async (opts) => { options = opts; }, current: () => ({ enabled: true }),
    onChange: (fn) => { listener = fn; },
  };
  await new Function("ModSwitch", "variantNames", "refreshAfterToggle", "libraryChanged", "timed", `return (async () => { ${setup} })();`)(
    ModSwitch, names, refresh, (data) => { assert.equal(data, null); changes++; }, (_phase, work) => work());
  assert.equal(options.names, names);
  assert.equal(options.refreshPage, refresh);
  listener({ enabled: true, busy: true });
  assert.equal(changes, 0);
  listener({ enabled: false });
  listener({ enabled: false, busy: false });
  assert.equal(changes, 1, "one refresh for the switch flipping, independent of file changes");
  listener({ enabled: true });
  assert.equal(changes, 2);
});

test("the startup update check can be disabled for compiled releases", () => {
  assert.equal(MS.startDue("update", { info: { compiled: true, startupUpdate: false } }), false);
  assert.equal(MS.startDue("update", { info: { compiled: true, startupUpdate: true } }), true);
  assert.equal(MS.startDue("update", { info: { compiled: false, startupUpdate: true } }), false);
});

test("detail refresh callers await changes queued while an earlier refresh is drawing", async () => {
  const detail = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
  const changed = detail.slice(detail.indexOf("let heldChange;"), detail.indexOf("async function reloadChanged()")).replace("export function", "function");
  const first = deferred(), second = deferred();
  let reads = 0, settled = false;
  const env = {
    popupOpen: () => false, Visual: { isOpen: () => false }, changing: () => false, Loading: { covering: () => false },
    sleep: tick,
  };
  const h = new Function("env", `let { ${Object.keys(env).join(", ")} } = env;
    let open = true, busy = false, fullscreen = false, fam = { variants: [{ spr: "airi_spr" }] };
    ${changed}
    async function reloadChanged() { heldChange = undefined; await env.draw(); }
    return { filesChanged };`)({ ...env, draw: () => (++reads === 1 ? first.promise : second.promise) });
  const a = h.filesChanged(null);
  const b = h.filesChanged({ cores: ["airi_spr"] });
  assert.equal(a, b, "both callers follow the same refresh queue");
  b.then(() => { settled = true; });
  first.resolve();
  await tick();
  assert.equal(reads, 2);
  assert.equal(settled, false);
  second.resolve();
  await Promise.all([a, b]);
  assert.equal(settled, true);
});

test("Spine confirmation is plain before asset consent and grants nothing until its answer is saved", async () => {
  const Consent = await import("../../src/ba_modding_toolkit/web/js/consent.js");
  const Runtime = await import("../../src/ba_modding_toolkit/web/js/spine-runtime.js");
  const saved = answers["app.spineConsent"];
  const save = deferred();
  Runtime.setSpineConsent(null);
  Consent.init({ consent: false });
  answers["app.spineConsent"] = () => save.promise;
  try {
    const pending = Consent.spine(consent, { over: true });
    assert.equal(Consent.spine(consent), pending, "concurrent requests share the prompt");
    await drawn(consent, "ok");
    assert.ok(walk(consent).some((e) => e.classList.contains("spine-license-plain")));
    assert.ok(!walk(consent).some((e) => e.dataset.path), "no game layout in the plain prompt");
    assert.ok(press("Escape").defaultPrevented);
    assert.equal(consent.hidden, false, "Escape cannot grant or refuse");
    assert.equal(Runtime.spineAllowed(), false);
    const before = called("app.spineConsent").length;
    action(consent, "ok").click();
    action(consent, "ok").click();
    await tick();
    assert.equal(called("app.spineConsent").length, before + 1, "only one write while saving");
    assert.equal(Runtime.spineAllowed(), false, "saving is awaited before enabling the runtime");
    assert.equal(consent.hidden, false);
    save.resolve(true);
    assert.equal(await pending, true);
    assert.equal(Runtime.spineAllowed(), true);
    assert.equal(Runtime.runtimeLoaded(), false, "the confirmation itself never loads Spine");
    assert.equal(consent.hidden, true);
    assert.equal(consent.classList.contains("over"), false);
  } finally { answers["app.spineConsent"] = saved; Runtime.setSpineConsent(null); }
});

test("Spine confirmation uses the game frame after asset consent and every locale has both answers", async () => {
  const Consent = await import("../../src/ba_modding_toolkit/web/js/consent.js");
  const Runtime = await import("../../src/ba_modding_toolkit/web/js/spine-runtime.js");
  const saved = answers["app.spineConsent"];
  answers["app.spineConsent"] = ({ granted }) => granted;
  Consent.init({ consent: true });
  try {
    for (const [index, locale] of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"].entries()) {
      const table = flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")));
      I18n.setStrings(locale, table);
      const text = (key) => table[`webui.spine.license.${key}`];
      const before = called("app.spineConsent").length;
      const pending = Consent.spine(consent);
      await drawn(consent, "ok");
      assert.equal(called("app.spineConsent").length, before);
      const title = walk(consent).find((e) => e.dataset.path === "Center/Popup/Base/BG/Label_Title_Locale");
      assert.equal(title.textContent, text("title"), locale);
      assert.equal(action(consent, "ok").getAttribute("aria-label"), text("yes"));
      assert.equal(action(consent, "cancel").getAttribute("aria-label"), text("no"));
      const body = walk(consent).find((e) => e.dataset.path === "Center/Popup/Licence");
      assert.equal(body.textContent.replaceAll("\n", " ").replaceAll(" ", ""), text("body").replaceAll(" ", ""));
      assert.ok(walk(consent).every((e) => !e.title && !e.getAttribute("title")));
      const granted = index % 2 === 0;
      action(consent, granted ? "ok" : "cancel").click();
      assert.equal(await pending, granted);
      assert.deepEqual(called("app.spineConsent").at(-1), { granted });
      assert.equal(Runtime.spineAllowed(), granted);
    }
  } finally { I18n.setStrings("en-US", strings); answers["app.spineConsent"] = saved; Runtime.setSpineConsent(null); }
});

test("startup asks for Spine after asset consent, before scan, and skips a saved refusal", async () => {
  const main = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
  const source = main.slice(main.indexOf("function startPopups()"), main.indexOf("async function start()"));
  for (const choice of [null, false, true]) {
    const info = { consent: null, spineConsent: choice }, order = [];
    const env = {
      info, $: () => consent,
      ModSwitch: { startDue: MS.startDue, current: () => base({ scan: null }) },
      Consent: {
        show: async () => { order.push("assets"); return true; },
        spine: async () => { assert.equal(info.consent, true); order.push("spine"); return false; },
        scan: async () => { order.push("scan"); return false; },
      },
      Prompts: { start: async (name) => { order.push(name); } },
      Loading: { init() {} }, route: async () => { order.push("route"); },
    };
    const steps = new Function("env", `const { ${Object.keys(env).join(", ")} } = env; ${source}; return startPopups();`)(env);
    await (await import("../../src/ba_modding_toolkit/web/js/popup.js")).sequence(steps);
    assert.deepEqual(order, ["assets", ...(choice == null ? ["spine"] : []), "scan", "drift", "untracked"]);
    assert.equal(info.spineConsent, choice == null ? false : choice);
  }
});

test("Settings confirms Spine beside the asset consent and withdrawal names its restart effect after loading", async () => {
  const Consent = await import("../../src/ba_modding_toolkit/web/js/consent.js");
  const Settings = await import("../../src/ba_modding_toolkit/web/js/settings.js");
  const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
  const Runtime = await import("../../src/ba_modding_toolkit/web/js/spine-runtime.js");
  const saved = { ...answers }, previousSpine = globalThis.spine;
  let prefs = { languages: [{ code: "en-US", name: "English" }], language: "en-US", cacheDir: "/cache",
    gameDirs: { global: "/game" }, fileSource: "windows_global", ...saved["settings.get"], spineConsent: false };
  const changes = [];
  answers["settings.get"] = () => prefs;
  answers["app.spineConsent"] = ({ granted }) => { prefs = { ...prefs, spineConsent: granted }; return granted; };
  Consent.init({ consent: true });
  Runtime.setSpineConsent(false);
  const button = (name) => walk(settingsHost).find((e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === name);
  const hasPath = (path) => walk(settingsHost).some((e) => e.dataset.path === path);
  const selected = (i) => hasPath(`Rows/Spine/Opt_${i}/On`);
  const spineButton = (i) => {
    const bg = walk(settingsHost).find((e) => e.dataset.path === `Rows/Spine/Opt_${i}/BG`);
    const [l, t] = NGUI.rect(bg);
    return walk(settingsHost).find((e) => e.tagName === "BUTTON" && e.style.left === `${l}px` && e.style.top === `${t}px`);
  };
  try {
    await Settings.open((key, next) => changes.push([key, next.spineConsent]));
    button(S("settings.tab.general"))?.click();
    await until(() => selected(1), "Spine refusal selected");
    const rows = walk(settingsHost).map((e) => e.dataset.path).filter((p) => /^Rows\/[^/]+$/.test(p));
    assert.equal(rows[rows.indexOf("Rows/Cache") + 1], "Rows/PreviewCache");
    assert.equal(rows[rows.indexOf("Rows/PreviewCache") + 1], "Rows/Spine");
    const before = called("app.spineConsent").length;
    spineButton(0).click();
    await drawn(consent, "ok");
    assert.equal(called("app.spineConsent").length, before, "the settings radio opens the confirmation");
    action(consent, "cancel").click();
    await until(() => consent.hidden && selected(1), "Spine still refused");
    spineButton(0).click();
    (await drawn(consent, "ok")).click();
    await until(() => selected(0), "Spine confirmed");
    globalThis.spine = {};
    assert.equal(await Runtime.ensureSpine(), true);
    spineButton(1).click();
    await until(() => selected(1), "Spine withdrawn");
    assert.equal(prefs.spineConsent, false);
    assert.equal(Runtime.spineAllowed(), true, "an already loaded runtime remains usable this session");
    const title = walk(settingsHost).find((e) => e.dataset.path === "Rows/Spine/Title");
    assert.equal(title.textContent.replaceAll("\n", " "), S("settings.spine.restart"));
    assert.deepEqual(changes, [["spineConsent", false], ["spineConsent", true], ["spineConsent", false]]);
    assert.ok(walk(settingsHost).every((e) => !e.title && !e.getAttribute("title")));
  } finally {
    button(S("display.close"))?.click();
    globalThis.spine = previousSpine;
    for (const key of Object.keys(answers)) delete answers[key];
    Object.assign(answers, saved);
  }
});
