// Tests for web/js/touch-fx.js (the game's touch effect, simulated) and the pointer syntax of web/js/cursor.js, run
// by tests/test_touch_fx.py with Node's test runner: node --test tests/js/touch_fx.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FX, arcState, curve, drag, flashState, gradient, overBlend, press, release, sparkState, step, toLinear, toSrgb,
  trailState,
} from "../../src/ba_modding_toolkit/web/js/touch-fx.js";
import { cursorValue } from "../../src/ba_modding_toolkit/web/js/cursor.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
// a fixed sequence instead of Math.random
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };

test("curves are Unity's: the keys, clamped outside, Hermite between", () => {
  const keys = FX.arc.sizeCurve;
  near(curve(keys, 0), keys[0][1]);
  near(curve(keys, keys[1][0]), keys[1][1]);
  near(curve(keys, 2), 1);
  // zero tangents: a smoothstep between the two values
  near(curve([[0, 0, 0, 0], [1, 1, 0, 0]], 0.5), 0.5);
  near(curve([[0, 0, 0, 0], [1, 1, 0, 0]], 0.25), 0.15625);
  // a straight line keeps its slope
  near(curve([[0, 0, 2, 2], [1, 2, 2, 2]], 0.3), 0.6);
  // the dissolve threshold: hidden at the start, the whole ring at 0.2, gone at the end
  near(curve(FX.arc.dissolve, 0), 1);
  near(curve(FX.arc.dissolve, 0.2), 0);
  near(curve(FX.arc.dissolve, 1), 1);
});

test("gradients blend their stored values and hold the end keys", () => {
  const g = FX.flash.color;
  assert.deepEqual(gradient(g, 0), [1, 1, 1, 1]);
  const mid = gradient(g, 0.06029602502479591);
  near(mid[0], (1 + 0.24056601524353027) / 2);
  near(gradient(g, 1)[3], 0);
  assert.deepEqual(gradient(FX.trail.color, 0).slice(0, 3), [0, 0.3905813694000244, 1]);
});

test("colours convert like Unity's GammaToLinearSpace, HDR by a 2.2 power", () => {
  near(toLinear(0), 0);
  near(toLinear(1), 1);
  near(toLinear(0.5), 0.21404114048223255);
  near(toLinear(2), Math.pow(2, 2.2));
  near(toSrgb(toLinear(0.3)), 0.3);
  assert.equal(toSrgb(5), 1);
  assert.equal(toSrgb(-1), 0);
});

test("a press makes the bursts of FX_Touch at the pointer", () => {
  const fx = press(1, 0.5, 10, seq(0.5));
  const kinds = fx.items.map((p) => p.kind);
  assert.equal(kinds.filter((k) => k === "arc").length, 2);
  assert.equal(kinds.filter((k) => k === "flash").length, 1);
  assert.equal(kinds.filter((k) => k === "spark").length, 4);
  assert.deepEqual([fx.ox, fx.oy, fx.x, fx.y], [1, 0.5, 1, 0.5]);
  const arc = fx.items[0];
  near(arc.size, 0.13);
  near(arc.life, 0.6);
  // the burst triangles leave the edge of a circle 0.3 x the system's scale wide, outwards
  const spark = fx.items.find((p) => p.kind === "spark"), st = sparkState(spark, 10);
  near(Math.hypot(st.x - 1, st.y - 0.5), 0.3 * FX.burst.scale);
  const later = sparkState(spark, 10.2);
  near(Math.hypot(later.x - 1, later.y - 0.5), 0.3 * FX.burst.scale + spark.speed * 0.2);
  near(spark.speed, 0.35 * FX.burst.scale);
  near(spark.life, 0.65);
});

test("the sparks pick a frame from their random start and frame over time", () => {
  assert.equal(press(0, 0, 0, seq(0.1)).items.find((p) => p.kind === "spark").frame, 0);
  // frame over time 0.45 of two frames (0.9) plus start frame 0.45: the second frame
  assert.equal(press(0, 0, 0, seq(0.9)).items.find((p) => p.kind === "spark").frame, 1);
});

test("a drag emits 5 triangles per unit and records the trail past its minimum distance", () => {
  const fx = press(0, 0, 0, seq(0.5));
  const before = fx.items.length;
  drag(fx, 1, 0, 0.1, seq(0.5));
  assert.equal(fx.items.length - before, 5);
  const emitted = fx.items.slice(before);
  assert.ok(emitted.every((p) => p.def === FX.drag));
  near(emitted[0].x, 0.2);
  near(emitted[4].x, 1);
  // part of an emission carries over to the next move
  drag(fx, 1.1, 0, 0.12, seq(0.5));
  assert.equal(fx.items.length - before, 5);
  drag(fx, 1.2, 0, 0.14, seq(0.5));
  assert.equal(fx.items.length - before, 6);
  assert.deepEqual(fx.trail.map((p) => p.x), [0, 1, 1.1, 1.2]);
  // closer than 0.01 units: no new trail point, the head still moves
  drag(fx, 1.205, 0, 0.15, seq(0.5));
  assert.equal(fx.trail.length, 4);
  assert.equal(fx.x, 1.205);
  // the burst stays where it was pressed
  assert.deepEqual([fx.ox, fx.oy], [0, 0]);
});

