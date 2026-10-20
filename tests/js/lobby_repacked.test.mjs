// Real bundled Spine parsing and posing, with synthetic repacked art and no browser or game install.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { artBounds, containingView, overlaps, resumeRest, settle, validRect, worldBounds } from "../../src/ba_modding_toolkit/web/js/lobby-health.js";
import { lobbyIdle } from "../../src/ba_modding_toolkit/web/js/rest-pose.js";
import * as Lobby from "../../src/ba_modding_toolkit/web/js/lobby.js";
import * as Pins from "../../src/ba_modding_toolkit/web/js/skeleton-pins.js";

const context = vm.createContext({ console, TextDecoder, TextEncoder, Float32Array, Uint8Array, Uint16Array, Int16Array, Int32Array, ArrayBuffer, DataView });
vm.runInContext(readFileSync(new URL("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js", import.meta.url), "utf8"), context);
globalThis.spine = context.spine;
const fixture = (name, extension) => readFileSync(new URL(`../fixtures/lobby/${name}.${extension}`, import.meta.url), "utf8");
function player(name, change = () => {}) {
  const atlas = new spine.TextureAtlas(fixture(name, "atlas"));
  atlas.setTextures({ get: () => ({ getImage: () => ({ width: 64, height: 64 }), setFilters() {}, setWraps() {} }) });
  const json = JSON.parse(fixture(name, "json"));
  change(json);
  const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(json);
  return { skeleton: new spine.Skeleton(data), animationState: new spine.AnimationState(new spine.AnimationStateData(data)), atlas };
}
const layer = () => ({ name: "shun_home", x: 0, y: -962, scale: 1 });
const rect = (v) => ({ x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.h });

test("official and repacked atlas syntax and patch versions pose real drawable attachments", () => {
  for (const name of ["official", "repacked"]) {
    const p = player(name), l = layer();
    assert.equal(settle(p, l, { idle: { shun_home: "Idle_01" } }, Pins.pin), name === "official" ? "Idle_01" : "RestLoop");
    assert.ok(p.animationState.getCurrent(0));
    assert.ok(validRect(artBounds(p.skeleton)));
    assert.equal(p.atlas.pages[0].name, name === "official" ? "hero.png" : "Repacked/Art.PNG");
  }
});

test("an old skeleton version fails explicitly, while any compatible 4.2 patch is accepted", () => {
  const p = player("repacked", (json) => { json.skeleton.spine = "3.8.75"; });
  assert.throws(() => settle(p, layer(), {}, Pins.pin), /Unsupported lobby Spine version: 3.8.75/);
});

test("an idle that exists but hides its attachments falls back to drawable repacked art", () => {
  const p = player("repacked", (json) => {
    json.animations.Idle_01 = { slots: { art: { attachment: [{ name: null }] } } };
  });
  assert.equal(lobbyIdle(p.skeleton.data), "Idle_01", "name selection alone cannot detect the hidden art");
  assert.equal(settle(p, layer(), {}, Pins.pin), "RestLoop");
});

test("a static lobby keeps a live base track and an entirely empty lobby fails", () => {
  const p = player("official", (json) => { json.animations = {}; }), l = layer();
  assert.equal(settle(p, l, {}, Pins.pin), null);
  assert.equal(p.animationState.getCurrent(0).animation.name, "<empty>");
  assert.equal(p.animationState.getCurrent(0).trackEnd, Infinity);
  assert.ok(artBounds(p.skeleton));
  const empty = player("repacked", (json) => { json.animations = {}; });
  assert.throws(() => settle(empty, layer(), {}, Pins.pin), /No drawable lobby pose/);
});

test("the settled idle resumes when a timeline has emptied or removed its base track", () => {
  for (const empty of [false, true]) {
    const p = player("repacked"), l = layer();
    settle(p, l, {}, Pins.pin);
    if (empty) {
      p.animationState.setEmptyAnimation(0, 0);
      for (let i = 0; i < 2; i++) { p.animationState.update(1); p.animationState.apply(p.skeleton); }
    }
    else p.animationState.clearTracks();
    resumeRest(p, l);
    assert.equal(p.animationState.getCurrent(0).animation.name, "RestLoop");
  }
});

