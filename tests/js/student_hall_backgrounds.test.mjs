import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

let payload, rendered = [], tints = [], loads = [];
const makeElement = () => ({ style: {}, dataset: {}, children: [], replaceChildren(...children) { this.children = children; } });
globalThis.document = { createElement: makeElement };
globalThis.hallBackgroundHarness = {
  NGUI: {
    load: async (url) => { loads.push(url); return makeElement(); },
    tinted: async (url, tint) => { tints.push([url, tint]); return `${url}?tint=${tint.slice(1)}`; },
    render: async (tree, target, options) => {
      const nodes = new Map();
      function visit(node, parent = "") {
        if (node.active === false) return;
        const path = parent ? `${parent}/${node.name}` : node.name;
        const els = (node.widgets || []).filter((w) => w.texture).map((w) => ({ style: {
          backgroundImage: 'url("downsampled")', opacity: (w.color || "#ffffff/1").split("/")[1],
          zIndex: String(w.depth || 0), left: "12px", top: "18px", width: "100px", height: "80px" }, dataset: {} }));
        nodes.set(path, { node, els });
        for (const child of node.children || []) visit(child, path);
      }
      visit(tree); rendered.push({ tree, target, options, nodes }); return { pictures: [], nodes };
    },
  },
  withTimeout: (promise) => promise,
};
let source = await readFile(new URL("../../src/ba_modding_toolkit/web/js/student-hall-backgrounds.js", import.meta.url), "utf8");
source = source.replace(/^import .*;$/gm, "");
source = `const {NGUI, withTimeout} = globalThis.hallBackgroundHarness; const S = 1920 / 2960; const T = (key) => key;\n${source}`;
const Hall = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const day = { name: "office-day", layoutUrl: "/asset/office/day/layout.json" };
const night = { name: "office-night", layoutUrl: "/asset/office/night/layout.json" };
const collection = { name: "BG_School_Collection", url: "/asset/art/bg/BG_School_Collection" };

test("office day is the unsaved default while explicit saved backgrounds and partial installs are preserved", () => {
  assert.equal(Hall.backgroundChoice("", [collection, night, day]), day);
  assert.equal(Hall.backgroundChoice(collection.name, [day, collection]), collection);
  assert.equal(Hall.backgroundChoice(night.name, [day, night]), night);
  assert.equal(Hall.backgroundChoice("office-day", [collection]), collection);
  assert.equal(Hall.backgroundChoice("", []), null);
});

test("office rendering retains exact ancestor geometry, layer depths and per-widget tints", async () => {
  const before = globalThis.fetch;
  rendered = []; tints = []; loads = [];
  const tree = { name: "LobbyCommon", active: true, pos: [24, -12], scale: [1.2, 1.2], widgets: [], children: [
    { name: "UILobbyBackground_Day", active: true, pos: [10, 22], scale: [2, 2], widgets: [], children: [
      { name: "Sky", active: true, pos: [4, 8], scale: [1, 1], widgets: [{ texture: "Sky", depth: -40, color: "#aabbcc/0.75", w_: 4400, h_: 2200 }] },
      { name: "Front", active: true, pos: [8, 12], scale: [1, 1], widgets: [{ texture: "Front", depth: -5, color: "#ffffff/1.00", w_: 3000, h_: 1440 }] },
      { name: "InactiveSeason", active: false, widgets: [], children: [{ name: "Missing", active: true, widgets: [{ texture: "MissingSeasonalImage" }] }] },
    ] },
  ] };
  payload = { tree, textures: { Sky: "/sky.png", Front: "/front.png" } };
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    await Hall.layers(day, makeElement(), { signal: new AbortController().signal });
    assert.equal(rendered[0].tree, tree);
    assert.deepEqual(tree.pos, [24, -12]);
    assert.equal(tree.children[0].children[0].widgets[0].depth, -40);
    assert.equal(loads.includes("MissingSeasonalImage"), false, "inactive branches require no image");
    assert.deepEqual(tints, [["/sky.png", "#aabbcc"], ["/front.png", "#ffffff"]]);
    assert.equal(rendered[0].options.textures["LobbyCommon/UILobbyBackground_Day/Sky"], "/sky.png?tint=aabbcc");
    assert.deepEqual(rendered[0].options.origin, [960, 540]);
  } finally { globalThis.fetch = before; }
});

