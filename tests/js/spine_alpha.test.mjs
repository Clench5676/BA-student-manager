import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { loadPlayer } from "../../src/ba_modding_toolkit/web/js/spine-load.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const near = (values, expected) => values.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6));

test("portrait and lobby loads retain 0.2.0 straight blending even when atlas pages declare PMA", async () => {
  for (const core of ["hero_spr", "hero_home", "np0032_npc", "arona_workpage_daytime"]) {
    for (const pma of [false, true, undefined]) {
      const draw = () => {}, batchDraw = () => {}, setBlendMode = () => {};
      const sr = { draw, premultipliedAlpha: false }, batcher = { draw: batchDraw, setBlendMode };
      const p = { sceneRenderer: { skeletonRenderer: sr, batcher }, dispose() {},
        assetManager: { get: () => ({ pages: [{ texture: {}, pma }] }) } };
      const load = loadPlayer((config) => { p.config = config; return p; }, {
        skeleton: `${core}.skel`, atlas: `${core}.atlas`, premultipliedAlpha: false,
        success() {
          assert.equal(sr.draw, draw);
          assert.equal(batcher.draw, batchDraw);
          assert.equal(batcher.setBlendMode, setBlendMode);
          assert.equal(sr.premultipliedAlpha, false);
        },
      });
      try {
        p.config.success(p);
        assert.equal(await load.ready, p);
        assert.equal(p.config.premultipliedAlpha, false);
      } finally { load.dispose(); }
    }
  }
});

test("the memorial lobby caller selects the 0.2.0 PMA flag", () => {
  const source = read("../../src/ba_modding_toolkit/web/js/lobby.js");
  const code = source.slice(source.indexOf("function makePlayer("), source.indexOf("// A loaded player in linear light"));
  const env = { document: { createElement: () => ({}) }, Stage: { make: (_share, make) => make() },
    spine: { SpinePlayer: class { constructor(_div, config) { this.config = config; } } },
    current: null, game: () => ({}), layerViewport: () => ({}),
    loadPlayer: (create, config) => create(config) };
  const make = new Function("env", `const { ${Object.keys(env).join(", ")} } = env; ${code}; return makePlayer;`)(env);
  const p = make({ appendChild() {} }, { name: "hero_home", spine: "/hero_home" });
  assert.equal(p.config.premultipliedAlpha, false);
});

test("the bundled renderer keeps 0.2.0 edge colours and declared slot blends across atlas PMA flags", () => {
  const context = vm.createContext({ console, TextDecoder, TextEncoder, Float32Array, Uint8Array, Uint16Array,
    Int16Array, Int32Array, ArrayBuffer, DataView });
  vm.runInContext(read("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js"), context);
  const S = context.spine;
  for (const flag of ["", "pma: true\n", "pma: false\n"]) {
    const atlas = new S.TextureAtlas(`edge.png\nsize: 2,1\n${flag}edge\n  bounds: 0,0,2,1\n`);
    atlas.setTextures({ get: () => ({ getImage: () => ({ width: 2, height: 1 }), setFilters() {}, setWraps() {} }) });
    const modes = ["normal", "additive", "multiply", "screen"];
    const data = new S.SkeletonJson(new S.AtlasAttachmentLoader(atlas)).readSkeletonData({
      skeleton: { spine: "4.2.33" }, bones: [{ name: "root" }],
      slots: modes.map((blend) => ({ name: blend, bone: "root", attachment: "edge", color: "ffffff80", blend })),
      skins: [{ name: "default", attachments: Object.fromEntries(modes.map((mode) => [mode, { edge: { width: 2, height: 1 } }])) }],
    });
    const sr = new S.SkeletonRenderer({}, true), sk = new S.Skeleton(data), calls = [], blends = [];
    sr.premultipliedAlpha = false;
    sk.updateWorldTransform(S.Physics.update);
    sr.draw({ setBlendMode: (mode, pma) => blends.push([mode, pma]),
      draw: (_texture, vertices) => calls.push(Array.from(vertices)) }, sk);
    assert.deepEqual(blends, modes.map((_, i) => [i, false]));
    for (const vertices of calls) near(vertices.slice(2, 6), [1, 1, 1, 128 / 255]);
    // A normal edge uses the same straight texture and vertex alpha as 0.2.0, regardless of page.pma.
    const edge = [200, 100, 50, 128].map((v) => v / 255);
    near(edge.slice(0, 3).map((c, i) => c * calls[0][i + 2] * edge[3] * calls[0][5]),
      edge.slice(0, 3).map((c) => c * edge[3] * 128 / 255));
  }
});