test("repacked bounds and prefab scale frame posed vertices, independent of the export bounds", () => {
  const p = player("repacked"), l = { ...layer(), x: 1e6, y: -1e6, scale: 0.01 };
  settle(p, l, {}, Pins.pin);
  const bounds = worldBounds(l.rest.bounds, l), view = containingView(bounds);
  assert.ok(overlaps(bounds, rect(view)));
  assert.ok(Math.abs(view.w - 3.2) < 1e-8);
  for (const scale of [0, -1, NaN, Infinity]) assert.throws(() => worldBounds(l.rest.bounds, { ...l, scale }), /Invalid lobby transform/);
});

test("the full lobby measurement frames renamed idle art beyond the official camera and clamps a stale touch bone", () => {
  const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/lobby.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("const CELL ="), source.indexOf("// switch between the left view"))
    .replaceAll("export function", "function").replaceAll("export const", "const");
  const G = { x: -1480, y: -832.5, w: 2960, h: 1665 };
  const env = { GAME: G, game: () => ({ ...G }), spine, Pins, idleOf: Lobby.idleOf,
    artBounds, containingView, overlaps, validRect, worldBounds, rectOf: rect,
    union: (a, b) => ({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) }),
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)) };
  const measure = new Function("env", `const { ${Object.keys(env).join(", ")} } = env;
    const current = { info: {} }; let mode = "left";
    ${code}
    return measure;`)(env);
  for (const name of ["official", "repacked"]) {
    const p = player(name), l = layer();
    settle(p, l, {}, Pins.pin);
    const m = measure([{ ...l, player: p }]), bounds = worldBounds(l.rest.bounds, l);
    assert.ok(overlaps(bounds, rect(m.left)), `${name}: left view intersects the art`);
    assert.ok(overlaps(bounds, rect(m.full)), `${name}: fullscreen intersects the art`);
    assert.ok(m.touch.x >= bounds.x0 && m.touch.x <= bounds.x1);
    assert.ok(m.touch.y >= bounds.y0 && m.touch.y <= bounds.y1);
  }
});

test("stale pins and skin names cannot erase otherwise drawable repacked art", () => {
  const p = player("repacked"), l = { ...layer(), skin: "official-only" };
  settle(p, l, { pins: [{ skeleton: l.name, bone: "root", scaleX: 0, scaleY: 0 }] }, Pins.pin);
  assert.equal(l.ignorePins, true);
  assert.equal(l.skin, null);
  assert.ok(artBounds(p.skeleton));
});

test("renamed art joins a retained background; missing or ambiguous pairs fail with the source URL", async () => {
  const previous = globalThis.fetch;
  let files = ["shun_bg.skel", "shun_bg.atlas", "Repacked.skel", "ArtBook.atlas"];
  const info = { main: "shun_home", layers: [
    { name: "shun_bg", active: true, x: 0, y: -962, scale: 1, order: 0 },
    { name: "shun_home", active: true, x: 0, y: -962, scale: 1, order: 1 },
  ] };
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(url); return { ok: true, json: async () => url.endsWith("files.json") ? files : info }; };
  try {
    const result = await Lobby.layersOf("shun_home", null, { artBase: "/art/revision/", base: "/layout/revision/" });
    assert.deepEqual(result.layers.map((l) => l.name), ["shun_bg", "Repacked"]);
    assert.equal(result.layers[1].atlas, "/art/revision/ArtBook.atlas");
    files = ["shun_bg.skel", "shun_bg.atlas"];
    await assert.rejects(Lobby.layersOf("shun_home", null, { artBase: "/art/", base: "/layout/" }), /Missing lobby layers: shun_home/);
    files = ["A.skel", "B.skel", "Unknown.atlas"];
    await assert.rejects(Lobby.layersOf("shun_home", null, { artBase: "/art/", base: "/layout/" }), /No unambiguous lobby atlas/);
    assert.ok(requests.includes("/art/revision/files.json"));
  } finally { globalThis.fetch = previous; }
});
