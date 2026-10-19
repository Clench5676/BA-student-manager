// Tests for the 3D tab's zoom and pan (web/js/model.js): how far a wheel notch and a pinch zoom, the target's lift to
// the face, the pan's limits, and which input zooms or pans in WebKit (the macOS app's WKWebView), Chromium (WebView2)
// and on a touch screen. Run by tests/test_chibi_materials.py with Node's test runner; "three" and "three/addons/"
// resolve to the bundled copy.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

const VENDOR = new URL("../../src/ba_modding_toolkit/web/vendor/three-0.160.0/", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec === "three") return { url: ${JSON.stringify(VENDOR + "build/three.module.min.js")}, shortCircuit: true };
  if (spec.startsWith("three/addons/")) return { url: ${JSON.stringify(VENDOR + "examples/jsm/")} + spec.slice(13), shortCircuit: true };
  return next(spec, ctx); }`)}`);
const { attachInput, bustDistance, clampPan, frameDistance, liftShare, pinchZoom, wheelZoom, zoomShare } =
  await import("../../src/ba_modding_toolkit/web/js/model.js");

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const TAN5 = Math.tan((5 * Math.PI) / 180);
const FULL = { x: 960, y: 540, w: 1920, h: 1080, floor: 1056 };
const LEFT = { x: 490, y: 500, w: 1000, h: 1080, floor: 700 };
// Koharu's box with its halo around the orbit target (0.44 above the feet), her face 0.34 above the target
const KOHARU = { min: { x: -0.5, y: -0.4426, z: -0.3 }, max: { x: 0.45, y: 0.68, z: 0.3 } };
const FACE = 0.34;
const rangeOf = (frame) => { const fit = frameDistance(KOHARU, frame); return { fit, min: bustDistance(KOHARU, FACE, frame, fit) }; };
const spanOf = ({ fit, min }) => Math.log(fit / min);

test("five notches from the front view to the bust, whatever sends them", () => {
  for (const frame of [LEFT, FULL]) {
    const range = rangeOf(frame), span = spanOf(range);
    const after = (px, n) => { let d = range.fit; for (let i = 0; i < n; i++) d *= wheelZoom(px, span); return d; };
    // a Chromium / WebView2 notch (100 px), Firefox's 3 lines (120 px), a slow macOS notch (a tenth of a line: 4 px,
    // zoomed as far as a Chromium notch) and a whole line (40 px)
    for (const px of [-100, -4.000244140625, -40]) {
      near(zoomShare(after(px, 1), range), 0.2);
      near(after(px, 5), range.min, 1e-9);
    }
    near(zoomShare(after(-120, 1), range), 0.24);
    // a fast spin's bigger steps zoom further; the other way backs away as far
    near(zoomShare(after(-400, 1), range), 0.8);
    near(wheelZoom(100, span) * wheelZoom(-100, span), 1);
    assert.equal(wheelZoom(0, span), 1);
    // the step back (1.3 of the fit) is about one notch out
    assert.ok(after(100, 1) / range.fit > 1.2 && after(100, 1) / range.fit < 1.3);
  }
});

test("a pinch zooms half as far again as the fingers spread: one pinch to the bust", () => {
  near(pinchZoom(2), 2 ** -1.5);
  near(pinchZoom(2) * pinchZoom(0.5), 1);
  assert.equal(pinchZoom(0), 1);
  for (const frame of [LEFT, FULL]) {
    const range = rangeOf(frame);
    assert.ok(zoomShare(range.fit * pinchZoom(2.2), range) > 0.9); // a pinch of 2.2 x: (nearly) the bust
    assert.ok(range.fit * pinchZoom(2.5) < range.min);
  }
});

test("closing in brings the face to the frame point evenly, notch by notch", () => {
  for (const frame of [LEFT, FULL]) {
    const range = rangeOf(frame), span = spanOf(range);
    // the face's height above the frame point (the lifted target), in stage px
    const facePx = (d) => FACE * (1 - liftShare(d, range)) * (frame.h / (2 * d * TAN5));
    const start = facePx(range.fit);
    let d = range.fit;
    for (let i = 1; i <= 5; i++) {
      d *= wheelZoom(-100, span);
      near(facePx(d), start * (1 - i / 5), 1e-6);
    }
    // the lift eased by distance it replaces had risen two thirds of the way after the first notch
    const t = (range.fit - range.fit * wheelZoom(-100, span)) / (range.fit - range.min);
    assert.ok(1 - (1 - t) ** 3 > 0.65);
    // none at the fit and further back, all of it at the bust
    assert.equal(liftShare(range.fit, range), 0);
    assert.equal(liftShare(range.fit * 1.3, range), 0);
    near(liftShare(range.min, range), 1);
  }
});

