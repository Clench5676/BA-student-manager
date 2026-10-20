import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { isSpecial, specialFraming, specialView } from "../../src/ba_modding_toolkit/web/js/special-view.js";
import { artBounds, settle, validRect, worldBounds } from "../../src/ba_modding_toolkit/web/js/lobby-health.js";
import { layersOf } from "../../src/ba_modding_toolkit/web/js/lobby.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const context = vm.createContext({ console, TextDecoder, TextEncoder, Float32Array, Uint8Array, Uint16Array, Int16Array, Int32Array, ArrayBuffer, DataView });
vm.runInContext(read("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js"), context);
globalThis.spine = context.spine;
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
function player() {
  const atlas = new spine.TextureAtlas(read("../fixtures/lobby/official.atlas"));
  atlas.setTextures({ get: () => ({ getImage: () => ({ width: 64, height: 64 }), setFilters() {}, setWraps() {} }) });
  const json = JSON.parse(read("../fixtures/lobby/official.json"));
  Object.assign(json.skeleton, { x: -1e9, y: -1e9, width: 2e9, height: 2e9 });
  const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(json);
  const p = { skeleton: new spine.Skeleton(data), animationState: new spine.AnimationState(new spine.AnimationStateData(data)) };
  settle(p, { name: "np0032_npc" }, null, () => {});
  return p;
}
const rectOf = (v) => ({ x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.h });
const contains = (a, b) => b.x0 >= a.x0 - 1e-6 && b.y0 >= a.y0 - 1e-6 && b.x1 <= a.x1 + 1e-6 && b.y1 <= a.y1 + 1e-6;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("special NPCs use character framing and work pages, tasks and cafes use scene framing", () => {
  for (const [core, category, expected] of [
    ["np0032_npc", "spinebackground", "character"], ["arona", "spinecharacters", "character"],
    ["np0032_npc", null, "character"], ["arona_workpage_daytime", "spinebackground", "scene"],
    ["plana_workpage", "spinecharacters", "scene"], ["task", "spinelobbies", "scene"], ["cafe", "spinebackground", "scene"],
  ]) {
    const v = { key: `special:${core}`, lobby: core, spineCategory: category };
    assert.equal(isSpecial(v), true); assert.equal(specialFraming(v), expected);
  }
  assert.equal(specialFraming({ key: "ibuki", lobby: "ibuki_home" }), null);
});

test("NPCs fit wholly in the left pane and fullscreen, at any scale or origin", () => {
  for (const r of [{ x0: -100, y0: 0, x1: 100, y1: 1000 }, { x0: -1000, y0: 5, x1: 1000, y1: 500 }]) {
    for (const scale of [0.01, 1, 100]) {
      const bounds = worldBounds(r, { x: 1e6, y: -1e6, scale });
      const left = specialView(bounds, "character", 16 / 9, 0.25), full = specialView(bounds, "character");
      assert.ok(contains(rectOf({ ...left, w: left.w / 2 }), bounds), "the whole character clears the right panel");
      assert.ok(contains(rectOf(full), bounds));
      near((bounds.x0 + bounds.x1) / 2, left.x + left.w / 4);
    }
  }
});

test("scene framing fills every supported view aspect from its own bounds", () => {
  const bounds = { x0: 5000, y0: -4000, x1: 9000, y1: -2000 };
  for (const aspect of [16 / 9, 1, 404 / 456, 384 / 352]) {
    const v = specialView(bounds, "scene", aspect);
    assert.ok(contains(bounds, rectOf(v))); near(v.w / v.h, aspect);
    assert.ok(Math.abs(v.w - 4000) < 1e-6 || Math.abs(v.h - 2000) < 1e-6, "one axis reaches the art edge");
  }
  for (const bounds of [null, { x0: 0, y0: 0, x1: 0, y1: 1 }]) assert.throws(() => specialView(bounds, "character"), /bounds/);
});

test("detail and thumbnails frame real posed vertices, ignoring stale export bounds", () => {
  const lobby = read("../../src/ba_modding_toolkit/web/js/lobby.js");
  const code = lobby.slice(lobby.indexOf("function measureSpecial("), lobby.indexOf("// switch between the left view"));
  const thumbs = read("../../src/ba_modding_toolkit/web/js/thumbs.js");
  const thumbnail = new Function("spine", "specialView", "artBounds", `${thumbs.slice(thumbs.indexOf("function viewFor("), thumbs.indexOf("const frames ="))}; return viewFor;`)(spine, specialView, artBounds);
  const p = player(), layer = { name: "np0032_npc", x: 40000, y: -30000, scale: 0.01, player: p };
  const edge = worldBounds(artBounds(p.skeleton), layer);
  for (const framing of ["character", "scene"]) {
    const current = { framing };
    const measure = new Function("env", `const { current, worldBounds, artBounds, validRect, union, specialView, rectOf } = env; ${code}; return measureSpecial;`)
      ({ current, worldBounds, artBounds, validRect, union, specialView, rectOf });
    const m = measure([layer]);
    assert.deepEqual(m.full, specialView(edge, framing));
    const thumb = thumbnail(p, "roster", 404 / 456, framing), expected = specialView(artBounds(p.skeleton), framing, 404 / 456);
    assert.deepEqual([thumb.x, thumb.y, thumb.width, thumb.height], [expected.x, expected.y, expected.w, expected.h]);
    assert.ok(m.full.w < 100, "the huge export header never sets the zoom");
  }
});

test("special layers have no memorial lobby fallback offset", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({ ok: true, json: async () => url.endsWith("files.json") ? ["np0032_npc.skel", "np0032_npc.atlas"] : null }));
  const { layers } = await layersOf("np0032_npc", null, { artBase: "/art/", base: "/layout/" }, "character");
  assert.deepEqual([layers[0].x, layers[0].y, layers[0].scale], [0, 0, 1]);
});
