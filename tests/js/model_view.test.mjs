// Tests for web/js/model.js's camera (the 3D tab opens at the formation screen's view of one character). Run by
// tests/test_chibi_materials.py with Node's test runner; "three" and "three/addons/" resolve to the bundled copy.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

const VENDOR = new URL("../../src/ba_modding_toolkit/web/vendor/three-0.160.0/", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec === "three") return { url: ${JSON.stringify(VENDOR + "build/three.module.min.js")}, shortCircuit: true };
  if (spec.startsWith("three/addons/")) return { url: ${JSON.stringify(VENDOR + "examples/jsm/")} + spec.slice(13), shortCircuit: true };
  return next(spec, ctx); }`)}`);
const { FORMATION_VIEW, bustDistance, carryZoom, frameDistance } = await import("../../src/ba_modding_toolkit/web/js/model.js");

const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const TAN5 = Math.tan((5 * Math.PI) / 180);

test("the formation screen's camera, in the character's units", () => {
  // UIFormation: slot 630 NGUI units to the character's unit, 316.4 toward the camera, 222.6 + 56.25 below the
  // screen's centre; NGUI root 11.43 ahead at 2 / 1665 of a unit per NGUI unit; vertical field of view 10
  assert.equal(FORMATION_VIEW.fov, 10);
  near(FORMATION_VIEW.distance, 14.60164);
  near(FORMATION_VIEW.eye, 0.442619);
  // on a 1080-pixel screen the feet stand 187 px below its centre, where the screenshots show them (757 of 1125)
  const pxPerUnit = 1080 / (2 * FORMATION_VIEW.distance * TAN5);
  near(540 + FORMATION_VIEW.eye * pxPerUnit, (757 / 1125) * 1080, 1);
});

test("a chibi is framed at the formation screen's scale, a larger one from further back", () => {
  const frame = { x: 960, y: 540, w: 1920, h: 1080, floor: 1056 };
  // Koharu's box with its halo, around the orbit target (0.44 above the feet)
  const chibi = { min: { x: -0.5, y: -0.4426 }, max: { x: 0.45, y: 0.68 } };
  assert.equal(frameDistance(chibi, frame), FORMATION_VIEW.distance);
  // a box 3 units above the target: its top must stay 24 px below the host's top edge
  const tall = { min: { x: -0.5, y: -0.4426 }, max: { x: 0.5, y: 3 } };
  const d = frameDistance(tall, frame);
  near(d, (3 * 1080) / (2 * TAN5 * (540 - 24)));
  // beside the panel the feet stay above the nameplate (the frame's floor)
  const left = { x: 490, y: 500, w: 1000, h: 1080, floor: 700 };
  assert.equal(frameDistance(chibi, left), FORMATION_VIEW.distance);
  const low = { min: { x: -0.4, y: -1 }, max: { x: 0.4, y: 0.6 } };
  near(frameDistance(low, left), 1080 / (2 * TAN5 * 200));
  // and its sides inside the host's width
  const wide = { min: { x: -2, y: -0.4 }, max: { x: 0.5, y: 0.6 } };
  near(frameDistance(wide, left), (2 * 1080) / (2 * TAN5 * (490 - 24)));
});

const FULL = { x: 960, y: 540, w: 1920, h: 1080, floor: 1056 };
const LEFT = { x: 490, y: 500, w: 1000, h: 1080, floor: 700 };
// Koharu's box with its halo around the orbit target (0.44 above the feet), her face 0.34 above the target
const KOHARU = { min: { x: -0.5, y: -0.4426 }, max: { x: 0.45, y: 0.68 } };
const FACE = 0.34;
const pxPerUnit = (distance, frame) => frame.h / (2 * distance * TAN5);

test("the closest zoom is the bust, beside the panel and fullscreen", () => {
  for (const frame of [FULL, LEFT]) {
    const fit = frameDistance(KOHARU, frame);
    const bust = bustDistance(KOHARU, FACE, frame, fit);
    // the face on the frame point (the lifted target), the halo's top 24 px below the host's top edge
    near((KOHARU.max.y - FACE) * pxPerUnit(bust, frame), frame.y - 24, 1e-6);
    // the box then runs well past the host's height: head and shoulders, not the whole chibi
    assert.ok((KOHARU.max.y - KOHARU.min.y) * pxPerUnit(bust, frame) > 1.4 * frame.h);
    // 0.45 of the formation distance (the old limit) still showed her whole, shorter than the host
    assert.ok((KOHARU.max.y - KOHARU.min.y) * pxPerUnit(0.45 * fit, frame) < frame.h);
    assert.ok(bust < 0.35 * fit);
  }
  // a box whose top lies at or below the face still closes in; a very tall one does not stop further out than before
  const fit = FORMATION_VIEW.distance;
  near(bustDistance({ min: { y: -0.4 }, max: { y: 0.3 } }, FACE, FULL, fit), fit * 0.1);
  near(bustDistance({ min: { y: -0.4 }, max: { y: 5 } }, FACE, FULL, fit), fit * 0.45);
});

test("a change of framing keeps the zoom's place between the bust and the fit", () => {
  const range = (frame) => { const fit = frameDistance(KOHARU, frame); return { fit, min: bustDistance(KOHARU, FACE, frame, fit) }; };
  const left = range(LEFT), full = range(FULL);
  assert.notEqual(left.min, full.min);
  near(carryZoom(left.min, left, full), full.min); // the bust stays the bust
  near(carryZoom(left.fit, left, full), full.fit);
  near(carryZoom((left.fit + left.min) / 2, left, full), (full.fit + full.min) / 2);
  near(carryZoom(left.fit * 1.2, left, full), full.fit * 1.2); // a step back, as a multiple of the fit
  near(carryZoom(left.fit * 2, left, full), full.fit * 1.3);
  // a framing further back (a tall chibi): the same share of the way
  const far = { fit: 30, min: 6 };
  near(carryZoom(left.min, left, far), far.min);
  near(carryZoom(carryZoom(9, left, far), far, left), 9);
});