test("the pan stays inside the chibi's box as far as the zoom allows", () => {
  const p = (x, y, z) => ({ x, y, z });
  const same = (a, b) => { for (const k of ["x", "y", "z"]) near(a[k], b[k]); };
  // at the fit (and further back) nothing moves
  same(clampPan(p(1, -2, 0.5), 0, KOHARU, 0), p(0, 0, 0));
  same(clampPan(p(1, -2, 0.5), -0.3, KOHARU, 0), p(0, 0, 0));
  // at the bust the target reaches the box: down to the feet, up to the halo's top, from the lifted target
  same(clampPan(p(1, -2, 0.5), 1, KOHARU, FACE), p(0.45, KOHARU.min.y - FACE, 0.3));
  same(clampPan(p(-1, 2, -0.5), 1, KOHARU, FACE), p(-0.5, KOHARU.max.y - FACE, -0.3));
  // halfway, half the box; a pan inside it stays
  const half = clampPan(p(1, 2, 0), 0.5, KOHARU, FACE);
  near(half.x, 0.225);
  near(half.y, (KOHARU.max.y - FACE) / 2);
  same(clampPan(p(0.1, -0.1, 0), 0.5, KOHARU, FACE), p(0.1, -0.1, 0));
});

// WebKit's DOM events (as in lobby_wheel.test.mjs): a wheel notch in NSEvent line deltas (lines x 40 px, ticks x 120),
// a trackpad step in whole pixels with wheelDeltaY 3 x deltaY; Chromium's notches of 100 px (120)
const FIXED = 65536;
const webkitWheel = (tenths) => {
  const lines = (Math.round(Math.abs(tenths) * 0.1 * FIXED) / FIXED) * Math.sign(tenths);
  return { deltaMode: 0, deltaX: 0, deltaY: Math.fround(-lines * 40), wheelDeltaX: 0, wheelDeltaY: Math.trunc(lines * 120) };
};
const webkitPad = (dy, dx = 0) => ({ deltaMode: 0, deltaX: dx, deltaY: dy, wheelDeltaX: Math.trunc(-3 * dx), wheelDeltaY: Math.trunc(-3 * dy) });
const chromium = (notches) => ({ deltaMode: 0, deltaX: 0, deltaY: -100 * notches, wheelDeltaX: 0, wheelDeltaY: 120 * notches });
const SPAN = 1.2;

// an element whose listeners the test calls, a view that records the zoom and pan, and a clock the test moves
function rig() {
  const calls = [], handlers = {};
  let goal = 10;
  const sink = {
    zoom: (f) => { calls.push(["zoom", f]); goal *= f; },
    zoomGoal: () => goal,
    setZoomGoal: (d) => { calls.push(["restore", d]); goal = d; },
    span: () => SPAN,
    pan: (dx, dy) => calls.push(["pan", dx, dy]),
  };
  const el = { addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener: (type) => { delete handlers[type]; } };
  const detach = attachInput(el, sink);
  let now = 10000;
  const real = performance.now;
  performance.now = () => now;
  const fire = (type, e, after = 16) => { now += after; handlers[type]({ preventDefault() {}, ctrlKey: false, ...e }); };
  const wheel = (e, after) => fire("wheel", e, after);
  const done = () => { detach(); performance.now = real; assert.deepEqual(Object.keys(handlers), []); };
  return { calls, fire, wheel, done, goal: () => goal };
}

test("WebKit: a wheel zooms by notches, a trackpad swipe pans as far as the fingers", () => {
  const r = rig();
  try {
    r.wheel(webkitWheel(1), 1000);
    r.wheel(webkitWheel(3), 40);
    r.wheel(webkitWheel(-1), 1000);
    assert.deepEqual(r.calls.map((c) => c[0]), ["zoom", "zoom", "zoom"]);
    near(r.calls[0][1], wheelZoom(-100, SPAN));
    near(r.calls[1][1], wheelZoom(-100, SPAN));
    near(r.calls[2][1], wheelZoom(100, SPAN));
    r.calls.length = 0;
    const swipe = [1, 3, 6, 10, 14, 12, 8, 4, 4, 8, 2, 1];
    r.wheel(webkitPad(swipe[0]), 1000);
    for (const dy of swipe.slice(1)) r.wheel(webkitPad(dy));
    assert.ok(r.calls.every((c) => c[0] === "pan"), JSON.stringify(r.calls));
    assert.equal(r.calls.reduce((s, c) => s - c[2], 0), swipe.reduce((a, b) => a + b));
    // sideways too
    r.calls.length = 0;
    r.wheel(webkitPad(2, 5), 1000);
    assert.deepEqual(r.calls, [["pan", -5, -2]]);
  } finally { r.done(); }
});

test("WebKit: a swipe that starts like a whole line takes its zoom back and pans", () => {
  const r = rig();
  try {
    const start = r.goal();
    r.wheel(webkitPad(40), 1000);
    r.wheel(webkitPad(37));
    r.wheel(webkitPad(31));
    assert.deepEqual(r.calls.map((c) => c[0]), ["zoom", "restore", "pan", "pan"]);
    assert.equal(r.goal(), start);
  } finally { r.done(); }
});

