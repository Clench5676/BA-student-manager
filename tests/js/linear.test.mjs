// Tests for web/js/linear.js (the lobby's linear-light drawing) against a recording stand-in for WebGL2: what a player
// gets on attach is freed again on detach. Run by tests/test_lobby_linear.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

// a WebGL2 context that records every call; create* return fresh objects, constants are their names
class FakeGL {}
globalThis.WebGL2RenderingContext = FakeGL;
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
        if (name === "getUniformLocation") return { uniform: args[1] };
        if (name === "getShaderParameter" || name === "getProgramParameter") return true;
        if (name === "checkFramebufferStatus") return "FRAMEBUFFER_COMPLETE";
        if (name === "isContextLost") return false;
        return null;
      };
    },
  });
}

class Texture { update() { this.updated = (this.updated || 0) + 1; } getImage() { return {}; } }
class Batcher { setBlendMode() { return "spine"; } }
globalThis.spine = { BlendMode: { Normal: 0, Additive: 1 },
  PolygonBatcher: { blendModesGL: [{ srcRgb: 1, srcRgbPma: 1, dstRgb: 2, srcAlpha: 1 }, { srcRgb: 1, srcRgbPma: 1, dstRgb: 1, srcAlpha: 1 }] } };

const Linear = await import("../../src/ba_modding_toolkit/web/js/linear.js");

function player(gl) {
  const page = Object.assign(new Texture(), { texture: {}, useMipMaps: false });
  const restorables = [];
  return {
    page, restorables,
    context: { gl, addRestorable: (r) => restorables.push(r), removeRestorable: (r) => restorables.splice(restorables.indexOf(r), 1) },
    skeleton: { data: { skins: [{ getAttachments: () => [{ attachment: { region: { texture: page } } }] }] } },
    sceneRenderer: { batcher: new Batcher() },
  };
}

test("detach frees the framebuffer, its texture, the program and the triangle, and restores the hooks", () => {
  const gl = fakeGL(), p = player(gl);
  assert.equal(Linear.attach(p), true);
  assert.equal(p.restorables.length, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(p.page, "update"));
  assert.notEqual(p.sceneRenderer.batcher.setBlendMode, Batcher.prototype.setBlendMode);
  Linear.begin(p); // sizes the sRGB texture to the drawing buffer and binds the framebuffer
  Linear.end(p);
  // the shaders went with the program at once; what is left: program, vertex array, buffer, framebuffer, texture
  assert.deepEqual([...gl.live].map((o) => o.kind).sort(), ["Buffer", "Framebuffer", "Program", "Texture", "VertexArray"]);

  Linear.detach(p);
  assert.equal(gl.live.size, 0, `still alive: ${JSON.stringify([...gl.live])}`);
  assert.equal(p.restorables.length, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(p.page, "update"));
  assert.equal(p.sceneRenderer.batcher.setBlendMode, Batcher.prototype.setBlendMode);
  assert.equal(Linear.active(p), false);
  // the player's hooks are no-ops from now on, and a second detach is harmless
  const before = gl.calls.length;
  Linear.begin(p);
  Linear.tint(p);
  Linear.end(p);
  Linear.detach(p);
  assert.equal(gl.calls.length, before);
});

test("a lost context is not asked to delete anything", () => {
  const gl = fakeGL(), p = player(gl);
  Linear.attach(p);
  gl.isContextLost = () => true;
  const before = gl.calls.length;
  Linear.detach(p);
  assert.equal(gl.calls.filter(([name], i) => i >= before && name.startsWith("delete")).length, 0);
  assert.equal(p.restorables.length, 0);
});

// --- the game camera's post-processing (lobby.json "post") ---
const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const closeAll = (a, b, eps) => { assert.equal(a.length, b.length); a.forEach((x, i) => close(x, b[i], eps)); };
// sRGB to linear for the colour wheels (Mathf.GammaToLinearSpace)
const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

test("no post-processing, or one that does nothing, leaves the pass a plain copy", () => {
  assert.equal(Linear.postParams(null), null);
  assert.equal(Linear.postParams({}), null);
  assert.equal(Linear.postParams({ chromaticAberration: 0, panini: { distance: 0, cropToFit: 1 } }), null);
});

test("Toki: chromatic aberration and a brighter gain, the gain's offset taken as it is", () => {
  const p = Linear.postParams({ chromaticAberration: 0.07,
    liftGammaGain: { lift: [1, 1, 1, 0], gamma: [1, 1, 1, 0], gain: [1, 1, 1, 0.0754] } });
  close(p.ca, 0.0035);
  assert.equal(p.panini[2], 0);
  closeAll(p.gain, [1.0754, 1.0754, 1.0754]);
  closeAll(p.lift, [0, 0, 0]);
  closeAll(p.gamma, [1, 1, 1]);
  assert.equal(p.grade, true);
});

