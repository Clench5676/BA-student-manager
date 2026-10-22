// Execute the vendored frame loop, including its render-driven asset readiness, through the real thumb queue
// and NGUI background loader. Only the GPU and image transport are stand-ins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, test } from "node:test";
import { thumb, thumbnailScope } from "../../src/ba_modding_toolkit/web/js/thumbs.js";
import { setSpineConsent } from "../../src/ba_modding_toolkit/web/js/spine-runtime.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = [], players = [], images = [], encoded = [];
let focused = true, hidden = false, blank = false, stall = false, expressionOnly = false, missingBackground = false, nextBlob = 0, scheduledFrames = 0;
const docEvents = new EventTarget();
class Canvas extends EventTarget {
  width = 2; height = 1; ink = false; background = null;
  getContext() {
    return { measureText: () => ({ width: 0 }), drawImage: (image, ...rect) => {
      if (image instanceof Canvas) this.ink = image.ink;
      else { this.background = image.src; events.push(["background", ...rect]); }
    } };
  }
  toBlob(done) { encoded.push({ ink: this.ink, background: this.background }); done({}); }
}
globalThis.document = {
  get hidden() { return hidden; }, hasFocus: () => focused,
  addEventListener: (...args) => docEvents.addEventListener(...args),
  removeEventListener: (...args) => docEvents.removeEventListener(...args),
  body: { appendChild() {} },
  createElement: (tag) => tag === "canvas" ? new Canvas() : {
    style: {}, appendChild(child) { this.canvas = child; }, querySelector() { return this.canvas; }, remove() {},
  },
};
globalThis.window = new EventTarget();
globalThis.requestAnimationFrame = (done) => {
  scheduledFrames++;
  // A background window has no usable RAF clock. Foreground players can still load normally in the old code.
  return focused && !hidden ? setTimeout(done, 16) : 0;
};
globalThis.URL.createObjectURL = () => `blob:runtime-${++nextBlob}`;
globalThis.URL.revokeObjectURL = () => {};
globalThis.Image = class {
  naturalWidth = 1024; naturalHeight = 768;
  set src(url) {
    this.url = url; images.push(url);
    // The frozen still must already exist before image I/O yields to a later runtime frame.
    for (const player of players) if (!player.disposed) player.canvas.ink = false;
    setTimeout(() => {
      focused = true; window.dispatchEvent(new Event("focus"));
      if (missingBackground) this.onerror?.(new Error("Missing background")); else this.onload?.();
    }, 20);
  }
  get src() { return this.url; }
  removeAttribute() {}
};
const runtime = vm.createContext({ console, document, performance, requestAnimationFrame });
vm.runInContext(readFileSync(new URL("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js", import.meta.url), "utf8"), runtime);
const S = runtime.spine;
class Player {
  constructor(el, config) {
    Object.assign(this, { config: { debug: {}, controlBones: [], ...config }, skeleton: null, disposed: false,
      paused: true, stopRequestAnimationFrame: false, time: { delta: 0, update() {} }, viewport: {},
      previousViewport: null, currentViewport: { ...config.viewport }, bg: {}, bgFullscreen: {}, canvas: new Canvas(),
      draws: 0, assets: false });
    players.push(this); el.appendChild(this.canvas);
    this.context = { gl: { drawingBufferWidth: 2, drawingBufferHeight: 1, RGBA: 1, UNSIGNED_BYTE: 1,
      clearColor() {}, clear: () => { this.canvas.ink = false; },
      readPixels: (_x, _y, _w, _h, _format, _type, pixels) => {
        if (this.canvas.ink) pixels.set([80, 80, 80, 0, 80, 80, 80, 255]);
      } } };
    this.sceneRenderer = { camera: { position: {} }, skeletonDebugRenderer: {}, resize() {}, begin() {}, end() {},
      drawSkeleton: () => { this.canvas.ink = !blank && (!expressionOnly || this.animationState.getCurrent(1)?.animation.name === "00"); } };
    this.assetManager = { isLoadingComplete: () => this.assets };
    // The constructor's queued first frame precedes asynchronous texture/atlas completion. Finishing assets
    // alone cannot invoke success; another real drawFrame must discover them.
    queueMicrotask(() => this.drawFrame());
    if (!stall) this.assetTimer = setTimeout(() => { this.assets = true; events.push(["assets"]); }, 25);
  }
  drawFrame(loop = true) {
    this.draws++;
    S.SpinePlayer.prototype.drawFrame.call(this, loop);
  }
  loadSkeleton() {
    const data = new S.SkeletonJson({}).readSkeletonData({ bones: [{ name: "root" }], animations: expressionOnly ? { "00": {} } : { Idle_01: {} } });
    this.skeleton = new S.Skeleton(data);
    this.skeleton.getBounds = (offset, size) => { Object.assign(offset, { x: 0, y: 0 }); Object.assign(size, { x: 800, y: 1600 }); };
    this.animationState = new S.AnimationState(new S.AnimationStateData(data));
    events.push(["success"]); this.config.success(this);
  }
  setViewport() { this.currentViewport = { ...this.config.viewport }; }
  stopRendering() { S.SpinePlayer.prototype.stopRendering.call(this); }
  startRendering() { assert.fail("focus changes must not restart a still during background composition"); }
  showError(message) { this.config.error(this, message); }
  dispose() { clearTimeout(this.assetTimer); this.disposed = true; this.canvas.width = 0; }
}
globalThis.spine = { ...S, SpinePlayer: Player };
setSpineConsent(true);
const base = (name) => `/asset/spine/spr/${name}/${"a".repeat(64)}/skeleton`;
afterEach(async () => { await wait(25); focused = true; hidden = false; blank = false; stall = false; expressionOnly = false; missingBackground = false; });

