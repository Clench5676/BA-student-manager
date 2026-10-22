import assert from "node:assert/strict";
import { test } from "node:test";
import { controls, insert, n, spr, lbl } from "./control_prefabs.mjs";

class El {
  constructor() { this.children = []; this.style = {}; this.dataset = {}; this.attrs = {}; this.isConnected = true; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  get childNodes() { return this.children; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getContext() { return { measureText: (text) => ({ width: text.length * 16 }), drawImage() {}, fillRect() {} }; }
  toBlob(fn) { fn(new Blob()); }
  querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]); }
}
globalThis.document = { createElement: () => new El(), documentElement: { lang: "en-US" } };
Object.defineProperty(globalThis, "navigator", { value: { platform: "Mac" }, configurable: true });
globalThis.addEventListener = () => {};
let decodeHold = null;
globalThis.Image = class {
  naturalWidth = 8; naturalHeight = 8;
  set src(value) { this.url = value; queueMicrotask(() => this.onload?.()); }
  decode() { return decodeHold || Promise.resolve(); }
};
const { option, filter } = controls();
const collection = n("UICharacterCollection");
const segments = ["All", "Support"].map((name) => n(name, [0, 0], [], [
  n("Btn_Normal", [0, 0], [spr("Common_Filter_Tab_Type1", 328, 104, { color: "#f0f8fa/0.95" })],
    [n("Caption", [0, 4], [{ texture: name, color: name === "All" ? "#000000/1.00" : "#006bff/1.00", depth: 9 }])]),
  n("Btn_Pressed", [0, 2.6], [spr("Common_Filter_Tab_Type1_Pressed", 324, 99, { color: "#153757/1.00" })],
    [n("Caption", [0, 1.4], [{ texture: name, color: "#ffffff/1.00", depth: 9 }])]),
]));
insert(collection, "SeletControl/TopMenu/FilterBtn", n("FilterBtn", [0, 0], [], segments));
insert(collection, "SeletControl/TopMenu/SortBtn/Btn_Normal", n("Btn_Normal", [0, 0], [spr("Common_Bg_Raius5px_Shadow", 456, 116, { type: 1, incline: 10 })]));
insert(collection, "SeletControl/List/Scroll Bar", n("Scroll Bar", [0, 0], [], [
  n("Background", [1391, 0], [{ texture: "Scroll", w_: 126, h_: 990, depth: 3, color: "#ccd7df/1.00" }]),
  n("Foreground", [1391, 0], [{ texture: "Scroll", w_: 126, h_: 990, depth: 4, color: "#92a6b7/1.00" }]),
]));
globalThis.fetch = async (url) => ({ ok: true, json: async () => {
  if (url.endsWith("atlases.json")) return { Common: { Common_Btn_BG: { width: 8, height: 8 } } };
  if (url.endsWith("textures.json")) return { Scroll: "scroll.png" };
  if (url.includes("UICharacterCollection")) return collection;
  if (url.includes("UIPopup_Option_PC")) return option;
  if (url.includes("UIPopup_FilterSort")) return filter;
  throw new Error(url);
} });
const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
const Buttons = await import("../../src/ba_modding_toolkit/web/js/game-buttons.js");
const { resizeButton } = await import("../../src/ba_modding_toolkit/web/js/button-layout.js");
const { navigationEntry } = await import("../../src/ba_modding_toolkit/web/js/navigation-layout.js");
const { pickerItems, orderBody } = await import("../../src/ba_modding_toolkit/web/js/roster-widgets.js");
const { scrollbar } = await import("../../src/ba_modding_toolkit/web/js/scrollbar.js");
const Popup = await import("../../src/ba_modding_toolkit/web/js/popup.js");
const find = NGUI.find;
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test("option and disabled buttons retain both prefab decorations and their state colours", () => {
  const before = structuredClone({ option, filter });
  for (const enabled of [true, false]) {
    const tree = Buttons.optionButton(option, filter, "Action", 20, 30, "Change", { w: 230, h: 96, enabled });
    const body = enabled ? tree : find(tree, "BG (1)");
    assert.equal(body.children.filter((child) => child.widgets.some((w) => /_Pt$/.test(w.sprite || ""))).length, 2);
    assert.equal(body.widgets.find((w) => w.sprite).color, enabled ? "#8de4ff/1.00" : "#d6d6d6/0.90");
    assert.equal(find(tree, "Label_Locale").widgets[0].color, enabled ? "#314665/1.00" : "#828282/1.00");
    assert.ok(body.children.filter((child) => child.widgets[0]?.sprite).every((child) => child.widgets[0].sprite.endsWith(enabled ? "_S_Pt" : "_C_Pt")));
  }
  assert.deepEqual({ option, filter }, before);
});

