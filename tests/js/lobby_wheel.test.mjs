// Tests for the fullscreen lobby's wheel handling (web/js/lobby-touch.js): a mouse wheel zooms and a trackpad swipe
// pans, in WebKit (the macOS app's WKWebView: wheelDeltaY is 3 x deltaY for every device) and in Chromium (WebView2:
// notches of 120). Run by tests/test_lobby_view.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as Touch from "../../src/ba_modding_toolkit/web/js/lobby-touch.js";

globalThis.document ??= { addEventListener() {}, removeEventListener() {} };

// WebKit's DOM event for a wheel (NSEvent line deltas: lines x 40 px, ticks x 120) and for a trackpad (pixels)
const FIXED = 65536;
const webkitWheel = (tenths, { round = Math.round } = {}) => {
  const lines = round(Math.abs(tenths) * 0.1 * FIXED) / FIXED * Math.sign(tenths);
  return { deltaMode: 0, deltaX: 0, deltaY: Math.fround(-lines * 40), wheelDeltaX: 0, wheelDeltaY: Math.trunc(lines * 120) };
};
const webkitPad = (dy, dx = 0) => ({ deltaMode: 0, deltaX: dx, deltaY: dy, wheelDeltaX: Math.trunc(-3 * dx), wheelDeltaY: Math.trunc(-3 * dy) });
const chromium = (notches) => ({ deltaMode: 0, deltaX: 0, deltaY: -100 * notches, wheelDeltaX: 0, wheelDeltaY: 120 * notches });

test("one event: notches, trackpad steps and the ones that could be either", () => {
  // a slow notch is a tenth of a line, rounded or cut to 16.16 fixed point: 4.000244 or 3.99963 px, wheelDeltaY 12 or 11
  for (const tenths of [1, -1, 2, 3, 7, 12, 23, 41, 127]) {
    assert.equal(Touch.wheelStep(webkitWheel(tenths)), "notch", `tenths ${tenths}`);
    assert.equal(Touch.wheelStep(webkitWheel(tenths, { round: Math.floor })), "notch", `tenths ${tenths}, cut`);
  }
  assert.equal(Touch.wheelStep({ deltaMode: 0, deltaX: 0, deltaY: -3.9996337890625, wheelDeltaY: 11 }), "notch");
  // half and whole lines are whole pixels, as a trackpad's steps are
  for (const tenths of [5, 10, 20, 30]) assert.equal(Touch.wheelStep(webkitWheel(tenths)), "maybe", `tenths ${tenths}`);
  // a trackpad: whole pixels, a gesture's start with no delta, both axes
  for (const dy of [1, 2, 3, 4, 8, 12, 13, 37, -16]) assert.equal(Touch.wheelStep(webkitPad(dy)), "smooth", `dy ${dy}`);
  assert.equal(Touch.wheelStep(webkitPad(0)), "smooth");
  assert.equal(Touch.wheelStep(webkitPad(5, 2)), "smooth");
  // lines, Chromium's notches, a horizontal notch
  assert.equal(Touch.wheelStep({ deltaMode: 1, deltaX: 0, deltaY: 3 }), "notch");
  assert.equal(Touch.wheelStep(chromium(1)), "notch");
  assert.equal(Touch.wheelStep({ deltaMode: 0, deltaX: 100, deltaY: 0, wheelDeltaX: -120, wheelDeltaY: 0 }), "notch");
  // Chromium on a trackpad: fractions, wheelDeltaY not in notches
  assert.equal(Touch.wheelStep({ deltaMode: 0, deltaX: 0, deltaY: 4.5, wheelDeltaY: -5 }), "smooth");
});

// a lobby whose zoom and pan are recorded, a host of the stage's size, and a clock the test moves
function rig() {
  const calls = [];
  let target = { x: 0, y: 0, w: 2960, h: 1665 };
  const lobby = {
    zoomAt: (f, sx, sy) => { calls.push(["zoom", f]); target = { ...target, w: target.w / f }; },
    panBy: (dx, dy) => calls.push(["pan", dx, dy]),
    viewTarget: () => target,
    setViewTarget: (v) => { calls.push(["restore", v.w]); target = v; },
  };
  const handlers = {};
  const host = { addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }), classList: { toggle() {}, remove() {} } };
  Touch.setup(lobby);
  Touch.attach(host);
  let now = 10000;
  const real = performance.now;
  performance.now = () => now;
  const send = (e, after = 16) => { now += after; handlers.wheel({ clientX: 960, clientY: 540, ctrlKey: false, preventDefault() {}, ...e }); };
  const done = () => { Touch.detach(); Touch.setup(null); performance.now = real; };
  return { calls, send, done, width: () => target.w };
}