test("reduced motion: the drag leaves neither trail nor triangles", () => {
  const fx = press(0, 0, 0, seq(0.5));
  const before = fx.items.length;
  drag(fx, 1, 0, 0.1, seq(0.5), { trail: false, sparks: false });
  assert.equal(fx.items.length, before);
  assert.equal(fx.trail.length, 0); // nor a line from the head back to the press
  assert.deepEqual(trailState(fx).segments, []);
  assert.equal(fx.x, 1);
});

test("the drag triangles are capped at the system's 50", () => {
  const fx = press(0, 0, 0, seq(0.5));
  drag(fx, 20, 0, 0.1, seq(0.5));
  assert.equal(fx.items.filter((p) => p.def === FX.drag).length, FX.drag.max);
});

test("step expires parts by their lifetime and ends after the release", () => {
  const fx = press(0, 0, 0, seq(0.5));
  assert.equal(step(fx, 0.1), true);
  assert.equal(fx.items.filter((p) => p.kind === "flash").length, 1);
  step(fx, 0.25);
  assert.equal(fx.items.filter((p) => p.kind === "flash").length, 0);
  // the first trail point is older than 0.3 s
  step(fx, 0.35);
  assert.equal(fx.trail.length, 0);
  release(fx, 0.4);
  assert.equal(step(fx, 0.7), false);
  assert.equal(fx.items.length, 0);
});

test("the trail is cleared when the system stops, a second after the release", () => {
  const fx = press(0, 0, 0, seq(0.5));
  release(fx, 0);
  fx.trail.push({ x: 1, y: 0, t: 1.05 }); // as if a point were still young
  step(fx, 0.99);
  step(fx, 1.0);
  assert.equal(fx.trail.length, 0);
});

test("arcs spin with their angular velocity curves", () => {
  const fx = press(0, 0, 0, seq(0, 0.5, 0, 0));
  const arc = fx.items[0], start = arc.rot;
  for (let t = 1; t <= 6; t++) step(fx, t / 100);
  // at the start both curves are at their first keys: about 11.17 rad/s, between 0.8 and 1 of it
  const turned = arc.rot - start;
  assert.ok(turned > 0.06 * FX.arc.spin.scale * 0.79 && turned < 0.06 * FX.arc.spin.scale * 1.01, String(turned));
  const st = arcState(arc, 0.12);
  near(st.threshold, curve(FX.arc.dissolve, 0.2));
  assert.ok(st.color.every((c) => c > 1)); // white light, bright enough to saturate
});

test("the flash fades its alpha but keeps adding its colour", () => {
  const p = press(0, 0, 0, seq(0.5)).items.find((x) => x.kind === "flash");
  const early = flashState(p, 0.01), late = flashState(p, 0.19);
  near(early.alpha, 1);
  assert.ok(late.alpha < 0.1);
  near(late.size, FX.flash.size * curve(FX.flash.sizeCurve, 0.95));
  near(late.color[2], toLinear(1) * toLinear(2));
});

test("overBlend matches the game's blend over black and over white", () => {
  const color = [0.22, 0.58, 1.6], alpha = 0.56;
  const { add, keep } = overBlend(color, alpha);
  const screen = (base, k, a) => base * k + a - base * k * a;
  for (let i = 0; i < 3; i++) {
    near(screen(0, keep[i], add[i]), toSrgb(color[i]));
    near(screen(1, keep[i], add[i]), toSrgb(1 - alpha + color[i]));
  }
});

test("the trail runs from the head back to its oldest point, coloured along its length", () => {
  const fx = press(0, 0, 0, seq(0.5));
  drag(fx, 0.5, 0, 0.05, seq(0.5));
  drag(fx, 1, 0, 0.1, seq(0.5));
  const st = trailState(fx);
  assert.deepEqual(st.points.map((p) => p.x), [1, 1, 0.5, 0]);
  near(st.length, 1);
  assert.equal(st.segments.length, 2); // the head on its newest point adds no segment
  near(st.segments[0].u, 0.25);
  near(st.segments[1].u, 0.75);
  assert.ok(st.segments[0].color[2] > st.segments[1].color[2]);
  assert.deepEqual(trailState(press(0, 0, 0)).segments, []);
});

test("the pointer takes the first cursor syntax the engine supports", () => {
  assert.equal(cursorValue("a", "b", () => true), 'image-set(url("a") 1x, url("b") 2x) 0 0, auto');
  assert.equal(cursorValue("a", "b", (v) => v.startsWith("-webkit")), '-webkit-image-set(url("a") 1x, url("b") 2x) 0 0, auto');
  assert.equal(cursorValue("a", "b", (v) => v.startsWith("url")), 'url("a") 0 0, auto');
  assert.equal(cursorValue("a", "b", () => false), null);
});