test("Miku: a coloured gain is decoded, scaled by 0.8 and kept at its luminance; Panini on the lobby camera's 10 degrees", () => {
  const gain = [0.98568, 1, 0.94948];
  const p = Linear.postParams({ chromaticAberration: 0.075, panini: { distance: 1, cropToFit: 1 },
    liftGammaGain: { lift: [1, 1, 1, 0], gamma: [1, 1, 1, 0], gain: [...gain, 0] } });
  const c = gain.map((x) => lin(x) * 0.8), l = 0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2];
  closeAll(p.gain, c.map((x) => x - l + 1));
  closeAll(p.gain, [0.98609, 1.0119, 0.92303], 1e-4); // the blue a third of the way to yellow
  // view extents tan(5 deg) x 16 / 9 and tan(5 deg); cropped to fit, the middle is enlarged by 0.6 %
  closeAll(p.panini.slice(0, 3), [(Math.tan(Math.PI / 36) * 16) / 9, Math.tan(Math.PI / 36), 1]);
  close(p.panini[3], 0.99402, 1e-5);
  // without cropping, the scale stays 1
  close(Linear.postParams({ panini: { distance: 1, cropToFit: 0 } }).panini[3], 1);
});

test("Niko: the gamma wheel's offset brightens the midtones (an inverse gamma below 1)", () => {
  const p = Linear.postParams({ liftGammaGain: { lift: [1, 1, 1, 0], gamma: [0.97512, 0.98716, 1, 0.03715], gain: [1, 1, 1, 0] } });
  closeAll(p.gamma, [0.98169, 0.96152, 0.94057], 1e-4);
  assert.ok(p.gamma.every((g) => g < 1));
  assert.equal(p.ca, 0);
});

test("colour adjustments: exposure in stops, an HDR colour filter decoded with a 2.2 power, hue, saturation, contrast", () => {
  const p = Linear.postParams({ colorAdjustments: { postExposure: 0.22, contrast: 1.2258, colorFilter: [1.04, 1.04, 0.5],
    hueShift: -2.15, saturation: 0 } });
  close(p.exposure, Math.pow(2, 0.22));
  closeAll(p.filt, [Math.pow(1.04, 2.2), Math.pow(1.04, 2.2), lin(0.5)]);
  closeAll(p.hsc, [-2.15 / 360, 1, 1.012258]);
  assert.equal(p.grade, true);
});

// one frame through the pass: the uniforms it sets, by name (the stand-in's locations carry their names)
function frameUniforms(gl, p) {
  Linear.begin(p);
  const from = gl.calls.length;
  Linear.end(p);
  return Object.fromEntries(gl.calls.slice(from).filter(([name]) => name.startsWith("uniform")).map(([, loc, ...v]) => [loc.uniform, v]));
}

test("the pass hands the shader the lobby's parameters, and none while switched off for a check", () => {
  const gl = fakeGL(), p = player(gl);
  Linear.attach(p);
  Linear.setPost(p, { chromaticAberration: 0.1 });
  const on = frameUniforms(gl, p);
  assert.deepEqual(on.size, [64, 32]); // the drawing buffer
  close(on.ca[0], 0.005); // intensity x 0.05
  // no screen given: the canvas is the screen; not the bottom layer: no clear colour
  assert.deepEqual(on.screen, [0, 0, 1, 1]);
  assert.deepEqual(on.clear, [0]);
  // the framebuffer's texture is filtered and clamped for the shifted reads
  assert.ok(gl.calls.some(([name, , key, value]) => name === "texParameteri" && key === "TEXTURE_WRAP_S" && value === "CLAMP_TO_EDGE"));
  assert.ok(gl.calls.some(([name, , key, value]) => name === "texParameteri" && key === "TEXTURE_MIN_FILTER" && value === "LINEAR"));
  Linear.setPostEnabled(false);
  try {
    close(frameUniforms(gl, p).ca[0], 0);
  } finally {
    Linear.setPostEnabled(true);
  }
  Linear.detach(p);
});

// --- the game's screen on the canvas ---
const G = { x: -1480, y: -832.5, w: 2960, h: 1665 };
// a layer placed by the prefab, and a view in NGUI units in its skeleton's units (lobby.js layerViewport)
const LAYER = { x: 12, y: -962, scale: 0.8 };
const inLayer = (v) => ({ x: (v.x - LAYER.x) / LAYER.scale, y: (v.y - LAYER.y) / LAYER.scale, width: v.w / LAYER.scale,
  height: v.h / LAYER.scale });