test("WebKit: a wheel spin zooms, a notch at least a line's worth", () => {
  const r = rig();
  try {
    r.send(webkitWheel(1), 1000);
    r.send(webkitWheel(3), 40);
    r.send(webkitWheel(12), 40);
    assert.deepEqual(r.calls.map((c) => c[0]), ["zoom", "zoom", "zoom"]);
    // 4 px and 12 px zoom like a line (40 px), 48 px is 48 px
    assert.ok(Math.abs(r.calls[0][1] - Math.exp(40 * 0.0015)) < 1e-6);
    assert.ok(Math.abs(r.calls[1][1] - Math.exp(40 * 0.0015)) < 1e-6);
    assert.ok(Math.abs(r.calls[2][1] - Math.exp(48 * 0.0015)) < 1e-4);
    // the other way zooms out
    r.send(webkitWheel(-1), 1000);
    assert.ok(r.calls[3][1] < 1);
  } finally { r.done(); }
});

test("WebKit: a trackpad swipe and its momentum pan", () => {
  const r = rig();
  try {
    for (const dy of [1, 3, 6, 10, 14, 12, 8, 4, 4, 8, 2, 1]) r.send(webkitPad(dy));
    assert.ok(r.calls.every((c) => c[0] === "pan"), JSON.stringify(r.calls));
  } finally { r.done(); }
});

test("WebKit: a swipe that starts like a whole line zooms back to where it was and pans", () => {
  const r = rig();
  try {
    const start = r.width();
    r.send(webkitPad(40), 1000);
    r.send(webkitPad(37));
    r.send(webkitPad(31));
    assert.deepEqual(r.calls.map((c) => c[0]), ["zoom", "restore", "pan", "pan"]);
    assert.equal(r.width(), start);
  } finally { r.done(); }
});

test("WebKit: a wheel without acceleration (whole lines) zooms on every notch", () => {
  const r = rig();
  try {
    for (let i = 0; i < 3; i++) r.send(webkitWheel(10), 300);
    for (let i = 0; i < 3; i++) r.send(webkitWheel(30), 40);
    assert.ok(r.calls.every((c) => c[0] === "zoom"), JSON.stringify(r.calls));
  } finally { r.done(); }
});

test("Chromium: a touchpad swipe whose first step is exactly a notch zooms back to where it was and pans", () => {
  // Windows precision touchpads in Chromium / WebView2: pixel steps with wheelDelta 1.2 x deltaY, the first one
  // sometimes a round 100 px (120)
  const pad = (dy) => ({ deltaMode: 0, deltaX: 0, deltaY: dy, wheelDeltaX: 0, wheelDeltaY: Math.round(-1.2 * dy) });
  const r = rig();
  try {
    const start = r.width();
    r.send(pad(100), 1000);
    r.send(pad(37));
    r.send(pad(21));
    assert.deepEqual(r.calls.map((c) => c[0]), ["zoom", "restore", "pan", "pan"]);
    assert.equal(r.width(), start);
  } finally { r.done(); }
});

test("Chromium: a wheel spun notch after notch keeps every zoom", () => {
  const r = rig();
  try {
    for (let i = 0; i < 4; i++) r.send(chromium(-1), 40);
    assert.deepEqual(r.calls.map((c) => c[0]), ["zoom", "zoom", "zoom", "zoom"]);
  } finally { r.done(); }
});

test("Chromium: notches zoom, a horizontal notch pans", () => {
  const r = rig();
  try {
    r.send(chromium(1), 1000);
    assert.ok(Math.abs(r.calls[0][1] - Math.exp(100 * 0.0015)) < 1e-6);
    r.send({ deltaMode: 0, deltaX: 100, deltaY: 0, wheelDeltaX: -120, wheelDeltaY: 0 }, 1000);
    assert.deepEqual(r.calls[1], ["pan", -100, 0]);
  } finally { r.done(); }
});
