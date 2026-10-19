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
const { FORMATION_VIEW, frameDistance } = await import("../../src/ba_modding_toolkit/web/js/model.js");

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