test("WebKit: a trackpad pinch zooms by its gesture events, and its ctrl + wheel events are left to them", () => {
  const r = rig();
  try {
    r.fire("gesturestart", { scale: 1 }, 1000);
    r.fire("gesturechange", { scale: 1.5 });
    r.wheel({ ...webkitPad(-3), ctrlKey: true });
    r.fire("gesturechange", { scale: 2 });
    r.fire("gestureend", { scale: 2 });
    r.wheel({ ...webkitPad(-3), ctrlKey: true }, 100);
    assert.deepEqual(r.calls.map((c) => c[0]), ["zoom", "zoom"]);
    near(r.calls[0][1] * r.calls[1][1], pinchZoom(2));
    // later, ctrl + wheel zooms again
    r.wheel({ ...webkitPad(-3), ctrlKey: true }, 400);
    assert.equal(r.calls.length, 3);
  } finally { r.done(); }
});

test("Chromium: notches zoom, a horizontal notch pans, a pinch (ctrl + wheel) zooms by its scale", () => {
  const r = rig();
  try {
    r.wheel(chromium(1), 1000);
    near(r.calls[0][1], wheelZoom(-100, SPAN));
    r.wheel({ deltaMode: 0, deltaX: 100, deltaY: 0, wheelDeltaX: -120, wheelDeltaY: 0 }, 1000);
    assert.deepEqual(r.calls[1], ["pan", -100, 0]);
    // a pinch to 2 x in fractional steps: deltaY = -100 ln(scale) in all
    r.calls.length = 0;
    for (let i = 0; i < 10; i++) r.wheel({ deltaMode: 0, deltaX: 0, deltaY: (-100 * Math.log(2)) / 10, wheelDeltaY: 3, ctrlKey: true });
    near(r.calls.reduce((f, c) => f * c[1], 1), pinchZoom(2));
    // ctrl + a mouse wheel notch zooms by notches; Firefox's lines too
    r.calls.length = 0;
    r.wheel({ ...chromium(1), ctrlKey: true }, 1000);
    r.wheel({ deltaMode: 1, deltaX: 0, deltaY: -3 }, 1000);
    near(r.calls[0][1], wheelZoom(-100, SPAN));
    near(r.calls[1][1], wheelZoom(-120, SPAN));
  } finally { r.done(); }
});

test("touch: two fingers pinch, a right- or middle-button drag pans, a left drag is the orbit's", () => {
  const r = rig();
  const p = (id, x, y, extra = {}) => ({ pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0, ...extra });
  try {
    r.fire("pointerdown", p(1, 100, 100));
    r.fire("pointermove", p(1, 110, 100)); // one finger: the orbit's
    r.fire("pointerdown", p(2, 210, 100));
    r.fire("pointermove", p(2, 310, 100)); // 100 -> 200 px apart
    r.fire("pointermove", p(1, 10, 100)); // 200 -> 300
    r.fire("pointerup", p(1, 10, 100));
    r.fire("pointermove", p(2, 400, 100)); // a lone finger again
    r.fire("pointerup", p(2, 400, 100));
    assert.deepEqual(r.calls.map((c) => c[0]), ["zoom", "zoom"]);
    near(r.calls[0][1] * r.calls[1][1], pinchZoom(3));
    // WebKit on a touch screen sends gesture events for the pinch too: it zooms once
    r.calls.length = 0;
    r.fire("pointerdown", p(3, 100, 100));
    r.fire("pointerdown", p(4, 200, 100));
    r.fire("gesturestart", { scale: 1 });
    r.fire("pointermove", p(4, 300, 100));
    r.fire("gesturechange", { scale: 2 });
    r.fire("gestureend", { scale: 2 });
    r.fire("pointerup", p(3, 100, 100));
    r.fire("pointerup", p(4, 300, 100));
    assert.equal(r.calls.length, 1);
    near(r.calls[0][1], pinchZoom(2));
    // mouse buttons
    r.calls.length = 0;
    const m = (x, y, button) => ({ pointerId: 9, pointerType: "mouse", clientX: x, clientY: y, button });
    r.fire("pointerdown", m(0, 0, 0));
    r.fire("pointermove", m(30, 0, -1));
    r.fire("pointerup", m(30, 0, 0));
    assert.deepEqual(r.calls, []);
    for (const button of [2, 1]) {
      r.fire("pointerdown", m(0, 0, button));
      r.fire("pointermove", m(5, 20, -1));
      r.fire("pointermove", m(15, 25, -1));
      r.fire("pointerup", m(15, 25, button));
      r.fire("pointermove", m(50, 50, -1));
    }
    assert.deepEqual(r.calls, [["pan", 5, 20], ["pan", 10, 5], ["pan", 5, 20], ["pan", 10, 5]]);
  } finally { r.done(); }
});