test("narrow Cancel patterns keep opposite edges and clip to the inclined body", async () => {
  const body = n("Body", [0, 0], [spr("Common_Btn_BG", 496, 177, { incline: 10 })], [
    n("Right", [125, -3.5], [spr("Common_Btn_Normal_B_C_Pt", 252, 140)]),
    n("Left", [-123.7, 17.8], [spr("Common_Btn_Normal_B_C_Pt", 252, 140, { flip: 3 })]),
  ]);
  resizeButton(body, 184);
  assert.equal(find(body, "Right").pos[0], -31);
  assert.ok(Math.abs(find(body, "Left").pos[0] - 32.3) < 1e-8);
  const { clipButtonPatterns } = await import("../../src/ba_modding_toolkit/web/js/button-layout.js");
  const element = (l, t, w, h) => ({ style: { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` } });
  const view = { nodes: new Map([["Body", { node: body, els: [element(0, 0, 184, 177)] }],
    ["Body/Left", { node: find(body, "Left"), els: [element(-2, 0, 252, 140)] }]]) };
  clipButtonPatterns(view);
  assert.match(view.nodes.get("Body/Left").els[0].style.clipPath, /^polygon\(/);
});

test("navigation fits icons in the Student slot and greys without the lock", () => {
  const grid = n("Grid", [0, 0], [], [n("Student", [100, 0], [], [
    n("Label", [1, 8], [lbl("#2c4564/1.00")]),
    n("Able", [0, 94], [spr("Common_Icon_Student", 98, 134)]),
    n("Disable", [0, 0], [], [n("Icon", [0, 94], [spr("Common_Icon_Student", 98, 134, { color: "#797979/1.00" })]), n("Lock")]),
  ])]);
  for (const grey of [false, true]) {
    const tree = navigationEntry(grid, { icon: "Common_Icon_Student" }, "Students", grey, 0);
    assert.equal(find(tree, "Able").active, !grey); assert.equal(find(tree, "Disable").active, grey);
    assert.equal(find(tree, "Able").widgets[0].h_, 80);
    assert.equal(find(tree, "Able").widgets[0].w_, 80);
    assert.equal(find(tree, "Able").widgets[0].keepAspect, true);
    assert.equal(find(tree, "Label").widgets[0].color, "#2c4564/1.00");
    assert.equal(find(tree, "Disable/Lock"), null); // classic hand-offs are not locked game content
    assert.ok(find(tree, "Disable/Icon"));
  }
});

test("picker tools select one arrow, filter search terms and change sort direction without mutating candidates", () => {
  insert(collection, "SeletControl/TopMenu/OrderBtn/Btn_Normal", n("Btn_Normal", [0, 0], [], [n("Icon_down"), n("Icon_Up")]));
  for (const ascending of [true, false]) {
    const tree = orderBody(collection, ascending);
    assert.equal(find(tree, "Icon_Up").active, ascending);
    assert.equal(find(tree, "Icon_down").active, !ascending);
  }
  const items = [{ key: "b", label: "Beta", original: "file.bundle" }, { key: "a", label: "Alpha" }];
  assert.deepEqual(pickerItems(items, { sort: "name" }).map((x) => x.key), ["a", "b"]);
  assert.deepEqual(pickerItems(items, { sort: "name", ascending: false }).map((x) => x.key), ["b", "a"]);
  assert.deepEqual(pickerItems(items, { query: "beta file" }).map((x) => x.key), ["b"]);
  assert.deepEqual(items.map((x) => x.key), ["b", "a"]);
});

test("texture scrollbars update the thumb's extent and position for native and virtual offsets", async () => {
  const host = new El(), bar = await scrollbar(host, [0, 0, 10, 100], { collection });
  bar.sync(100, 400, 150);
  const thumb = bar.children.find((el) => el.dataset.path === "Scroll Bar/Foreground");
  assert.equal(thumb.style.height, "25px"); assert.equal(thumb.style.top, "37.5px");
  assert.ok(thumb.style.backgroundImage);
  bar.sync(100, 100, 0); assert.equal(bar.hidden, true);
});

test("horizontal scrollbar turns the complete collection prefab and synchronizes its thumb", async () => {
  const before = structuredClone(collection), host = new El();
  const bar = await scrollbar(host, [20, 30, 400, 10], { collection, horizontal: true });
  assert.equal(bar.style.left, "20px"); assert.equal(bar.style.top, "40px");
  assert.equal(bar.style.width, "10px"); assert.equal(bar.style.height, "400px");
  assert.equal(bar.style.transform, "rotate(-90deg)"); assert.equal(bar.style.transformOrigin, "top left");
  const parts = ["Background", "Foreground"].map((name) => bar.children.find((el) => el.dataset.path === `Scroll Bar/${name}`));
  for (const part of parts) assert.ok(part.style.backgroundImage, "the prefab texture is retained");
  bar.sync(400, 1600, 0);
  assert.equal(parts[1].style.height, "100px"); assert.equal(parts[1].style.top, "0px");
  bar.sync(400, 1600, 600); assert.equal(parts[1].style.top, "150px");
  bar.sync(400, 1600, 1200); assert.equal(parts[1].style.top, "300px");
  bar.sync(400, 400); assert.equal(bar.hidden, true);
  assert.deepEqual(collection, before, "the source prefab is not mutated");
});

test("a live popup publishes its labels, body and backdrop together after decode", async () => {
  let release;
  decodeHold = new Promise((resolve) => { release = resolve; });
  const host = new El(), tree = n("Center", [0, 0], [], [n("Popup", [0, 0], [spr("Common_Btn_BG")], [n("Title", [0, 0], [lbl()])])]);
  const drawing = NGUI.render(tree, host);
  await flush(); assert.equal(host.children.length, 0);
  release(); await drawing; decodeHold = null;
  assert.equal(host.children.length, 2);
});

test("shared popup reveal waits for all content and leaves a closed layer hidden", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const layer = new El(), host = new El();
  Popup.opened(host, null, { el: layer, loading: true });
  const showing = Popup.reveal(layer, [pending]);
  assert.equal(layer.style.visibility, "hidden"); assert.equal(layer.inert, true);
  await flush(); assert.equal(layer.style.visibility, "hidden");
  layer.isConnected = false; release(); assert.equal(await showing, false);
  assert.equal(layer.style.visibility, "hidden");
  Popup.closed(host, layer);
});


test("a failed popup body never publishes a title over the underlying page", async (t) => {
  t.mock.method(console, "error", () => {});
  const host = new El(), tree = n("Center", [0, 0], [], [n("Popup", [0, 0], [], [
    n("Base", [0, 0], [], [n("BG", [0, 0], [spr("MissingBody")], [n("Title", [0, 0], [lbl()])])]),
  ])]);
  await assert.rejects(NGUI.render(tree, host), /Popup frame unavailable/);
  assert.equal(host.children.length, 0);
});
