// Tests for web/js/lobby-stage.js (every skeleton and effect of a memorial lobby drawn in the game's order in the
// bottom player's context), with web/js/particles-gl.js placing the effects, against stand-ins for spine-player, its
// canvas and WebGL2. Run by tests/test_lobby_stage.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

// a WebGL2 context that records every call; create* return fresh objects, constants are their names
class FakeGL {}
globalThis.WebGL2RenderingContext = FakeGL;
function fakeGL(canvas) {
  const calls = [];
  let n = 0;
  const target = Object.assign(new FakeGL(), { calls, canvas, drawingBufferWidth: 64, drawingBufferHeight: 32 });
  return new Proxy(target, {
    get(t, name) {
      if (name in t) return t[name];
      if (typeof name !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      return (...args) => {
        calls.push([name, ...args]);
        if (name.startsWith("create")) return { kind: name.slice(6), id: ++n };
        if (name === "getShaderParameter" || name === "getProgramParameter") return args[1] === "ACTIVE_UNIFORMS" ? 0 : true;
        if (name === "checkFramebufferStatus") return "FRAMEBUFFER_COMPLETE";
        return name === "isContextLost" ? false : null;
      };
    },
  });
}
// a canvas: its own context on the first ask, events as an EventTarget has them
class FakeCanvas {
  constructor() { this.width = 64; this.height = 32; this.on = {}; this.gl = null; }
  getContext() { return (this.gl ??= fakeGL(this)); }
  addEventListener(type, fn) { (this.on[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.on[type] = (this.on[type] || []).filter((f) => f !== fn); }
  dispatchEvent(e) { for (const fn of this.on[e.type] || []) fn(e); }
}
globalThis.HTMLCanvasElement = FakeCanvas;
globalThis.Event ??= class { constructor(type) { this.type = type; } preventDefault() {} };
globalThis.window = new FakeCanvas(); // only its listeners count
globalThis.spine = { BlendMode: { Normal: 0, Additive: 1 },
  PolygonBatcher: { blendModesGL: [{ srcRgb: 1, srcRgbPma: 1, dstRgb: 2, srcAlpha: 1 }, { srcRgb: 1, srcRgbPma: 1, dstRgb: 1, srcAlpha: 1 }] } };
globalThis.performance ??= { now: () => Date.now() };

const Stage = await import("../../src/ba_modding_toolkit/web/js/lobby-stage.js");
const GL = await import("../../src/ba_modding_toolkit/web/js/particles-gl.js");
const Linear = await import("../../src/ba_modding_toolkit/web/js/linear.js");

// The layers and effects of three lobbies as lobby.json gives them (the queues of their atlas pages and of their
// effects' materials, the effects' sorting fudge and depth): two skeletons each, the second the intro's scene parked
// beside the lobby, whose pages interleave with the character's by render queue.
const WAKAMO = {
  layers: [
    { name: "Wakamo_home", order: 0, queue: 2900, pages: { Wakamo_home: 3050, Wakamo_home2: 2900 }, z: 0 },
    { name: "Wakamo_Scene_0", order: 0, queue: 2800, pages: { Wakamo_Scene_0: 3050, Wakamo_Scene_02: 3150, Wakamo_Scene_03: 2900, Wakamo_Scene_04: 2800 }, z: 0 },
  ],
  systems: [["particle_back", 0, 3000, 0, 0], ["particle_center", 0, 3000, 22.99988, 0], ["fire1", 0, 3000, 0, -34.5],
    ["fire2", 0, 3100, 0, -34.5], ["particle_front", 0, 3000, 22.99988, 0], ["fire3", 0, 3100, 0, -34.5]],
};
const YUUKA = { // ch0184_home
  layers: [
    { name: "CH0184_home", order: 0, queue: 2850, pages: { CH0184_home: 3050, CH0184_home2: 2900, CH0184_home3: 2850 }, z: 0 },
    { name: "CH0184_00", order: 0, queue: 2900, pages: { CH0184_00: 3050, CH0184_002: 2900 }, z: 0 },
  ],
  systems: [["boke_3_F", 0, 3002, 0, 0], ["boke_5_F_R", 1, 3002, 0, 0], ["boke_6", 1, 3002, 0, 0], ["B_boke_2", 0, 3002, 0, 0],
    ["B_boke_1", 0, 3002, 0, 0], ["dust_2", 0, 2950, 0, 0], ["dust_3", 0, 2950, 0, 0]],
};
const SHIGURE = {
  layers: [
    { name: "Shigure_home", order: 0, queue: 2900, pages: { Shigure_home: 2900, Shigure_home2: 3050 }, z: 0 },
    { name: "Shigure_00", order: 0, queue: 2900, pages: { Shigure_00: 2900 }, z: 0 },
    { name: "Shigure_01", order: 0, queue: 2900, pages: { Shigure_01: 2900 }, z: 0 },
  ],
  systems: [["boke_3", 0, 3002, 0, 0], ["Y_boke_9", 1, 3002, 0, 0]],
};

const steps = (list, layers) => list.map((s) => [layers[s.layer].name, s.queue]);

test("one target: every skeleton's parts sorted by sorting order and render queue, ties in stacking order", () => {
  assert.deepEqual(steps(Stage.order(WAKAMO.layers), WAKAMO.layers), [
    ["Wakamo_Scene_0", 2800], ["Wakamo_home", 2900], ["Wakamo_Scene_0", 2900], ["Wakamo_home", 3050], ["Wakamo_Scene_0", 3050],
    ["Wakamo_Scene_0", 3150]]);
  assert.deepEqual(steps(Stage.order(YUUKA.layers), YUUKA.layers), [
    ["CH0184_home", 2850], ["CH0184_home", 2900], ["CH0184_00", 2900], ["CH0184_home", 3050], ["CH0184_00", 3050]]);
  assert.deepEqual(steps(Stage.order(SHIGURE.layers), SHIGURE.layers), [
    ["Shigure_home", 2900], ["Shigure_00", 2900], ["Shigure_01", 2900], ["Shigure_home", 3050]]);
  // stacked canvases: each skeleton whole, one after another
  assert.deepEqual(steps(Stage.order(WAKAMO.layers, false), WAKAMO.layers).map(([n]) => n),
    ["Wakamo_home", "Wakamo_home", "Wakamo_Scene_0", "Wakamo_Scene_0", "Wakamo_Scene_0", "Wakamo_Scene_0"]);
  // the sorting order comes before the queue (Hoshino's background at order -1); a layer without pages: its own queue
  const hoshino = [{ name: "Hoshino_home", order: 0, queue: 3001, pages: { Hoshino_home: 3001 } },
    { name: "Hoshino_home_background", order: -1, queue: 2998, pages: { a: 2998, b: 3000 } }, { name: "plain", order: 0, queue: 2950 }];
  assert.deepEqual(steps(Stage.order(hoshino), hoshino), [
    ["Hoshino_home_background", 2998], ["Hoshino_home_background", 3000], ["plain", 2950], ["Hoshino_home", 3001]]);
});

// systems as particles.py exports them, with neutral defaults; drawn with a white texture
function sys(name, order, queue, z, fudge) {
  return { name, path: name, order, queue, z, fudge, layer: 0, material: "m", playOnAwake: 1, anchor: null,
    main: { duration: 1, loop: 1, prewarm: 0, delay: 0, speedScale: 1, space: 0, scaling: 0, life: 10, speed: 0, size: [1],
      rotation: [0], flipRotation: 0, color: { col: [1, 1, 1, 1] }, gravity: 0, max: 100 },
    emission: { rate: 20, dist: 0, bursts: [] }, shape: null, modules: {},
    renderer: { mode: 0, align: 0, sort: 0, minSize: 0, maxSize: 0.5, lengthScale: 2, velocityScale: 0, pivot: [0, 0, 0],
      flip: [0, 0, 0], streams: { uv: [0, 2] } },
    rel: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], static: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], ls: [1, 1, 1] };
}
const effectsOf = (lobby) => GL.create({
  systems: lobby.systems.map((s) => sys(...s)),
  materials: { m: { program: "additive", src: 1, dst: 1, queue: 3000, tex: { _Texture: { default: "white", st: [1, 1, 0, 0] } }, floats: {}, colors: {} } },
  textures: {}, meshes: {},
}, { base: "/x/", bone: () => null, load: async () => ({}) });

test("the effects draw after the last part of any skeleton that sorts before them", () => {
  const check = (lobby, expected) => {
    const players = lobby.layers.map((layer) => ({ bamtLayer: layer }));
    const list = Stage.order(lobby.layers).map((s) => ({ ...s, owner: players[0] }));
    const fx = effectsOf(lobby);
    fx.layers(players, list);
    assert.deepEqual(list.map((s, i) => fx.drawsAfter(players[0], i)), expected);
    fx.dispose();
  };
  // Wakamo's fire and embers (3000) over both skeletons' scenery, under her (3050); the front fire (3100) over her,
  // under the scene's front page (3150)
  check(WAKAMO, [false, false, true, false, true, false]);
  // Yuuka (Track)'s dust (2950) and bokeh (3002) under her, the bokeh of order 1 over everything
  check(YUUKA, [false, false, true, false, true]);
  check(SHIGURE, [false, false, true, true]);
  // where one canvas per skeleton put them: after the parked scene's 2900 page, so over the character's 3050 one
  const players = WAKAMO.layers.map((layer) => ({ bamtLayer: layer }));
  const fx = effectsOf(WAKAMO);
  fx.layers(players);
  assert.equal(fx.drawsAfter(players[0], 1), false, "nothing between Wakamo's pages");
  assert.equal(fx.drawsAfter(players[1], 1), true);
  fx.dispose();
});

// a spine-player as lobby.js makes it: its canvas asks for a context while it is made (initialize), its renderer
// records what it draws (the names of the slots with an attachment) and its batches
const page = (name) => ({ region: { page: { name: `${name}.png` } } });
function makePlayer(name, layer, slots, log) {
  const canvas = new FakeCanvas();
  const gl = canvas.getContext("webgl2");
  const renderer = {
    open: false,
    begin() { log.push(`begin ${name}`); this.open = true; },
    end() { if (this.open) log.push(`end ${name}`); this.open = false; },
    drawSkeleton(skeleton) {
      log.push(`draw ${name}: ${skeleton.drawOrder.filter((s) => s.attachment).map((s) => s.name).join(" ")}`);
      this.seen = skeleton.drawOrder.map((s) => s.color?.r);
    },
  };
  const player = {
    name, canvas, bamtLayer: layer, sceneRenderer: renderer, eventListeners: [],
    context: { gl, addRestorable() {}, removeRestorable() {} },
    skeleton: { drawOrder: slots.map(([slot, p]) => ({ name: slot, attachment: typeof p === "string" ? page(p) : p })) },
    addEventListener(target, event, func) { this.eventListeners.push({ target, event, func }); target.addEventListener(event, func); },
    drawFrame(more) { log.push(`frame ${name} ${more}`); },
  };
  const resize = () => player.drawFrame(false);
  player.addEventListener(globalThis.window, "resize", resize);
  return player;
}
// what lobby.js does: the bottom player first, the others with its context; each ready once loaded, then the stage
function lobby(spec, slots, fx, { share = true, log = [] } = {}) {
  const players = [];
  spec.layers.forEach((layer, i) => {
    players.push(Stage.make(share && i ? players[0] : null, () => makePlayer(layer.name, layer, slots[i], log)));
  });
  for (const p of players) Stage.ready(p);
  Stage.install(players, fx);
  return { players, log };
}
// spine-player's frame: its renderer begun, the skeleton drawn, the renderer ended
function frame(p) {
  p.sceneRenderer.begin();
  p.sceneRenderer.drawSkeleton(p.skeleton, false);
  p.sceneRenderer.end();
}
// a stand-in for particles-gl.js: effects after the given steps of their owner
function fakeFx(after, log) {
  return {
    layers(players, list) { this.list = list; this.owners = new Set(list.map((s) => s.owner)); },
    drawsAfter: (owner, i) => after.includes(i),
    between: (owner, i) => log.push(`fx after ${i} in ${owner.name}`),
  };
}

test("the guests draw with the host's context and only through the host, posed by its frames", () => {
  const log = [];
  const slots = [[["bg", "Wakamo_home2"], ["body", "Wakamo_home"]],
    [["sky", "Wakamo_Scene_04"], ["hall", "Wakamo_Scene_03"], ["scene", "Wakamo_Scene_0"], ["front", "Wakamo_Scene_02"], ["clip", { clipping: true }]]];
  const fx = fakeFx([2, 4], log);
  const { players: [host, guest] } = lobby(WAKAMO, slots, fx, { log });
  assert.equal(guest.context.gl, host.context.gl, "the guest's canvas got the host's context");
  assert.equal(Stage.hostOf(guest), host);
  assert.equal(Stage.hostOf(host), null);
  assert.equal(guest.stopRequestAnimationFrame, true, "its own frame loop stops");
  assert.deepEqual(guest.eventListeners.filter((e) => e.event === "resize"), [], "a resize no longer runs its frame");
  assert.equal((globalThis.window.on.resize || []).length, 1, "the host's resize listener stays");
  assert.ok([...fx.owners].every((o) => o === host), "the host draws every step");
  // its own frame draws nothing
  log.length = 0;
  frame(guest);
  assert.deepEqual(log, ["begin Wakamo_Scene_0", "end Wakamo_Scene_0"]);
  // the host's frame hook runs the guests' frames first, then gives the viewport back to the host's canvas
  log.length = 0;
  const gl = host.context.gl, from = gl.calls.length;
  Stage.frame(host);
  Stage.frame(guest);
  assert.deepEqual(log, ["frame Wakamo_Scene_0 false"]);
  assert.deepEqual(gl.calls.slice(from), [["viewport", 0, 0, 64, 32]]);
  // the host's draw: every part in the game's order, each with its player's renderer, the effects in between
  log.length = 0;
  frame(host);
  assert.deepEqual(log, [
    "begin Wakamo_home", "end Wakamo_home",
    "begin Wakamo_Scene_0", "draw Wakamo_Scene_0: sky clip", "end Wakamo_Scene_0",
    "begin Wakamo_home", "draw Wakamo_home: bg", "end Wakamo_home",
    "begin Wakamo_Scene_0", "draw Wakamo_Scene_0: hall clip", "end Wakamo_Scene_0",
    "fx after 2 in Wakamo_home",
    "begin Wakamo_home", "draw Wakamo_home: body", "end Wakamo_home",
    "begin Wakamo_Scene_0", "draw Wakamo_Scene_0: scene clip", "end Wakamo_Scene_0",
    "fx after 4 in Wakamo_home",
    "begin Wakamo_Scene_0", "draw Wakamo_Scene_0: front clip", "end Wakamo_Scene_0",
    "begin Wakamo_home", "end Wakamo_home"]);
  assert.ok(guest.skeleton.drawOrder.every((s) => s.attachment), "every attachment is given back");
  // for checks: the order drawn, and the old one (each skeleton whole) in the same context
  assert.deepEqual(Stage.drawn().map(([n, q, fxAfter]) => `${n} ${q}${fxAfter ? " +fx" : ""}`), ["Wakamo_Scene_0 2800",
    "Wakamo_home 2900", "Wakamo_Scene_0 2900 +fx", "Wakamo_home 3050", "Wakamo_Scene_0 3050 +fx", "Wakamo_Scene_0 3150"]);
  Stage.setInterleaved(false);
  assert.deepEqual(fx.list.map((s) => `${s.player.name} ${s.queue}`), ["Wakamo_home 2900", "Wakamo_home 3050",
    "Wakamo_Scene_0 2800", "Wakamo_Scene_0 2900", "Wakamo_Scene_0 3050", "Wakamo_Scene_0 3150"]);
  Stage.setInterleaved(true);
  assert.deepEqual(fx.list.map((s) => s.queue), [2800, 2900, 2900, 3050, 3050, 3150]);
});

test("a lost and restored context reaches the guests' textures and shaders", () => {
  const { players: [host, guest] } = lobby(SHIGURE, [[["a", "Shigure_home"]], [["b", "Shigure_00"]], [["c", "Shigure_01"]]], null);
  const seen = [];
  guest.canvas.addEventListener("webglcontextrestored", () => seen.push("restored"));
  guest.canvas.addEventListener("webglcontextlost", () => seen.push("lost"));
  host.canvas.dispatchEvent(new Event("webglcontextlost"));
  host.canvas.dispatchEvent(new Event("webglcontextrestored"));
  assert.deepEqual(seen, ["lost", "restored"]);
});

test("a lobby of one skeleton draws its parts as before; one of a single part, as spine-player does", () => {
  const log = [];
  const hibiki = { layers: [{ name: "Hibiki_home", order: 0, queue: 2900, pages: { Hibiki_home: 3050, Hibiki_home2: 2900 }, z: 0 }] };
  const fx = fakeFx([0, 1], log);
  const { players: [p] } = lobby(hibiki, [[["river", "Hibiki_home2"], ["her", "Hibiki_home"]]], fx, { log });
  assert.deepEqual(fx.list.map((s) => [s.owner, s.part, s.queue]), [[p, 0, 2900], [p, 1, 3050]]);
  frame(p);
  // the river surface between the background page and her, the effects after her by the draw hook (above)
  assert.deepEqual(log, ["begin Hibiki_home", "draw Hibiki_home: river", "end Hibiki_home", "fx after 0 in Hibiki_home",
    "begin Hibiki_home", "draw Hibiki_home: her", "end Hibiki_home"]);
  const one = [];
  const plain = lobby({ layers: [{ name: "Airi_home", order: 0, queue: 3050, pages: { Airi_home: 3050 }, z: 0 }] },
    [[["a", "Airi_home"], ["b", "Airi_home"]]], null, { log: one });
  frame(plain.players[0]);
  assert.deepEqual(one, ["begin Airi_home", "draw Airi_home: a b", "end Airi_home"]);
});

test("skeletons with contexts of their own each draw their own parts, stacked", () => {
  const log = [];
  const fx = fakeFx([1], log);
  const { players: [home, scene] } = lobby(WAKAMO, [[["bg", "Wakamo_home2"], ["body", "Wakamo_home"]], [["sky", "Wakamo_Scene_04"]]], fx,
    { share: false, log });
  assert.notEqual(home.context.gl, scene.context.gl);
  assert.equal(scene.stopRequestAnimationFrame, undefined);
  assert.deepEqual(fx.list.map((s) => [s.owner.name, s.part]), [["Wakamo_home", 0], ["Wakamo_home", 1], ["Wakamo_Scene_0", 0],
    ["Wakamo_Scene_0", 1], ["Wakamo_Scene_0", 2], ["Wakamo_Scene_0", 3]]);
  Stage.frame(home); // no guests to run
  frame(scene);
  assert.ok(log.includes("draw Wakamo_Scene_0: sky") && log.includes("fx after 1 in Wakamo_Scene_0"));
  assert.ok(!log.some((l) => l.startsWith("frame")));
});

test("the guests' slot colours are tinted for linear light around the host's draw, and given back", () => {
  const { players } = lobby(SHIGURE, [[["a", "Shigure_home"]], [["b", "Shigure_00"]], [["c", "Shigure_01"]]], null);
  const [host, guest] = players;
  // every slot white but the guest's, a 0.5 grey: decoded from sRGB while the host draws it, as the game's shader sees it
  const grey = (v) => ({ r: v, g: v, b: v, a: 1, set(r, g, b, a) { Object.assign(this, { r, g, b, a }); } });
  for (const p of players) {
    p.skeleton.data = { skins: [] };
    p.sceneRenderer.batcher = {};
    for (const s of p.skeleton.drawOrder) Object.assign(s, { color: grey(p === guest ? 0.5 : 1), data: { blendMode: 0 }, getAttachment() { return this.attachment; } });
    assert.equal(Linear.attach(p, Stage.hostOf(p)), true);
  }
  frame(host);
  const decoded = Math.pow((0.5 + 0.055) / 1.055, 2.4);
  assert.ok(Math.abs(guest.sceneRenderer.seen[0] - decoded) < 1e-9, `drawn with ${guest.sceneRenderer.seen[0]}`);
  assert.equal(guest.skeleton.drawOrder[0].color.r, 0.5, "given back after the draw");
  for (const p of players) Linear.detach(p);
});
