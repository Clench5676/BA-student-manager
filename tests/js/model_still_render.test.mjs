// Run ChibiView's actual GLTF/material/camera/capture path. Only the GPU and PNG encoder are stand-ins.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
const VENDOR = new URL("../../src/ba_modding_toolkit/web/vendor/three-0.160.0/", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec === "three") return { url: ${JSON.stringify(VENDOR + "build/three.module.min.js")}, shortCircuit: true };
  if (spec.startsWith("three/addons/")) return { url: ${JSON.stringify(VENDOR + "examples/jsm/")} + spec.slice(13), shortCircuit: true };
  return next(spec, ctx); }`)}`);
const { createStillView, FORMATION_VIEW } = await import("../../src/ba_modding_toolkit/web/js/model.js");
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
function gpu({ blank = false, lost = false } = {}) {
  const calls = [];
  return { calls, domElement: { remove() { calls.push("remove"); } },
    extensions: { has: () => false }, setPixelRatio(value) { calls.push(["ratio", value]); },
    setSize(w, h) { calls.push(["size", w, h]); }, compile: () => new Set(),
    render(scene, camera) {
      assert.ok(scene.children[0].children[0].material.isShaderMaterial, "the app's chibi shader replaces GLTF defaults");
      assert.equal(camera.fov, FORMATION_VIEW.fov); assert.equal(camera.aspect, 1);
      assert.ok(camera.position.z >= FORMATION_VIEW.distance);
      assert.equal(camera.position.y, FORMATION_VIEW.eye);
      assert.deepEqual(OUTLINE.outlineScale.value.toArray(), [.002, .002]);
      calls.push("render");
    },
    getContext: () => ({ isContextLost: () => lost, RGBA: 1, UNSIGNED_BYTE: 1,
      readPixels(_x, _y, w, h, _format, _type, pixels) {
        assert.equal(w, 640); assert.equal(h, 640);
        if (!blank) pixels.set([255, 0, 255, 255]); calls.push("read");
      } }),
    setAnimationLoop(value) { assert.equal(value, null); },
    dispose() { calls.push("dispose"); }, forceContextLoss() { calls.push("lose"); },
  };
}

test("a source-specific model uses the detail renderer's materials and square formation frame", async () => {
  const renderer = gpu(), view = createStillView({ renderer }), controller = new AbortController();
  try {
    await view.load("/asset/model/hina.glb?source=mod%3Apink", { signal: controller.signal });
    const url = await view.renderStill(controller.signal);
    assert.match(url, /^blob:3d-/); assert.equal(draws.at(-1), renderer.domElement, "freeze the validated GPU canvas before encoding");
    assert.equal(requests.at(-1)[1].cache, "no-store"); assert.equal(requests.at(-1)[1].signal, controller.signal);
    assert.deepEqual(renderer.calls.slice(-2), ["render", "read"]);
  } finally { view.dispose(); }
  assert.deepEqual(renderer.calls.slice(-3), ["dispose", "lose", "remove"]);
});

for (const mode of ["blank", "lost", "encoder"]) test(`${mode} renders cannot be cached as valid stills`, async () => {
  const renderer = gpu({ blank: mode === "blank", lost: mode === "lost" }), view = createStillView({ renderer });
  try {
    await view.load("/asset/model/pajamas.glb?source=official", { signal: new AbortController().signal });
    encode = mode === "encoder" ? "failed" : "ready";
    await assert.rejects(view.renderStill(new AbortController().signal), /no visible pixels|context lost|PNG encoding failed/);
  } finally { view.dispose(); encode = "ready"; }
});
