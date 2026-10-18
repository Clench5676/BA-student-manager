// Tests for web/js/portrait-view.js (the detail screen's portrait framing), run by tests/test_portrait_view.py with
// Node's test runner: node --test tests/js/portrait_view.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHARACTER_POS, SKELETON_SCALE, portraitViewport, stagePoint,
} from "../../src/ba_modding_toolkit/web/js/portrait-view.js";

const S = 1920 / 2960;          // stage px per prefab unit (util.js)
const ORIGIN = [960, 515];      // the detail screen's prefab centre on the stage (detail.js)
const STAGE = { left: 0, top: 0, width: 1920, height: 1080 };
const NODE = { name: "CharacterPos", pos: [-738, -746], scale: [101, 101] };
const K = 101 * SKELETON_SCALE * S; // stage px per skeleton unit
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearPt = (p, q, eps = 1e-6) => { near(p[0], q[0], eps); near(p[1], q[1], eps); };

test("the skeleton's origin lands on CharacterPos, a unit is the node's scale", () => {
  const view = portraitViewport(NODE, { origin: ORIGIN, s: S, box: STAGE });
  const at = [ORIGIN[0] - 738 * S, ORIGIN[1] + 746 * S];
  nearPt(stagePoint(view, STAGE, 0, 0), at);
  nearPt(stagePoint(view, STAGE, 100, 1000), [at[0] + 100 * K, at[1] - 1000 * K]);
  near(view.width / view.height, STAGE.width / STAGE.height);
  assert.deepEqual([view.padLeft, view.padRight, view.padTop, view.padBottom, view.transitionTime], [0, 0, 0, 0, 0]);
});

test("one scale across and down, at any device pixel ratio and box", () => {
  // the stage, the box before the change, the 3D model's box
  const before = { left: 20, top: 40, width: 960, height: 1560 };
  const model = { left: 0, top: 0, width: 1000, height: 1080 };
  const boxes = [STAGE, before, model];
  const ref = stagePoint(portraitViewport(NODE, { origin: ORIGIN, s: S, box: STAGE }), STAGE, 0, 0);
  for (const box of boxes) {
    const view = portraitViewport(NODE, { origin: ORIGIN, s: S, box });
    for (const dpr of [1, 1.25, 2, 3]) {
      const o = stagePoint(view, box, 0, 0, dpr);
      nearPt(o, ref, 1e-3); // the same place whatever the box
      const right = stagePoint(view, box, 1000, 0, dpr), up = stagePoint(view, box, 0, 1000, dpr);
      near(right[0] - o[0], 1000 * K, 1e-3);
      near(o[1] - up[1], 1000 * K, 1e-3);
      near(right[1], o[1], 1e-6);
    }
  }
});

test("the framing ignores the skeleton's bounds", () => {
  // nothing but the node and the box goes in: a skeleton with a long weapon is framed like any other
  const a = portraitViewport(NODE, { origin: ORIGIN, s: S, box: STAGE });
  const b = portraitViewport({ ...NODE, children: [{ name: "x" }] }, { origin: ORIGIN, s: S, box: STAGE });
  assert.deepEqual(a, b);
});

test("a layout without CharacterPos falls back to the prefab's values; another node is followed", () => {
  const fallback = portraitViewport(null, { origin: ORIGIN, s: S, box: STAGE });
  assert.deepEqual(fallback, portraitViewport(CHARACTER_POS, { origin: ORIGIN, s: S, box: STAGE }));
  const noScale = { pos: [-738, -746], scale: [0, 0] };
  assert.deepEqual(portraitViewport(noScale, { origin: ORIGIN, s: S, box: STAGE }), fallback);
  const moved = portraitViewport({ pos: [0, 0], scale: [202, 202] }, { origin: ORIGIN, s: S, box: STAGE });
  nearPt(stagePoint(moved, STAGE, 0, 0), ORIGIN);
  nearPt(stagePoint(moved, STAGE, 100, 0), [ORIGIN[0] + 200 * K, ORIGIN[1]]);
});
