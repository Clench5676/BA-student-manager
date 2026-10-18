// Tests for the thumbnail framing in web/js/thumbs.js (faces, busts and cards rendered from the portrait skeletons),
// run by tests/test_thumbs_frame.py with Node's test runner: node --test tests/js/thumbs_frame.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { FACE_W, NOT_FACE, isFacePart, thumbFrame } from "../../src/ba_modding_toolkit/web/js/thumbs.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const box = (x0, x1, y0, y1) => ({ x0, x1, y0, y1 });

test("face parts: expression overlays and eyes, never halos", () => {
  for (const [slot, att] of [["00_defalt", "00_defalt"], ["default", "00_default"], ["eyeclose", "eyeclose"],
    ["01_Normal", "default"], ["face", "face"]]) assert.ok(isFacePart(slot, att), slot);
  // Hina's halo slots are named like expression overlays
  for (const [slot, att] of [["01_halo", "01_halo"], ["02_halo", "02_halo"], ["halo", "halo"], ["hina2", "hina_1"]]) {
    assert.ok(!isFacePart(slot, att), slot);
  }
});

test("a long weapon or wide wings never shrink the thumbnail", () => {
  // Hina: a 194-unit face in 3616-unit bounds (her gun and wings)
  const face = box(-93, 101, 857, 1004);
  const narrow = { x: -560, y: -900, w: 1100, h: 2300 }, wide = { x: -1674, y: -923, w: 3616, h: 2439 };
  for (const [frame, k] of [["bust", 3.8], ["roster", 3.8], ["card", 3.4], ["face", 3.3]]) {
    const a = thumbFrame(face, narrow, frame, 1), b = thumbFrame(face, wide, frame, 1);
    assert.deepEqual(a, b, frame);
    near(a.width, 194 * k);
    near(a.x + a.width / 2, 4); // centred on the face
  }
});

test("the face width is held within what faces measure", () => {
  const bounds = { x: -600, y: -1000, w: 1200, h: 2500 };
  near(thumbFrame(box(-20, 25, 1000, 1030), bounds, "bust", 1).width, FACE_W[0] * 3.8); // eyes alone
  near(thumbFrame(box(-110, 110, 900, 1100), bounds, "bust", 1).width, 220 * 3.8);
  near(thumbFrame(box(-100, 290, 900, 1300), bounds, "bust", 1).width, 390 * 3.8);     // a face under a mask
  near(thumbFrame(box(-250, 250, 900, 1300), bounds, "bust", 1).width, FACE_W[1] * 3.8);
  // a body part named like a face (np0013's "Face_01"): the bounds stand in
  const body = thumbFrame(box(-624, 642, -1134, 1348), bounds, "bust", 1);
  assert.ok(NOT_FACE < 1266);
  assert.deepEqual(body, thumbFrame(null, bounds, "bust", 1));
});

test("without a face the bounds stand in, and the height follows the aspect", () => {
  const bounds = { x: -500, y: -800, w: 1000, h: 2000 };
  const r = thumbFrame(null, bounds, "bust", 480 / 480);
  near(r.width, 1000 * 0.17 * 3.8);
  near(r.x + r.width / 2, 0);
  const f = thumbFrame(box(-100, 100, 900, 1100), bounds, "face", 320 / 277);
  near(f.height, f.width / (320 / 277));
});