// the camera spine-player draws a viewport with on a W x H canvas (drawFrame: the viewport fitted, centred)
function camera(v, W = 1920, H = 1080) {
  const c = inLayer(v), zoom = H / W > c.height / c.width ? c.width / W : c.height / H;
  return { zoom, position: { x: c.x + c.width / 2, y: c.y + c.height / 2 }, viewportWidth: W, viewportHeight: H };
}
const screenOf = (v, W, H) => { const s = inLayer(G); return Linear.screenOnCanvas({ x: s.x, y: s.y, w: s.width, h: s.height }, camera(v, W, H)); };
// G's place in a 16:9 view, in the view's uv
const place = (v) => [(G.x - v.x) / v.w, (G.y - v.y) / v.h, G.w / v.w, G.h / v.h];

test("the game's screen on the canvas: the canvas itself in the game's view, its place in any other view", () => {
  // fullscreen in the game's view: exactly the canvas (the shader then reads as before), at any 16:9 drawing buffer
  for (const [W, H] of [[1920, 1080], [3840, 2160], [2400, 1350], [2112, 1188], [64, 36]]) assert.deepEqual(screenOf(G, W, H), [0, 0, 1, 1]);
  // the detail screen's left view (Michiru: 1.77 x zoom, right of the middle) and a 2 x zoom panned to a corner
  for (const v of [{ x: 47.6, y: -400, w: 1672.4, h: (1672.4 * 9) / 16 }, { x: 0, y: 0, w: 1480, h: 832.5 },
    { x: -2086.8, y: -1173.825, w: 4173.6, h: 2347.65 }]) closeAll(screenOf(v), place(v), 1e-12);
  // a canvas wider than 16:9: spine-player shows more across, so the screen takes less of it
  const wide = screenOf(G, 2000, 1000);
  closeAll(wide, [(1 - 2960 / (1665 * 2)) / 2, 0, 2960 / (1665 * 2), 1], 1e-12);
  // no screen or no camera: the canvas
  assert.deepEqual(Linear.screenOnCanvas(null, camera(G)), [0, 0, 1, 1]);
  assert.deepEqual(Linear.screenOnCanvas({ x: 0, y: 0, w: 1, h: 1 }, undefined), [0, 0, 1, 1]);
});

test("the pass places the post-processing in the game's screen, at the screen's aspect", () => {
  const gl = fakeGL(), p = player(gl);
  Linear.attach(p);
  Linear.setPost(p, { chromaticAberration: 0.12, panini: { distance: 1, cropToFit: 1 } });
  Linear.setScreen(p, inLayer(G));
  const v = { x: -740, y: -416.25, w: 1480, h: 832.5 }; // 2 x zoom around the middle
  p.sceneRenderer.camera = camera(v, 64, 36);
  gl.drawingBufferHeight = 36;
  const u = frameUniforms(gl, p);
  closeAll(u.screen, [-0.5, -0.5, 2, 2], 1e-12);
  // the Panini extents of the camera's 16:9, also on a drawing buffer of another shape (64 x 32)
  gl.drawingBufferHeight = 32;
  p.sceneRenderer.camera = camera(v, 64, 32);
  const tall = frameUniforms(gl, p);
  closeAll(tall.panini.slice(0, 2), [(Math.tan(Math.PI / 36) * 16) / 9, Math.tan(Math.PI / 36)]);
  // without a screen the canvas's own shape, as before
  Linear.setScreen(p, null);
  closeAll(frameUniforms(gl, p).panini.slice(0, 2), [Math.tan(Math.PI / 36) * 2, Math.tan(Math.PI / 36)]);
  assert.deepEqual(frameUniforms(gl, p).screen, [0, 0, 1, 1]);
  Linear.detach(p);
});