test("a missing office asset falls back to an available collection without erasing the saved choice", async () => {
  const before = globalThis.fetch, warn = console.warn;
  globalThis.fetch = async () => ({ ok: false, status: 404 }); console.warn = () => {};
  const target = makeElement();
  try {
    await Hall.render(day, target, { signal: new AbortController().signal, choices: [day, collection] });
    assert.equal(target.dataset.background, collection.name);
    assert.equal(target.children.length, 1);
    assert.equal(day.name, "office-day");
  } finally { globalThis.fetch = before; console.warn = warn; }
});

test("late office metadata cannot render after navigation cancellation", async () => {
  const before = globalThis.fetch, controller = new AbortController(); let release;
  rendered = [];
  globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
  try {
    const pending = Hall.layers(day, makeElement(), { signal: controller.signal });
    controller.abort(); release({ ok: true, json: async () => payload });
    assert.equal(await pending, null); assert.deepEqual(rendered, []);
  } finally { globalThis.fetch = before; }
});

test("Night light preserves authored alpha and uses the actual additive pass in scene and picker", async () => {
  const before = globalThis.fetch;
  const material = { shader: "Unlit/Transparent Colored Additive", src: 5, dst: 1, srcA: 5, dstA: 1, op: 0, opA: 0, mask: 15 };
  const tree = { name: "Night", widgets: [], children: [
    { name: "Sky", widgets: [{ texture: "Sky", depth: -10, color: "#ffffff/1.00" }] },
    { name: "Light_1", widgets: [{ texture: "Light", depth: 20, color: "#d9ebff/0.45", material }] },
  ] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tree, textures: { Sky: "/sky.png", Light: "/light.png" } }) });
  try {
    const target = makeElement(), view = await Hall.layers(night, target);
    assert.equal(target.style.overflow, "hidden", "native layers clip to the same viewport as the canvas preview");
    const light = view.nodes.get("Night/Light_1").els[0];
    assert.equal(light.style.mixBlendMode, "plus-lighter");
    assert.equal(light.style.opacity, "0.45");
    assert.equal(light.style.backgroundImage, 'url("/light.png?tint=d9ebff")');
    const drawn = [], context = { save() {}, restore() {}, translate() {}, drawImage() {
      drawn.push({ mode: this.globalCompositeOperation, alpha: this.globalAlpha });
    } };
    await Hall.paint(view, context);
    assert.deepEqual(drawn, [{ mode: "source-over", alpha: 1 }, { mode: "lighter", alpha: .45 }]);
    // On an opaque scene SrcAlpha/One leaves black light pixels unchanged; source-over darkens them.
    const backdrop = .4, alpha = .45, black = 0;
    assert.equal(black * alpha + backdrop, backdrop);
    assert.notEqual(black * alpha + backdrop * (1 - alpha), backdrop);
  } finally { globalThis.fetch = before; }
});

test("unsupported shader programs or operations fail instead of silently changing their blend", () => {
  for (const material of [
    { shader: "Unlit/Transparent Colored Additive", src: 5, dst: 1, op: 1 },
    { shader: "Custom/Distortion", src: 5, dst: 1 },
    { shader: "Unlit/Transparent Colored", src: 1, dst: 10 },
    { shader: "Unlit/Transparent Colored", src: 5, dst: 10, srcA: 1, dstA: 10 },
  ]) assert.throws(() => Hall.blending(material), /Unsupported office shader/);
});

test("a cancelled staged render never publishes unfinished background layers", async () => {
  const fetchBefore = globalThis.fetch, renderBefore = globalThis.hallBackgroundHarness.NGUI.render;
  const controller = new AbortController(), target = makeElement(), previous = makeElement();
  target.replaceChildren(previous);
  let release, renderedInto;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tree: { name: "Office", widgets: [], children: [] }, textures: {} }) });
  globalThis.hallBackgroundHarness.NGUI.render = async (...args) => {
    renderedInto = args[1];
    const view = await renderBefore(...args);
    return new Promise((resolve) => { release = () => resolve(view); });
  };
  try {
    const pending = Hall.layers(day, target, { signal: controller.signal });
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    assert.ok(release);
    assert.notEqual(renderedInto, target);
    assert.deepEqual(target.children, [previous]);
    controller.abort(); release();
    assert.equal(await pending, null);
    assert.deepEqual(target.children, [previous]);
  } finally { globalThis.fetch = fetchBefore; globalThis.hallBackgroundHarness.NGUI.render = renderBefore; }
});
