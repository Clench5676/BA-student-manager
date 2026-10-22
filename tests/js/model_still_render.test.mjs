// Run ChibiView's actual GLTF/material/camera/capture path. Only the GPU and PNG encoder are stand-ins.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
const VENDOR = new URL("../../src/ba_modding_toolkit/web/vendor/three-0.160.0/", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec === "three") return { url: ${JSON.stringify(VENDOR + "build/three.module.min.js")}, shortCircuit: true };
  if (spec.startsWith("three/addons/")) return { url: ${JSON.stringify(VENDOR + "examples/jsm/")} + spec.slice(13), shortCircuit: true };
  return next(spec, ctx); }`)}`);
const { createStillView, FORMATION_VIEW, visibleStillFrame } = await import("../../src/ba_modding_toolkit/web/js/model.js");
const { OUTLINE } = await import("../../src/ba_modding_toolkit/web/js/chibi-materials.js");
const vertices = new Float32Array([-.3, 0, 0, .3, 0, 0, 0, 1.1, 0]);
const fixture = new TextEncoder().encode(JSON.stringify({
  asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(vertices.buffer).toString("base64")}`, byteLength: vertices.byteLength }],
  bufferViews: [{ buffer: 0, byteLength: vertices.byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-.3, 0, 0], max: [.3, 1.1, 0] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  materials: [{ extras: { kind: "unlit", colors: { _Color: [1, 0, 1, 1] } } }],
}));
const nativeFetch = globalThis.fetch, requests = [];
globalThis.fetch = (url, options) => {
  if (String(url.url || url).startsWith("data:")) return nativeFetch(url, options);
  requests.push([url, options]);
  return Promise.resolve({ ok: true, arrayBuffer: async () => fixture.buffer });
};
globalThis.ProgressEvent = class { constructor(type, options) { Object.assign(this, { type }, options); } };
globalThis.requestAnimationFrame = () => assert.fail("off-screen still must not use RAF");
let encode = "ready", draws = [], blobs = 0;
globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage: (canvas) => draws.push(canvas) }),
  toBlob: (done) => done(encode === "ready" ? {} : null) }) };
globalThis.URL.createObjectURL = () => `blob:3d-${++blobs}`;
function gpu({ blank = false, lost = false, blankAfterFit = false, lostAfterFit = false } = {}) {
  const calls = [];
  let renders = 0;
  return { calls, domElement: { remove() { calls.push("remove"); } },
    extensions: { has: () => false }, setPixelRatio(value) { calls.push(["ratio", value]); },
    setSize(w, h) { calls.push(["size", w, h]); }, compile: () => new Set(),
    render(scene, camera) {
      renders++;
      assert.ok(scene.children[0].children[0].material.isShaderMaterial, "the app's chibi shader replaces GLTF defaults");
      assert.equal(camera.fov, FORMATION_VIEW.fov); assert.equal(camera.aspect, 1);
      assert.ok(camera.position.z >= FORMATION_VIEW.distance);
      assert.equal(camera.position.y, FORMATION_VIEW.eye);
      assert.deepEqual(OUTLINE.outlineScale.value.toArray(), [.002, .002]);
      calls.push(["render", camera.view && { ...camera.view }]);
    },
    getContext: () => ({ isContextLost: () => lost || lostAfterFit && renders > 1, RGBA: 1, UNSIGNED_BYTE: 1,
      readPixels(_x, _y, w, h, _format, _type, pixels) {
        assert.equal(w, 640); assert.equal(h, 640);
        if (!blank && !(blankAfterFit && renders > 1)) for (let y = 200; y < 440; y++) for (let x = 270; x < 370; x++) pixels[(y * w + x) * 4 + 3] = 255;
        calls.push("read");
      } }),
    setAnimationLoop(value) { assert.equal(value, null); },
    dispose() { calls.push("dispose"); }, forceContextLoss() { calls.push("lose"); },
  };
}

test("a source-specific model uses the detail shaders and redraws its visible bounds at full resolution", async () => {
  const renderer = gpu(), view = createStillView({ renderer }), controller = new AbortController();
  try {
    await view.load("/asset/model/hina.glb?source=mod%3Apink", { signal: controller.signal });
    const url = await view.renderStill(controller.signal);
    assert.match(url, /^blob:3d-/); assert.equal(draws.at(-1), renderer.domElement, "freeze the validated GPU canvas before encoding");
    assert.equal(requests.at(-1)[1].cache, "no-store"); assert.equal(requests.at(-1)[1].signal, controller.signal);
    assert.equal(renderer.calls.at(-3), "read");
    assert.equal(renderer.calls.at(-1), "read", "validate the final fitted draw before encoding");
    const [step, frame] = renderer.calls.at(-2);
    assert.equal(step, "render");
    assert.equal(frame.width, 240 * 640 / 592);
    assert.equal(frame.height, frame.width);
    assert.equal(frame.offsetX, (640 - frame.width) / 2);
    assert.equal(frame.offsetY, (640 - frame.height) / 2);
  } finally { view.dispose(); }
  assert.deepEqual(renderer.calls.slice(-3), ["dispose", "lose", "remove"]);
});

test("visible still framing centres tall, wide, tiny, off-centre and edge silhouettes with a 24 px margin", () => {
  for (const [left, bottom, w, h] of [[270, 200, 100, 240], [20, 400, 400, 40], [450, 125, 2, 3], [0, 0, 640, 640], [0, 320, 10, 100]]) {
    const pixels = new Uint8Array(640 * 640 * 4);
    for (let y = bottom; y < bottom + h; y++) for (let x = left; x < left + w; x++) pixels[(y * 640 + x) * 4 + 3] = 255;
    const frame = visibleStillFrame(pixels, 640, 640), scale = 640 / frame.w;
    const x = (left - frame.x) * scale, y = (640 - bottom - h - frame.y) * scale;
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} vs ${b}`);
    near(frame.w, frame.h);
    near(x + w * scale / 2, 320); near(y + h * scale / 2, 320);
    near(Math.min(x, y), 24);
    near(Math.max(w, h) * scale, 592);
  }
  assert.throws(() => visibleStillFrame(new Uint8Array(640 * 640 * 4), 640, 640), /no visible pixels/);
});

for (const mode of ["blank", "lost", "encoder", "blankAfterFit", "lostAfterFit"]) test(`${mode} renders cannot be cached as valid stills`, async () => {
  const renderer = gpu({ [mode]: true }), view = createStillView({ renderer });
  try {
    await view.load("/asset/model/pajamas.glb?source=official", { signal: new AbortController().signal });
    encode = mode === "encoder" ? "failed" : "ready";
    await assert.rejects(view.renderStill(new AbortController().signal), /no visible pixels|context lost|PNG encoding failed/);
  } finally { view.dispose(); encode = "ready"; }
});