test("only the layer drawn over the camera's clear colour is made opaque, with PP on or off", () => {
  const gl = fakeGL(), bottom = player(gl), top = player(gl);
  Linear.attach(bottom);
  Linear.attach(top);
  // ch0082: a lifted black (lift 0.04325), which the bottom layer shows where the art leaves the target clear
  const post = { liftGammaGain: { lift: [1, 1, 1, 0.04325], gamma: [1, 1, 1, 0.01442], gain: [1, 1, 1, -0.04325] } };
  for (const p of [bottom, top]) Linear.setPost(p, post);
  Linear.setClear(bottom, true);
  assert.deepEqual(frameUniforms(gl, bottom).clear, [1]);
  assert.deepEqual(frameUniforms(gl, top).clear, [0]);
  const lifted = frameUniforms(gl, bottom).lift;
  assert.ok(lifted.every((x) => Math.abs(x - 0.04325) < 1e-6), `${lifted}`);
  // PP off: still over the clear colour (black, ungraded)
  Linear.setPostEnabled(false);
  try {
    const off = frameUniforms(gl, bottom);
    assert.deepEqual([off.clear, off.grade, off.lift], [[1], [0], [0, 0, 0]]);
  } finally {
    Linear.setPostEnabled(true);
  }
  Linear.setClear(bottom, false);
  assert.deepEqual(frameUniforms(gl, bottom).clear, [0]);
  Linear.detach(bottom);
  Linear.detach(top);
});

test("a player drawn with another one's context only gets its pages and blending; its own frames clear the host's framebuffer", () => {
  const gl = fakeGL(), host = player(gl), guest = player(gl);
  Linear.attach(host);
  const hostObjects = new Set(gl.live);
  assert.equal(Linear.attach(guest, host), true);
  assert.deepEqual([...gl.live].filter((o) => !hostObjects.has(o)), [], "no framebuffer, program or triangle of its own");
  assert.equal(guest.restorables.length, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(guest.page, "update"), "its page is kept sRGB");
  assert.notEqual(guest.sceneRenderer.batcher.setBlendMode, Batcher.prototype.setBlendMode, "additive slots add colour only");
  assert.equal(Linear.active(guest), true);
  // before the host has drawn a frame there is no framebuffer to clear into: nothing is bound
  const binds = (fn) => {
    const from = gl.calls.length;
    fn();
    return gl.calls.slice(from).filter(([name]) => name === "bindFramebuffer").map((c) => c[2]);
  };
  assert.deepEqual(binds(() => { Linear.begin(guest); Linear.end(guest); }), []);
  Linear.begin(host);
  Linear.end(host);
  const fbo = [...gl.live].find((o) => o.kind === "Framebuffer");
  // a frame of its own: into the host's framebuffer, then the binding it found (none) back; no pass of its own
  const from = gl.calls.length;
  assert.deepEqual(binds(() => { Linear.begin(guest); Linear.end(guest); }), [fbo, null]);
  assert.equal(gl.calls.slice(from).filter(([name]) => name === "drawArrays" || name === "useProgram").length, 0);
  Linear.detach(guest);
  assert.ok(!Object.prototype.hasOwnProperty.call(guest.page, "update"));
  assert.deepEqual([...gl.live].filter((o) => !hostObjects.has(o)), []);
  Linear.detach(host);
  assert.equal(gl.live.size, 0);
});

test("a guest goes into linear light only with its host, and leaves it with its host", () => {
  const gl = fakeGL(), host = player(gl), guest = player(gl);
  // its host not in linear light (not attached, or its program failed): the guest draws plain sRGB values like it
  assert.equal(Linear.attach(guest, host), false);
  assert.equal(Linear.active(guest), false);
  assert.ok(!Object.prototype.hasOwnProperty.call(guest.page, "update"), "its page as it came");
  assert.equal(guest.sceneRenderer.batcher.setBlendMode, Batcher.prototype.setBlendMode);
  assert.equal(Linear.attach(host), true);
  assert.equal(Linear.attach(guest, host), true);
  // no sRGB render target for the host: both draw plain again, their pages uploaded as they came
  gl.checkFramebufferStatus = () => "FRAMEBUFFER_UNSUPPORTED";
  const updated = guest.page.updated || 0;
  Linear.begin(host);
  assert.equal(Linear.active(host), false);
  assert.equal(Linear.active(guest), false);
  assert.equal(guest.page.updated, updated + 1);
  Linear.detach(guest);
  Linear.detach(host);
});

test("a tint is taken once until it is given back", () => {
  const gl = fakeGL(), p = player(gl);
  const grey = { r: 0.5, g: 0.5, b: 0.5, a: 1, set(r, g, b, a) { Object.assign(this, { r, g, b, a }); } };
  p.skeleton.drawOrder = [{ color: grey, data: { blendMode: 0 }, getAttachment: () => null }];
  Linear.attach(p);
  Linear.tint(p);
  Linear.tint(p); // a second tint before untint (another player's draw) does not decode twice
  close(grey.r, Math.pow((0.5 + 0.055) / 1.055, 2.4));
  Linear.untint(p);
  assert.equal(grey.r, 0.5);
  Linear.untint(p);
  assert.equal(grey.r, 0.5);
  Linear.detach(p);
});
