// Tests for the lobby's mesh renderers (web/js/mesh-fx.js and their drawing in particles-gl.js) and the skeletons' game
// materials (web/js/skeleton-materials.js), against recording stand-ins for WebGL2 and spine-player. Run by tests/test_lobby_render.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

const near = (a, b, eps = 1e-6, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} != ${b}`);
const nearAll = (a, b, eps = 1e-6, what = "") => { assert.equal(a.length, b.length, what); a.forEach((v, i) => near(v, b[i], eps, `${what}[${i}]`)); };

// --- WebGL2 and spine-player stand-ins ------------------------------------------------------------------------------

class FakeGL {}
globalThis.WebGL2RenderingContext = FakeGL;
// records every call; objects it creates stay live until deleted; uniforms are found by name ({uniform: name})
function fakeGL() {
  const calls = [], live = new Set();
  let n = 0;
  const target = Object.assign(new FakeGL(), { calls, live, drawingBufferWidth: 64, drawingBufferHeight: 32 });
  return new Proxy(target, {
    get(t, name) {
      if (name in t) return t[name];
      if (typeof name !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      return (...args) => {
        calls.push([name, ...args]);
        if (name.startsWith("create")) { const o = { kind: name.slice(6), id: ++n }; live.add(o); return o; }
        if (name.startsWith("delete")) { live.delete(args[0]); return undefined; }
        if (name === "getShaderParameter" || name === "getProgramParameter") return args[1] === "ACTIVE_UNIFORMS" ? 0 : true;
        if (name === "getUniformLocation") return { uniform: args[1] };
        if (name === "checkFramebufferStatus") return "FRAMEBUFFER_COMPLETE";
        if (name === "isContextLost") return false;
        return null;
      };
    },
  });
}
// spine's Shader: compiles its sources into a program, named after the program kind its fragment source ports
class Shader {
  static MVP_MATRIX = "u_projTrans";
  static SAMPLER = "u_texture";
  constructor(context, vs, fs) {
    this.gl = context.gl;
    this.fs = fs;
    this.name = /_PortraitNoiseTex/.test(fs) ? "portraitNoise" : /_NoiseTex/.test(fs) ? "noiseFlow" : "pma";
    this.program = this.gl.createProgram();
  }
  getProgram() { return this.program; }
  bind() { this.gl.useProgram(this.program); }
  dispose() { this.gl.deleteProgram(this.program); }
}
globalThis.spine = { BlendMode: { Normal: 0, Additive: 1, Multiply: 2, Screen: 3 }, Shader,
  PolygonBatcher: { blendModesGL: [{ srcRgb: "SRC_ALPHA", srcRgbPma: "ONE", dstRgb: "ONE_MINUS_SRC_ALPHA", srcAlpha: "ONE" },
    { srcRgb: "SRC_ALPHA", srcRgbPma: "ONE", dstRgb: "ONE", srcAlpha: "ONE" }, { srcRgb: "DST_COLOR", srcRgbPma: "DST_COLOR", dstRgb: "ONE_MINUS_SRC_ALPHA", srcAlpha: "ONE" },
    { srcRgb: "ONE", srcRgbPma: "ONE", dstRgb: "ONE_MINUS_SRC_COLOR", srcAlpha: "ONE" }] } };
globalThis.performance ??= { now: () => Date.now() };

// spine-player's PolygonBatcher, as far as the hooks lean on it: a batch flushes on a texture change and on end
class Batcher {
  constructor(gl, log) {
    Object.assign(this, { gl, log, verticesLength: 0, lastTexture: null, shader: null, isDrawing: false, srcColorBlend: 1, srcAlphaBlend: 1, dstBlend: 10 });
    this.mesh = { draw: (sh) => log.push(["pass", sh.name]) };
  }
  begin(shader) { this.shader = shader; this.isDrawing = true; this.gl.blendFuncSeparate(this.srcColorBlend, this.dstBlend, this.srcAlphaBlend, this.dstBlend); }
  setBlendMode() {}
  draw(texture, vertices) {
    if (texture !== this.lastTexture) { this.flush(); this.lastTexture = texture; }
    this.verticesLength += vertices.length;
  }
  flush() {
    if (!this.verticesLength) return;
    this.log.push(["flush", this.shader.name, this.lastTexture.name]);
    this.verticesLength = 0;
  }
  end() { this.flush(); this.isDrawing = false; }
}
class Texture {
  constructor(name) { this.name = name; this.texture = {}; this.useMipMaps = false; }
  update() {}
  getImage() { return {}; }
  bind() {}
}
// a player whose skeleton has slots [name, blend mode, page, dark colour]; its renderer draws them in order, as
// spine-player's SkeletonRenderer does (a blend mode change before a slot's triangles)
function player(gl, slots, layer) {
  const log = [], pages = {}, page = (name) => (pages[name] ??= new Texture(name));
  const data = { slots: slots.map(([name, blendMode]) => ({ name, blendMode })), skins: [] };
  const skeleton = { data, slots: [], drawOrder: [] };
  slots.forEach(([name, , pageName, dark], i) => {
    const region = { texture: page(pageName), page: { name: `${pageName}.png` } };
    const slot = { data: data.slots[i], darkColor: dark || null, attachment: { region } };
    skeleton.slots.push(slot);
    skeleton.drawOrder.push(slot);
  });
  data.skins.push({ getAttachments: () => skeleton.slots.map((s) => ({ attachment: s.attachment })) });
  const batcher = new Batcher(gl, log), batcherShader = { name: "spine", bind() { gl.useProgram("spine"); } };
  const skeletonRenderer = {
    draw(b, sk) {
      let mode = null;
      for (const slot of sk.drawOrder) {
        log.push(["dark", slot.data.name, slot.darkColor]);
        if (slot.data.blendMode !== mode) { mode = slot.data.blendMode; b.setBlendMode(mode, false); }
        b.draw(slot.attachment.region.texture, [0, 0, 0, 0], [0]);
      }
    },
  };
  const p = {
    bamtLayer: layer, skeleton, time: { totalTime: 2 }, log,
    context: { gl, restorables: [], addRestorable(r) { this.restorables.push(r); }, removeRestorable(r) { this.restorables = this.restorables.filter((x) => x !== r); } },
    sceneRenderer: { batcher, batcherShader, skeletonRenderer, camera: { update() {}, projectionView: { values: new Float32Array(16) } } },
  };
  p.frame = () => {
    log.length = 0;
    batcher.begin(batcherShader);
    skeletonRenderer.draw(batcher, skeleton);
    batcher.end();
    return log.slice();
  };
  return p;
}

const Linear = await import("../../src/ba_modding_toolkit/web/js/linear.js");
const Mesh = await import("../../src/ba_modding_toolkit/web/js/mesh-fx.js");
const GL = await import("../../src/ba_modding_toolkit/web/js/particles-gl.js");
const { STRIDE, IDENTITY } = await import("../../src/ba_modding_toolkit/web/js/particles.js");

// --- mesh-fx.js -----------------------------------------------------------------------------------------------------

test("transforms, Euler angles and clip samples as Unity has them", () => {
  // Quaternion.Euler: z first, then x, then y
  const q = Mesh.eulerQuat([90, 0, 90]);
  const m = Mesh.trs([0, 0, 0], q, [1, 1, 1]);
  // x goes to y under z 90, then stays under x 90
  nearAll([m[0], m[4], m[8]], [0, 0, 1], 1e-9, "x axis");
  nearAll(Mesh.trs([1, 2, 3], [0, 0, 0, 1], [2, 3, 4]), [2, 0, 0, 1, 0, 3, 0, 2, 0, 0, 4, 3]);
  assert.equal(Mesh.sample([0, 1, 2], 2, 0.25), 0.5);
  assert.deepEqual(Mesh.sample([[0, 0], [2, 4]], 1, 0.5), [1, 2]);
  assert.equal(Mesh.sample([7], 60, 3), 7);
  assert.equal(Mesh.sample([0, 1], 1, 5), 1, "held at the last sample");
});

function quadFx(over = {}) {
  return {
    systems: [], textures: {}, meshes: {},
    materials: { lens: { program: "lobbyOrder", src: 1, dst: 1, queue: 2950, cull: 2, tex: { _TextureSample0: { default: "white", st: [1, 1, 0, 0] } },
      floats: {}, colors: { _Color0: [1, 1, 1, 0] } } },
    renderers: [{ name: "LensDirt", path: "a/LensDirt", material: "lens", mesh: "quad", queue: 2950, order: 0, layer: 0, z: 0,
      anchor: { skeleton: "Akane_home", bone: "All_Layer", go: [1, 0, 0, 0, 0, 1, 0, -962, 0, 0, 1, 0], ds: 1 },
      static: IDENTITY, chain: [{ node: 5, p: [10, 0, 0], q: [0, 0, 0, 1], s: [100, 50, 1] }] }],
    clips: [{ duration: 2, rate: 1, loop: 1, tracks: [
      { node: 5, attr: "s", v: [[100, 50, 1], [200, 100, 1], [100, 50, 1]] },
      { renderer: 0, prop: "_Color0", ch: 0, rgba: 1, v: [0.5, 1, 0.5] }, { renderer: 0, prop: "_Color0", ch: 1, rgba: 0, v: [0.5] }] }],
    ...over,
  };
}

test("a mesh renderer follows its bone and its looping clip", () => {
  const bone = { a: 1, b: 0, c: 0, d: 1, worldX: 30, worldY: 40 };
  const fx = quadFx(), meshes = new Mesh.Meshes(fx, { bone: (sk, b) => (sk === "Akane_home" && b === "All_Layer" ? bone : null) });
  const [item] = meshes.items;
  assert.ok(item.mesh && item.def === fx.renderers[0]);
  // the skeleton GameObject, the bone, then the chain: centred at (30 + 10, -962 + 40), 100 x 50
  let g = meshes.geometry(item), xs = [], ys = [];
  for (let k = 0; k < g.count; k++) { xs.push(g.data[k * STRIDE]); ys.push(g.data[k * STRIDE + 1]); }
  assert.equal(g.count, 6);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [-10, 90, -947, -897]);
  // UV (0, 0) at the bottom left as Unity's Quad, z 0 and w 1 as a two-component stream reads, white
  assert.deepEqual(Array.from(g.data.slice(2, 6)), [0, 0, 0, 1]);
  assert.deepEqual(Array.from(g.data.slice(14, 18)), [1, 1, 1, 1]);
  // a second later the clip has doubled the scale and brightened the colour: a Color channel in linear light, a Vector
  // channel as it is, the others the material's
  meshes.update(0.1);
  for (let i = 0; i < 9; i++) meshes.update(0.1);
  g = meshes.geometry(item);
  xs = []; for (let k = 0; k < g.count; k++) xs.push(g.data[k * STRIDE]);
  nearAll([Math.min(...xs), Math.max(...xs)], [-60, 140], 1e-6, "x bounds");
  nearAll(item.uniforms._Color0, [1, 0.5, 1, 0], 1e-9);
  // and back after the whole loop
  for (let i = 0; i < 10; i++) meshes.update(0.1);
  near(item.uniforms._Color0[0], Math.pow((0.5 + 0.055) / 1.055, 2.4), 1e-6);
  assert.equal(meshes.stats()[0].triangles, 2);
});

test("culled faces are dropped the way Unity culls them", () => {
  const fx = quadFx({ clips: [] });
  fx.renderers[0].anchor = null;
  const count = (s, cull) => {
    fx.materials.lens.cull = cull;
    fx.renderers[0].chain = [{ node: 1, p: [0, 0, 0], q: [0, 0, 0, 1], s }];
    const meshes = new Mesh.Meshes(fx);
    return meshes.geometry(meshes.items[0]).count / 3;
  };
  assert.equal(count([10, 10, 1], 2), 2, "facing the camera: both front faces");
  assert.equal(count([-10, 10, 1], 2), 2, "mirrored: Unity turns the winding round with it");
  assert.equal(count([10, 10, 1], 1), 0, "front faces culled");
  assert.equal(count([10, 10, 1], 0), 2);
  // turned away (180 degrees about y): its back faces the camera
  fx.materials.lens.cull = 2;
  fx.renderers[0].chain = [{ node: 1, p: [0, 0, 0], q: [0, 1, 0, 0], s: [10, 10, 1] }];
  const meshes = new Mesh.Meshes(fx);
  assert.equal(meshes.geometry(meshes.items[0]).count, 0);
  Mesh.show(false);
  fx.renderers[0].chain[0].q = [0, 0, 0, 1];
  const shown = new Mesh.Meshes(fx);
  assert.equal(shown.geometry(shown.items[0]).count, 0, "for checks: left out");
  Mesh.show(true);
});

test("mesh renderers draw with the effects, sorted with them, with their animated colours", async () => {
  const gl = fakeGL(), p = player(gl, [], { name: "Akane_home", x: 0, y: -962, scale: 1, order: 0, queue: 2800, pages: { Akane_home: 2800 }, z: 0 });
  Linear.attach(p);
  const fx = quadFx();
  const effects = GL.create(fx, { base: "/x/", bone: () => ({ a: 1, b: 0, c: 0, d: 1, worldX: 0, worldY: 0 }), load: async () => ({}) });
  effects.layers([p]);
  // the lens dirt (2950) sorts after the skeleton's page (2800)
  assert.equal(effects.drawsAfter(p, 0), true);
  Linear.begin(p);
  const from = gl.calls.length;
  effects.below(p, 0.5);
  effects.above(p);
  const calls = gl.calls.slice(from);
  Linear.end(p);
  assert.deepEqual(calls.filter(([n]) => n === "drawArrays").map((c) => c[3]), [6]);
  // One One: colour adds, coverage does not
  assert.deepEqual(calls.filter(([n]) => n === "blendFuncSeparate").map((c) => c.slice(1)), [["ONE", "ONE", "ZERO", "ONE"]]);
  const color = calls.find((c) => c[0] === "uniform4f" && c[1]?.uniform === "_Color0");
  assert.ok(!color, "the stand-in reports no active uniforms");
  assert.equal(effects.stats().meshes, 1);
  assert.equal(effects.stats({ meshes: true }).meshes[0].name, "LensDirt");
  assert.ok(GL.fragmentSource("lobbyOrder").includes("t.rgb * _Color0.rgb * v_col.rgb, 1.0"));
  effects.detach(p);
  effects.dispose();
  Linear.detach(p);
});

// --- skeleton-materials.js ------------------------------------------------------------------------------------------

const M = await import("../../src/ba_modding_toolkit/web/js/skeleton-materials.js");
// linear.js attached, with the blend modes the batch is set to in the player's log
function attachLinear(p) {
  const ok = Linear.attach(p), batcher = p.sceneRenderer.batcher, set = batcher.setBlendMode;
  batcher.setBlendMode = function (mode, pma) { p.log.push(["mode", mode]); return set.call(this, mode, pma); };
  return ok;
}
const multiply = { program: "pma", src: 2, dst: 10, srcA: 2, dstA: 10, straight: 1, floats: {}, colors: { _Color: [1, 1, 1, 1] }, tex: {} };

test("a material per draw: a replacement for the slot's blend mode on its page, else the page's own", () => {
  const mats = { pages: { Page3: multiply }, blend: { multiply: { Page1: { ...multiply, tag: "p1" } }, screen: { Page1: null } } };
  assert.equal(M.materialOf(mats, "Page3", spine.BlendMode.Normal), multiply);
  assert.equal(M.materialOf(mats, "Page1", spine.BlendMode.Normal), null);
  assert.equal(M.materialOf(mats, "Page1", spine.BlendMode.Multiply).tag, "p1");
  // a page the list does not name takes the list's first material (one shader for the mode)
  assert.equal(M.materialOf(mats, "Page2", spine.BlendMode.Multiply).tag, "p1");
  // a replacement the game leaves empty: spine-player's own drawing
  assert.equal(M.materialOf(mats, "Page1", spine.BlendMode.Screen), null);
  assert.equal(M.materialOf(null, "Page1", spine.BlendMode.Normal), null);
});

test("Multiply and Screen slots without replacement materials draw as Normal", () => {
  // screen falls back; multiply keeps its mode (its list names a page); additive always adds
  assert.deepEqual([...M.fallbackModes({ blend: { multiply: { Page1: null } } })], [spine.BlendMode.Screen]);
  assert.deepEqual([...M.fallbackModes({ blend: {} })].sort(), [spine.BlendMode.Multiply, spine.BlendMode.Screen]);
  assert.deepEqual([...M.fallbackModes({ blend: { multiply: {}, screen: {} } })], []);
});

test("the glitch frames: a hash of the time against _GlitchFreq, the second pass on 3 x the time", () => {
  const frac = (x) => x - Math.floor(x);
  for (const t of [0.5, 1.25, 7.75, 100.1]) {
    assert.equal(M.glitch(t, 0, 0.98), frac(Math.sin(t * 91.2228) * 43758.5) >= 0.98);
    assert.equal(M.glitch(t, 1, 0.98), frac(Math.sin(3 * t * 91.2228) * 43758.5) >= 0.98);
  }
  // about 2 % of the frames at the lobby's 0.98
  let n = 0;
  for (let i = 0; i < 6000; i++) n += M.glitch(i / 60, 0, 0.98) ? 1 : 0;
  assert.ok(n > 60 && n < 180, `${n} glitch frames`);
});

test("the programs read what the game's compiled programs read", () => {
  // every program takes spine-player's four vertex attributes and declares the uniforms the hooks set
  const noise = M.PROGRAMS.noiseFlow.src, portrait = M.PROGRAMS.portraitNoise.src;
  for (const name of ["_CenterX", "_Rotate", "_SkewedX", "_SlopeForward", "_SlopeSide", "_NoiseTexTillingX", "_PixelNoiseSpeedY", "_PixelNoisePower"]) {
    assert.ok(noise.includes(name), name);
  }
  // the noise shift: (2 noise - 1) x power x 0.001 x the vertex alpha, inside the projected square only
  assert.ok(/\(2\.0 \* n \* m - 1\.0\) \* _PixelNoisePower \* 0\.001 \* col\.a \* m/.test(noise));
  // MX programs take the vertex colour as stored, Spine/Skeleton's convert it to linear light
  assert.ok(noise.includes("vertexColour(false)") && M.PROGRAMS.pma.src.includes("vertexColour(true)"));
  // the glitch: two passes on opposite bands, the scan line texture's red and green, the tint
  assert.equal(M.PROGRAMS.portraitNoise.passes, 2);
  assert.ok(portrait.includes("u_pass < 0.5 ? band : -band") && portrait.includes("0.17008, 0.57216, 0.05776"));
});

test("ported pages draw with their programs and blends; dark colours and fallen-back blends as the game draws them", async () => {
  const gl = fakeGL();
  const portrait = { program: "portraitNoise", src: 1, dst: 10, srcA: 1, dstA: 10, straight: 0,
    floats: { _GlitchFreq: 0.98, _GlitchOffset: 0.005, _GlitchThickness: 900, _ScanLineSpeed: 0.15 },
    colors: { _Color: [1, 1, 1, 1], _Black: [0, 0, 0, 0], _PortraitNoiseTint: [0.5, 0.5, 0.5, 0] },
    tex: { _PortraitNoiseTex: { id: "cab-s_1", w: 32, h: 32, filter: 1, mips: 0, wrap: [0, 0], srgb: 0 } } };
  const layer = { name: "Aru_home", materials: { pages: { Page3: multiply, Page4: portrait }, blend: {}, scale: 0.01, tintBlack: false } };
  const p = player(gl, [["body", 0, "Page1"], ["shade", 0, "Page3", { r: 1, g: 0, b: 0, a: 1 }], ["light", 3, "Page1"],
    ["glow", 1, "Page3"], ["screen", 0, "Page4"], ["hair", 0, "Page1"]], layer);
  assert.equal(M.attach(p, layer), false, "linear light first");
  assert.ok(attachLinear(p));
  const loads = [];
  assert.ok(M.attach(p, layer, { screen: () => ({ x: -100, y: -50, width: 200, height: 100 }), base: "/lobby/x/", load: async (url) => { loads.push(url); return {}; } }));
  assert.deepEqual(loads, ["/lobby/x/fx_cab-s_1.png"], "the material's own textures, from the lobby's route");
  await new Promise((r) => setTimeout(r, 0));
  const from = gl.calls.length;
  const log = p.frame();
  const calls = gl.calls.slice(from);
  // spine-player's shader for its own pages (the fallen-back screen slot too); the multiply page's program, and again
  // for the additive slot on it (its vertex alpha 0); the glitch page in two passes; spine-player's shader again
  assert.deepEqual(log.filter(([k]) => k === "flush" || k === "pass").map((e) => e.slice(1)), [
    ["spine", "Page1"], ["pma", "Page3"], ["spine", "Page1"], ["pma", "Page3"], ["portraitNoise"], ["portraitNoise", "Page4"], ["spine", "Page1"]]);
  const blends = calls.filter(([n]) => n === "blendFuncSeparate").map((c) => c.slice(1));
  assert.ok(blends.some((b) => b.join() === "DST_COLOR,ONE_MINUS_SRC_ALPHA,DST_COLOR,ONE_MINUS_SRC_ALPHA"), "the multiply shader's blend (DstColor for alpha reads the destination's alpha)");
  const set = (name) => calls.filter((c) => c[1]?.uniform === name).map((c) => c[2]);
  assert.deepEqual(set("u_additive"), [0, 1, 0, 0], "the additive slot's program run sees alpha 0");
  assert.deepEqual(set("u_pass"), [0, 0, 0, 1]);
  near(set("_PortraitNoiseTint")[0], Math.pow((0.5 + 0.055) / 1.055, 2.4), 1e-9, "a Color in linear light");
  // the dark colour is never drawn, and it is back after the draw
  assert.ok(log.filter(([k]) => k === "dark").every(([, , d]) => d === null));
  assert.deepEqual(p.skeleton.slots[1].darkColor, { r: 1, g: 0, b: 0, a: 1 });
  // the screen slot without screen materials draws as Normal (its own blend mode untouched)
  const modes = log.filter(([k]) => k === "mode").map(([, m]) => m);
  assert.ok(!modes.includes(spine.BlendMode.Screen) && modes.includes(spine.BlendMode.Additive), `the batch's blend modes ${modes}`);
  assert.equal(p.skeleton.data.slots[2].blendMode, spine.BlendMode.Screen);
  assert.deepEqual(M.stats()[0].normal, ["light"]);
  // a lost context has freed the scan line texture: it is made again from the image in memory
  const uploads = () => gl.calls.filter(([n, , , format]) => n === "texImage2D" && format === "RGBA8").length;
  assert.equal(uploads(), 1, "linear (not sRGB) as the game imports it");
  gl.live.clear(); // every object goes with the context
  for (const r of p.context.restorables) r.restore();
  p.frame();
  assert.equal(uploads(), 2);
  // for checks: spine-player alone
  M.show(false);
  const plain = p.frame();
  assert.deepEqual(plain.filter(([k]) => k === "flush").map((e) => e[1]), ["spine", "spine", "spine", "spine", "spine", "spine"]);
  assert.deepEqual(plain.filter(([k]) => k === "mode").map(([, m]) => m).filter((m) => m === spine.BlendMode.Screen), [spine.BlendMode.Screen]);
  M.show(true);
  // detach: spine-player's methods, the blend modes, and no GL object left
  const programs = calls.filter(([n]) => n === "createProgram").length;
  M.detach(p);
  for (const k of ["draw", "flush", "begin"]) assert.ok(!Object.prototype.hasOwnProperty.call(p.sceneRenderer.batcher, k), k);
  assert.ok(Object.prototype.hasOwnProperty.call(p.sceneRenderer.batcher, "setBlendMode"), "linear.js's own again");
  assert.equal(gl.calls.filter(([n]) => n === "deleteProgram").length >= programs, true);
  Linear.detach(p);
  assert.equal(gl.live.size, 0);
  assert.deepEqual(M.stats(), []);
});

test("a skeleton without prefab data keeps spine-player's drawing", () => {
  const gl = fakeGL(), p = player(gl, [["light", 3, "Page1"]], { name: "Mod_home" });
  attachLinear(p);
  assert.equal(M.attach(p, p.bamtLayer), false);
  assert.deepEqual(p.frame().filter(([k]) => k === "mode").map(([, m]) => m), [3]);
  Linear.detach(p);
});
