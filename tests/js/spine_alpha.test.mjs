import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { applyAtlasAlpha, atlasAlpha } from "../../src/ba_modding_toolkit/web/js/spine-alpha.js";
import { loadPlayer } from "../../src/ba_modding_toolkit/web/js/spine-load.js";

function runtime(pages, twoColorTint = false) {
  const calls = [], shader = {}, vertices = [0, 0, 0.8, 0.4, 0.2, 0.5, 0, 0];
  if (twoColorTint) vertices.push(0.2, 0.4, 0.6, 0);
  const batcher = { shader, setBlendMode(mode, pma) { calls.push(["blend", mode, pma]); },
    draw(tex, v) { calls.push(["draw", tex.name, Array.from(v)]); } };
  const sr = { premultipliedAlpha: false, twoColorTint,
    draw(b) {
      b.setBlendMode(0, false);
      for (const page of pages) b.draw(page.texture, new Float32Array(vertices), [0]);
    } };
  return { calls, vertices, config: { atlas: "asset.atlas", premultipliedAlpha: false },
    assetManager: { get(name) { assert.equal(name, "asset.atlas"); return { pages }; } },
    sceneRenderer: { skeletonRenderer: sr, batcher, batcherShader: shader }, dispose() {} };
}
const page = (name, pma) => ({ name, pma, texture: { name } });
const near = (values, expected) => values.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6));

test("each asset uses its own atlas: special L2D, portraits and memorial lobbies", () => {
  for (const name of ["aoi_workpage", "arona_workpage_daytime", "plana_workpage", "cafe", "hero_spr", "hero_home"]) {
    for (const pma of [false, true, undefined]) {
      const pg = page(name, pma), p = runtime([pg]), sr = p.sceneRenderer.skeletonRenderer, draw = sr.draw;
      assert.equal(atlasAlpha(p).get(pg.texture), !!pma);
      assert.equal(applyAtlasAlpha(p), !!pma);
      if (!pma) assert.equal(sr.draw, draw, "already-correct straight assets keep their renderer");
      sr.draw(p.sceneRenderer.batcher);
      assert.deepEqual(p.calls.filter((c) => c[0] === "blend").at(-1), ["blend", 0, !!pma]);
      near(p.calls.at(-1)[2].slice(2, 6), pma ? [0.4, 0.2, 0.1, 0.5] : [0.8, 0.4, 0.2, 0.5]);
    }
  }
});

test("mixed atlas pages switch alpha independently and preserve two-colour tint and slot blend modes", () => {
  const pages = [page("PMA", true), page("straight", false), page("PMA2", true)], p = runtime(pages, true);
  const b = p.sceneRenderer.batcher, sr = p.sceneRenderer.skeletonRenderer;
  sr.draw = function (batcher) {
    for (const mode of [0, 1, 2, 3]) {
      batcher.setBlendMode(mode, false);
      for (const pg of pages) batcher.draw(pg.texture, new Float32Array(p.vertices), [0]);
    }
  };
  applyAtlasAlpha(p);
  const ownBlend = b.setBlendMode;
  sr.draw(b);
  assert.equal(b.setBlendMode, ownBlend);
  for (let mode = 0; mode < 4; mode++) {
    const calls = p.calls.slice(mode * 7, (mode + 1) * 7);
    assert.deepEqual(calls.filter((c) => c[0] === "blend"), [
      ["blend", mode, false], ["blend", mode, true], ["blend", mode, false], ["blend", mode, true]]);
    near(calls[2][2].slice(8), [0.1, 0.2, 0.3, 1]);
    near(calls[4][2].slice(8), [0.2, 0.4, 0.6, 0]);
  }
});

test("ported lobby shaders keep their own vertices and blend, including hooks installed after alpha setup", () => {
  const pg = page("PMA", true), p = runtime([pg]);
  applyAtlasAlpha(p);
  const b = p.sceneRenderer.batcher, draw = b.draw, blend = b.setBlendMode;
  b.setBlendMode = function (mode, pma) { return blend.call(this, mode === 3 ? 0 : mode, pma); };
  b.draw = function (...args) { this.shader = "ported"; return draw.apply(this, args); };
  const hookedBlend = b.setBlendMode;
  p.sceneRenderer.skeletonRenderer.draw(b);
  assert.equal(b.setBlendMode, hookedBlend);
  assert.deepEqual(p.calls.filter((c) => c[0] === "blend"), [["blend", 0, false]]);
  near(p.calls.at(-1)[2], p.vertices);
});

test("the managed loader applies atlas alpha before the first success hook and draw", async () => {
  const p = runtime([page("Aoi", true)]);
  const load = loadPlayer((config) => { p.config = config; return p; }, { atlas: "asset.atlas", success(player) {
    player.sceneRenderer.skeletonRenderer.draw(player.sceneRenderer.batcher);
  } });
  p.config.success(p);
  assert.equal(await load.ready, p);
  assert.deepEqual(p.calls.filter((c) => c[0] === "blend").at(-1), ["blend", 0, true]);
  load.dispose();
});

test("the bundled renderer draws a known semi-transparent edge with one alpha multiplication", () => {
  const context = vm.createContext({ console, TextDecoder, TextEncoder, Float32Array, Uint8Array, Uint16Array,
    Int16Array, Int32Array, ArrayBuffer, DataView });
  vm.runInContext(readFileSync(new URL("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js", import.meta.url), "utf8"), context);
  const S = context.spine;
  const atlas = new S.TextureAtlas("PMA.png\nsize: 2,1\npma: true\nPMA\n  bounds: 0,0,2,1\n\nStraight.png\nsize: 2,1\npma: false\nStraight\n  bounds: 0,0,2,1\n");
  atlas.setTextures({ get: (name) => ({ name, getImage: () => ({ width: 2, height: 1 }), setFilters() {}, setWraps() {} }) });
  const data = new S.SkeletonJson(new S.AtlasAttachmentLoader(atlas)).readSkeletonData({
    skeleton: { spine: "4.2.33" }, bones: [{ name: "root" }],
    slots: ["PMA", "Straight"].map((name) => ({ name, bone: "root", attachment: name, color: "ffffff80" })),
    skins: [{ name: "default", attachments: Object.fromEntries(["PMA", "Straight"].map((name) => [name, { [name]: { width: 2, height: 1 } }])) }],
  });
  const p = runtime(atlas.pages, true), sr = new S.SkeletonRenderer({}, true), sk = new S.Skeleton(data);
  p.sceneRenderer.skeletonRenderer = sr;
  sk.updateWorldTransform(S.Physics.update);
  applyAtlasAlpha(p);
  sr.draw(p.sceneRenderer.batcher, sk);
  const calls = p.calls.filter((c) => c[0] === "draw"), a = 128 / 255;
  near(calls[0][2].slice(2, 6), [a, a, a, a]);
  near(calls[1][2].slice(2, 6), [1, 1, 1, a]);
  const normal = (texel, light, pma) => texel.slice(0, 3).map((c, i) => c * light[i] * (pma ? 1 : texel[3] * light[3]));
  const edge = [0.8, 0.4, 0.2, a], premultiplied = edge.map((v, i) => i < 3 ? v * a : v);
  const pm = normal(premultiplied, calls[0][2].slice(2, 6), true), straight = normal(edge, calls[1][2].slice(2, 6), false);
  near(pm, straight);
  // The previous forced-straight draw multiplied the stored PMA texel by alpha again, darkening the outline.
  assert.ok(normal(premultiplied, [1, 1, 1, a], false)[0] < pm[0]);
});