test("an expression-only story portrait applies 00 before capture instead of encoding an empty setup pose", async () => {
  expressionOnly = true;
  assert.ok(await thumb(base("pajamas_expression_only"), "portrait"));
  assert.equal(players.at(-1).animationState.getCurrent(1).animation.name, "00");
  assert.equal(encoded.at(-1).ink, true);
});

test("a missing background retains the already validated portrait still", async () => {
  missingBackground = true;
  assert.ok(await thumb(base("portrait_missing_background"), "portrait", null, false, null, "/bg/missing"));
  assert.deepEqual(encoded.at(-1), { ink: true, background: null });
});

test("a cold background key loads and composes after plain card/bust cache hits with an inactive lifecycle", async () => {
  const source = base("shiroko_spr"), background = "/asset/art/bg/BG_Abydos_Collection";
  const count = players.length;
  assert.ok(await thumb(source, "card"));
  await wait(25);
  assert.ok(await thumb(source, "bust"));
  assert.equal(players.length, count + 1, "the plain bust uses the card's companion cache");
  focused = false;
  const url = await thumb(source, "bust", null, false, null, background);
  assert.ok(url, "the uncached background must load even when no runtime frames are scheduled");
  await wait(25);
  assert.equal(players.length, count + 2);
  assert.equal(scheduledFrames, 0, "the entire thumbnail load and capture owns its frame clock");
  assert.ok(players.at(-1).draws >= 3, "loading was explicitly driven after assets completed");
  assert.ok(images.includes(background), "use the real collectionStill -> ngui.load path");
  assert.deepEqual(encoded.at(-1), { ink: true, background });
  const [, x, y, w, h] = events.find((event) => event[0] === "background");
  assert.ok(x === 0 && y < 0 && w === 2 && h > 1, "background covers the frozen canvas without stretching");
  assert.equal(await thumb(source, "bust", null, false, null, background), url);
  assert.ok(await thumb(source, "card", null, false, null, background), "the companion keeps its background");
  assert.equal(players.length, count + 2);
});

for (const mode of ["unfocused", "hidden"]) test(`delayed asset readiness and blank rejection work while ${mode}`, async () => {
  focused = mode !== "unfocused"; hidden = mode === "hidden";
  blank = true;
  const at = encoded.length;
  assert.equal(await thumb(base(`blank_${mode}`), "face", null, false, null, "/bg/blank"), null);
  assert.equal(encoded.length, at, "a background cannot make a blank portrait pass validation");
  blank = false;
  assert.ok(await thumb(base(`healthy_${mode}`), "face"));
  await wait(0);
  assert.ok(players.at(-1).disposed);
});

test("cancellation retires manual loading frames and lets the next skeleton run", async () => {
  focused = false; stall = true;
  const scope = thumbnailScope(), pending = scope.thumb(base("cancel_loading"), "face");
  await wait(20);
  const retired = players.at(-1);
  scope.cancel(); assert.equal(await pending, null);
  await wait(20);
  const draws = retired.draws;
  stall = false;
  assert.ok(await thumb(base("after_cancel"), "face"));
  assert.equal(retired.draws, draws); assert.equal(retired.disposed, true);
});

test("a stalled inactive runtime exhausts one eight-second budget and disposes its manual clock", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    hidden = true; stall = true;
    const pending = thumb(base("deadline_loading"), "face");
    await new Promise(setImmediate);
    const retired = players.at(-1);
    t.mock.timers.tick(8000);
    assert.equal(await pending, null);
    await new Promise(setImmediate);
    assert.equal(retired.disposed, true);
    const draws = retired.draws;
    t.mock.timers.tick(60000);
    assert.equal(retired.draws, draws);
  } finally { t.mock.timers.reset(); }
});

test("every memorial lobby still uses revisioned prefab framing before its first encoded draw", async () => {
  const previous = globalThis.fetch, urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ view: { x: -1480, y: -832.5, w: 2960, h: 1665 },
      layer: { x: 37.5, y: -880, scale: .72 } }) };
  };
  try {
    assert.ok(await thumb(base("lobby_camera"), "landscape", null, true));
    const view = players.at(-1).config.viewport;
    assert.ok(urls[0].endsWith(`/${"a".repeat(64)}/framing.json`));
    assert.ok(Math.abs(view.x * .72 + 37.5 + 1480) < 1e-8);
    assert.ok(Math.abs(view.y * .72 - 880 + 832.5) < 1e-8);
    assert.equal(view.width * .72, 2960); assert.equal(view.height * .72, 1665);
  } finally { globalThis.fetch = previous; }
});
